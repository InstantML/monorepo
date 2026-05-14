"""SQLite persistence for the bootstrap API."""

from __future__ import annotations

import json
import math
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


RUN_STATUSES = {"running", "finished", "failed"}


class StorageError(Exception):
    """Base storage error."""


class ValidationError(StorageError):
    """Raised when caller-provided data is invalid."""


class NotFoundError(StorageError):
    """Raised when a requested row does not exist."""


@dataclass(frozen=True)
class MetricPoint:
    key: str
    step: float
    value: float
    created_at: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def default_db_path() -> Path:
    return Path(".rlobs") / "rlobs.sqlite3"


def connect(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def initialize(db_path: str | Path) -> None:
    with connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              description TEXT,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed')),
              config_json TEXT NOT NULL,
              tags_json TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              started_at TEXT NOT NULL,
              finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS metrics (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              key TEXT NOT NULL,
              step REAL NOT NULL CHECK (step >= 0),
              value REAL NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_runs_project_created
              ON runs(project_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_metrics_run_key_step
              ON metrics(run_id, key, step);
            """
        )


def create_project(db_path: str | Path, name: str, description: str | None = None) -> dict[str, Any]:
    name = _validate_name(name, "project name")
    if description is not None and not isinstance(description, str):
        raise ValidationError("description must be a string")
    initialize(db_path)
    with connect(db_path) as conn:
        existing = conn.execute("SELECT * FROM projects WHERE name = ?", (name,)).fetchone()
        if existing:
            return _project_from_row(existing)
        project = {
            "id": str(uuid.uuid4()),
            "name": name,
            "description": description,
            "created_at": utc_now(),
        }
        conn.execute(
            "INSERT INTO projects (id, name, description, created_at) VALUES (?, ?, ?, ?)",
            (project["id"], project["name"], project["description"], project["created_at"]),
        )
        return project


def list_projects(db_path: str | Path) -> list[dict[str, Any]]:
    initialize(db_path)
    with connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY name ASC").fetchall()
        return [_project_from_row(row) for row in rows]


def create_run(
    db_path: str | Path,
    project: str,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    project_row = create_project(db_path, project)
    run_name = _validate_name(name or f"{project}-run", "run name")
    config = _validate_dict({} if config is None else config, "config")
    metadata = _validate_dict({} if metadata is None else metadata, "metadata")
    tags = _validate_tags([] if tags is None else tags)
    now = utc_now()
    run_id = str(uuid.uuid4())
    initialize(db_path)
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO runs (
              id, project_id, name, status, config_json, tags_json, metadata_json,
              created_at, started_at, finished_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                project_row["id"],
                run_name,
                "running",
                _to_json(config),
                _to_json(tags),
                _to_json(metadata),
                now,
                now,
                None,
            ),
        )
    return get_run(db_path, run_id)


def get_run(db_path: str | Path, run_id: str) -> dict[str, Any]:
    initialize(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT runs.*, projects.name AS project
            FROM runs
            JOIN projects ON projects.id = runs.project_id
            WHERE runs.id = ?
            """,
            (run_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("run not found")
    return _run_from_row(row)


def list_runs(
    db_path: str | Path,
    project_id: str | None = None,
    project: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    limit = _validate_limit(limit, default=100, maximum=500)
    offset = _validate_offset(offset)
    initialize(db_path)
    query = """
        SELECT runs.*, projects.name AS project
        FROM runs
        JOIN projects ON projects.id = runs.project_id
    """
    clauses: list[str] = []
    params: list[Any] = []
    if project_id:
        clauses.append("runs.project_id = ?")
        params.append(project_id)
    if project:
        clauses.append("projects.name = ?")
        params.append(project)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY runs.created_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    with connect(db_path) as conn:
        rows = conn.execute(query, params).fetchall()
        return [_run_from_row(row) for row in rows]


def update_run_status(db_path: str | Path, run_id: str, status: str) -> dict[str, Any]:
    if status not in RUN_STATUSES:
        raise ValidationError("status must be one of: failed, finished, running")
    finished_at = utc_now() if status in {"finished", "failed"} else None
    initialize(db_path)
    with connect(db_path) as conn:
        cursor = conn.execute(
            "UPDATE runs SET status = ?, finished_at = ? WHERE id = ?",
            (status, finished_at, run_id),
        )
        if cursor.rowcount == 0:
            raise NotFoundError("run not found")
    return get_run(db_path, run_id)


def log_metrics(
    db_path: str | Path,
    run_id: str,
    metrics: dict[str, Any],
    step: int | float,
    timestamp: str | None = None,
) -> int:
    step = _validate_step(step)
    metrics = _validate_metrics(metrics)
    initialize(db_path)
    now = _validate_timestamp(timestamp) if timestamp is not None else utc_now()
    with connect(db_path) as conn:
        exists = conn.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,)).fetchone()
        if exists is None:
            raise NotFoundError("run not found")
        conn.executemany(
            "INSERT INTO metrics (run_id, key, step, value, created_at) VALUES (?, ?, ?, ?, ?)",
            [(run_id, key, step, value, now) for key, value in metrics.items()],
        )
    return len(metrics)


def get_metrics(
    db_path: str | Path,
    run_id: str,
    key: str | None = None,
    start_step: int | float | None = None,
    end_step: int | float | None = None,
    limit: int = 1000,
) -> list[MetricPoint]:
    limit = _validate_limit(limit, default=1000, maximum=5000)
    start_step = _validate_optional_step(start_step, "start_step")
    end_step = _validate_optional_step(end_step, "end_step")
    if start_step is not None and end_step is not None and start_step > end_step:
        raise ValidationError("start_step must be less than or equal to end_step")
    initialize(db_path)
    query = "SELECT key, step, value, created_at FROM metrics WHERE run_id = ?"
    params: list[Any] = [run_id]
    if key is not None:
        key = _validate_name(key, "metric key")
        query += " AND key = ?"
        params.append(key)
    if start_step is not None:
        query += " AND step >= ?"
        params.append(start_step)
    if end_step is not None:
        query += " AND step <= ?"
        params.append(end_step)
    query += " ORDER BY step ASC, id ASC LIMIT ?"
    params.append(limit)
    with connect(db_path) as conn:
        exists = conn.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,)).fetchone()
        if exists is None:
            raise NotFoundError("run not found")
        rows = conn.execute(query, params).fetchall()
    return [MetricPoint(row["key"], row["step"], row["value"], row["created_at"]) for row in rows]


def _project_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "created_at": row["created_at"],
    }


def _run_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "project": row["project"],
        "name": row["name"],
        "status": row["status"],
        "config": json.loads(row["config_json"]),
        "tags": json.loads(row["tags_json"]),
        "metadata": json.loads(row["metadata_json"]),
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


def _to_json(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    except TypeError as exc:
        raise ValidationError("value must be JSON serializable") from exc


def _validate_name(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field} must be a non-empty string")
    return value.strip()


def _validate_dict(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{field} must be an object")
    _to_json(value)
    return value


def _validate_tags(value: Any) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(tag, str) or not tag.strip() for tag in value):
        raise ValidationError("tags must be a list of non-empty strings")
    return [tag.strip() for tag in value]


def _validate_step(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError("step must be a nonnegative number")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValidationError("step must be a nonnegative number")
    return number


def _validate_optional_step(value: Any, field: str) -> float | None:
    if value is None or value == "":
        return None
    try:
        if isinstance(value, bool):
            raise TypeError
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{field} must be a nonnegative number") from exc
    if not math.isfinite(number) or number < 0:
        raise ValidationError(f"{field} must be a nonnegative number")
    return number


def _validate_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError("timestamp must be an ISO-compatible datetime")
    text = value.strip()
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValidationError("timestamp must be an ISO-compatible datetime") from exc
    return text


def _validate_limit(value: Any, default: int, maximum: int) -> int:
    if value is None:
        return default
    try:
        limit = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError("limit must be a positive integer") from exc
    if limit < 1 or limit > maximum:
        raise ValidationError(f"limit must be between 1 and {maximum}")
    return limit


def _validate_offset(value: Any) -> int:
    try:
        offset = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError("offset must be a nonnegative integer") from exc
    if offset < 0:
        raise ValidationError("offset must be a nonnegative integer")
    return offset


def _validate_metrics(value: Any) -> dict[str, float]:
    if not isinstance(value, dict) or not value:
        raise ValidationError("metrics must be a non-empty object")
    validated: dict[str, float] = {}
    for key, metric_value in value.items():
        clean_key = _validate_name(key, "metric key")
        if isinstance(metric_value, bool) or not isinstance(metric_value, (int, float)):
            raise ValidationError("metric values must be finite numbers")
        metric_float = float(metric_value)
        if not math.isfinite(metric_float):
            raise ValidationError("metric values must be finite numbers")
        validated[clean_key] = metric_float
    return validated
