"""Git, environment, and source metadata capture."""

from __future__ import annotations

import os
import platform
import socket
import subprocess
import sys
from typing import Any


def _environment_metadata() -> dict[str, Any]:
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "hostname": socket.gethostname(),
        "pid": os.getpid(),
    }


def _source_metadata() -> dict[str, Any]:
    return {
        "argv": sys.argv,
        "cwd": os.getcwd(),
        "git": _git_metadata(),
    }


def _git_metadata() -> dict[str, Any]:
    def git(*args: str) -> str | None:
        try:
            return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL, text=True, timeout=0.5).strip()
        except (subprocess.SubprocessError, OSError):
            return None

    root = git("rev-parse", "--show-toplevel")
    if root is None:
        return {"available": False}
    return {
        "available": True,
        "root": root,
        "commit": git("rev-parse", "HEAD"),
        "branch": git("branch", "--show-current"),
        "dirty": bool(git("status", "--porcelain")),
    }
