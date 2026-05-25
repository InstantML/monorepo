"""Git, environment, and source metadata capture."""

from __future__ import annotations

import hashlib
import math
import os
import platform
import selectors
import socket
import subprocess
import sys
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_SAFE_DIFF_ARGS = ("--no-ext-diff", "--no-color", "--no-textconv")
_DIFF_STAT_BYTES = 16 * 1024


@dataclass(frozen=True)
class SourceTracking:
    """Configurable, privacy-conscious source metadata capture."""

    command: bool = False
    paths: bool = False
    branch: bool = False
    hostname: bool = False
    pid: bool = False
    git_diff: bool = False
    git_timeout: float = 0.5
    diff_bytes: int = 256 * 1024

    @classmethod
    def privacy_safe(cls) -> "SourceTracking":
        return cls()

    def __post_init__(self) -> None:
        for field_name in ("command", "paths", "branch", "hostname", "pid", "git_diff"):
            if not isinstance(getattr(self, field_name), bool):
                raise TypeError(f"{field_name} must be a bool")
        if isinstance(self.git_timeout, bool) or not isinstance(self.git_timeout, (int, float)):
            raise TypeError("git_timeout must be a finite non-negative number")
        if not math.isfinite(float(self.git_timeout)) or self.git_timeout < 0:
            raise ValueError("git_timeout must be a finite non-negative number")
        if isinstance(self.diff_bytes, bool) or not isinstance(self.diff_bytes, int):
            raise TypeError("diff_bytes must be a non-negative integer")
        if self.diff_bytes < 0:
            raise ValueError("diff_bytes must be a non-negative integer")


def _normalize_source_tracking(value: bool | SourceTracking) -> SourceTracking | None:
    if isinstance(value, SourceTracking):
        return value
    if value is True:
        return SourceTracking.privacy_safe()
    if value is False:
        return None
    raise TypeError("source_tracking must be a bool or SourceTracking")


def _capture_settings(settings: SourceTracking) -> dict[str, Any]:
    return {
        "command": settings.command,
        "paths": settings.paths,
        "branch": settings.branch,
        "hostname": settings.hostname,
        "pid": settings.pid,
        "git_diff": settings.git_diff,
    }


def _environment_metadata(settings: SourceTracking | None = None) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "python": platform.python_version(),
        "platform": platform.platform(),
    }
    if settings is not None and settings.hostname:
        metadata["hostname"] = socket.gethostname()
    if settings is not None and settings.pid:
        metadata["pid"] = os.getpid()
    return metadata


def _source_metadata(settings: SourceTracking | None = None) -> dict[str, Any]:
    settings = settings or SourceTracking.privacy_safe()
    metadata: dict[str, Any] = {
        "capture": _capture_settings(settings),
        "git": _git_metadata(settings),
    }
    entrypoint = _entrypoint_name()
    if entrypoint:
        metadata["entrypoint"] = entrypoint
    if settings.command:
        metadata["argv"] = list(sys.argv)
    if settings.paths:
        metadata["cwd"] = os.getcwd()
    return metadata


def _entrypoint_name() -> str | None:
    if not sys.argv:
        return None
    raw = sys.argv[0]
    if not raw:
        return None
    return Path(raw).name or raw


def _git_metadata(settings: SourceTracking | None = None) -> dict[str, Any]:
    settings = settings or SourceTracking.privacy_safe()
    root = _git_text(("rev-parse", "--show-toplevel"), settings.git_timeout)
    if root is None:
        return {"available": False}
    dirty_status = _git_text(("status", "--porcelain"), settings.git_timeout)
    metadata: dict[str, Any] = {
        "available": True,
        "commit": _git_text(("rev-parse", "HEAD"), settings.git_timeout),
        "dirty": None if dirty_status is None else bool(dirty_status),
    }
    if dirty_status is None:
        metadata["dirty_unknown"] = True
    if settings.paths:
        metadata["root"] = root
    if settings.branch:
        metadata["branch"] = _git_text(("branch", "--show-current"), settings.git_timeout)
    if settings.git_diff:
        metadata["diff"] = _git_diff_metadata(settings)
    return metadata


def _git_text(args: tuple[str, ...], timeout: float) -> str | None:
    try:
        return subprocess.check_output(
            ["git", *args],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
        ).strip()
    except (subprocess.SubprocessError, OSError):
        return None


def _git_diff_metadata(settings: SourceTracking) -> dict[str, Any]:
    stat_budget = min(settings.diff_bytes, _DIFF_STAT_BYTES)
    stat, stat_truncated = _git_bounded_text(
        ("diff", *_SAFE_DIFF_ARGS, "--stat"),
        settings.git_timeout,
        stat_budget,
    )
    cached_stat, cached_stat_truncated = _git_bounded_text(
        ("diff", "--cached", *_SAFE_DIFF_ARGS, "--stat"),
        settings.git_timeout,
        stat_budget,
    )
    unstaged, unstaged_truncated = _git_patch_prefix(
        ("diff", *_SAFE_DIFF_ARGS),
        settings.git_timeout,
        settings.diff_bytes,
    )
    separator_budget = 1 if unstaged else 0
    remaining_budget = max(settings.diff_bytes - len(unstaged or b"") - separator_budget, 0)
    staged, staged_truncated = _git_patch_prefix(
        ("diff", "--cached", *_SAFE_DIFF_ARGS),
        settings.git_timeout,
        remaining_budget,
    )
    digest_input = b"\n".join(part for part in (unstaged, staged) if part)
    patch_truncated = unstaged_truncated or staged_truncated
    return {
        "stat": stat or "",
        "cached_stat": cached_stat or "",
        "stat_truncated": stat_truncated,
        "cached_stat_truncated": cached_stat_truncated,
        "patch_sha256": hashlib.sha256(digest_input).hexdigest() if digest_input else None,
        "patch_digest_scope": "prefix" if patch_truncated else "full",
        "bytes_hashed": len(digest_input),
        "truncated": patch_truncated or stat_truncated or cached_stat_truncated,
    }


def _git_patch_prefix(args: tuple[str, ...], timeout: float, max_bytes: int) -> tuple[bytes | None, bool]:
    return _git_output_prefix(args, timeout, max_bytes)


def _git_bounded_text(args: tuple[str, ...], timeout: float, max_bytes: int) -> tuple[str | None, bool]:
    data, truncated = _git_output_prefix(args, timeout, max_bytes)
    if data is None:
        return None, truncated
    return data.decode("utf-8", errors="replace").strip(), truncated


def _git_output_prefix(args: tuple[str, ...], timeout: float, max_bytes: int) -> tuple[bytes | None, bool]:
    if max_bytes <= 0:
        return b"", True
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    try:
        process = subprocess.Popen(
            ["git", *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if process.stdout is None:
            return None, False
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + float(timeout)
        output = bytearray()
        limit = max_bytes + 1
        while len(output) < limit:
            remaining = deadline - time.monotonic()
            if remaining < 0:
                _kill_process(process)
                return None, False
            events = selector.select(remaining)
            if not events:
                if process.poll() is not None:
                    break
                _kill_process(process)
                return None, False
            chunk = os.read(process.stdout.fileno(), min(8192, limit - len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) >= limit:
                _kill_process(process)
                return bytes(output[:max_bytes]), True
        remaining = max(deadline - time.monotonic(), 0.0)
        try:
            returncode = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            _kill_process(process)
            return None, False
        if returncode != 0:
            return None, False
        return bytes(output[:max_bytes]), len(output) > max_bytes
    except (subprocess.SubprocessError, OSError):
        return None, False
    finally:
        if selector is not None:
            with suppress(Exception):
                selector.close()
        if process is not None and process.stdout is not None:
            with suppress(OSError):
                process.stdout.close()


def _kill_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    with suppress(subprocess.SubprocessError, OSError):
        process.kill()
        process.wait(timeout=0.2)
