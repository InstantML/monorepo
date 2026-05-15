"""Development JSON API server for the bootstrap backend."""

from __future__ import annotations

import argparse
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import db

MAX_BODY_BYTES = 1_000_000


class ApiError(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        self.status = status
        self.message = message


class InstantMLHandler(BaseHTTPRequestHandler):
    db_path: Path

    server_version = "InstantMLDevAPI/0.1"

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def do_PATCH(self) -> None:
        self._handle("PATCH")

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _handle(self, method: str) -> None:
        try:
            payload = self._dispatch(method)
            self._write_json(HTTPStatus.OK, payload)
        except db.ValidationError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except db.NotFoundError as exc:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
        except ApiError as exc:
            self._write_json(exc.status, {"error": exc.message})
        except Exception:
            self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal server error"})

    def _dispatch(self, method: str) -> dict[str, Any]:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        parts = [part for part in path.split("/") if part]

        if method == "GET" and path == "/health":
            return {"status": "ok"}
        if method == "POST" and path == "/projects":
            body = self._read_json()
            project = db.create_project(self.db_path, body.get("name"), body.get("description"))
            return {"project": project}
        if method == "GET" and path == "/projects":
            return {"projects": db.list_projects(self.db_path)}
        if method == "POST" and path == "/runs":
            body = self._read_json()
            run = db.create_run(
                self.db_path,
                project=body.get("project"),
                name=body.get("name"),
                config=body.get("config", {}),
                tags=body.get("tags", []),
                metadata=body.get("metadata", {}),
            )
            return {"run": run}
        if method == "GET" and path == "/runs":
            limit = _query_one(query, "limit", 100)
            offset = _query_one(query, "offset", 0)
            project_id = _query_one(query, "project_id", None)
            project = _query_one(query, "project", None)
            return {
                "runs": db.list_runs(self.db_path, project_id=project_id, project=project, limit=limit, offset=offset),
                "limit": int(limit),
                "offset": int(offset),
            }
        if len(parts) == 2 and parts[0] == "runs" and method == "GET":
            return {"run": db.get_run(self.db_path, parts[1])}
        if len(parts) == 2 and parts[0] == "runs" and method == "PATCH":
            body = self._read_json()
            return {"run": db.update_run_status(self.db_path, parts[1], body.get("status"))}
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "metrics" and method == "POST":
            body = self._read_json()
            inserted = db.log_metrics(self.db_path, parts[1], body.get("metrics"), body.get("step"), body.get("timestamp"))
            return {"inserted": inserted}
        if len(parts) == 3 and parts[0] == "runs" and parts[2] == "metrics" and method == "GET":
            limit = _query_one(query, "limit", 1000)
            metrics = db.get_metrics(
                self.db_path,
                parts[1],
                key=_query_one(query, "key", None),
                start_step=_query_one(query, "start_step", None),
                end_step=_query_one(query, "end_step", None),
                limit=limit,
            )
            return {
                "metrics": [point.__dict__ for point in metrics],
                "limit": int(limit),
            }
        raise ApiError(HTTPStatus.NOT_FOUND, "route not found")

    def _read_json(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            raise ApiError(HTTPStatus.BAD_REQUEST, "content-type must be application/json")
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid content-length") from exc
        if content_length > MAX_BODY_BYTES:
            self.rfile.read(content_length)
            raise ApiError(HTTPStatus.BAD_REQUEST, "request body is too large")
        raw = self.rfile.read(content_length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "request body must be a JSON object")
        return body

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def create_server(db_path: str | Path, host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    db.initialize(db_path)

    class Handler(InstantMLHandler):
        pass

    Handler.db_path = Path(db_path)
    return ThreadingHTTPServer((host, port), Handler)


def run_server(db_path: str | Path, host: str = "127.0.0.1", port: int = 8000) -> None:
    server = create_server(db_path, host, port)
    try:
        print(f"Training Observability API listening on http://{host}:{server.server_port}")
        server.serve_forever()
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Training Observability development API")
    parser.add_argument("--db", default=str(db.default_db_path()), help="SQLite database path")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind")
    parser.add_argument("--port", default=8000, type=int, help="Port to bind")
    args = parser.parse_args()
    run_server(args.db, args.host, args.port)


def _query_one(query: dict[str, list[str]], key: str, default: Any) -> Any:
    values = query.get(key)
    if not values:
        return default
    return values[0]


if __name__ == "__main__":  # pragma: no cover
    main()
