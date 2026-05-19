"""HTTP transport helpers: offline spool and error parsing."""

from __future__ import annotations

import json
import urllib.error
from pathlib import Path
from typing import Any


def _offline_path(offline_dir: str, run_id: str) -> Path:
    return Path(offline_dir).expanduser().resolve() / f"{run_id}.jsonl"


def _spool_event(offline_dir: str, run_id: str, event: dict[str, Any]) -> None:
    path = _offline_path(offline_dir, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")


def _error_message(exc: urllib.error.HTTPError) -> str:
    try:
        payload = exc.read().decode("utf-8")
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return str(exc)
    if isinstance(decoded, dict) and isinstance(decoded.get("error"), str):
        return decoded["error"]
    return str(exc)
