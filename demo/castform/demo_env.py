"""Local environment loading for Castform demo operator scripts."""

from __future__ import annotations

import os
from pathlib import Path


HERE = Path(__file__).resolve().parent
DEFAULT_ENV_PATH = HERE / ".env"


def _decode_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_demo_env(path: Path = DEFAULT_ENV_PATH) -> bool:
    """Load KEY=value lines from the ignored local demo .env if it exists.

    Existing process environment values are preserved so callers can override
    the local file for one-off rehearsals.
    """
    if not path.exists():
        return False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        os.environ.setdefault(key, _decode_value(raw_value))
    return True
