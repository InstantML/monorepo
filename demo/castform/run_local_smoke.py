#!/usr/bin/env python3
"""Run the full local Castform parent-page smoke in one command."""

from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "run-output" / "local-smoke-report.json"
TOKEN_RE = re.compile(r"instantml_embed_(?!redacted\b)[A-Za-z0-9_-]+")


class SmokeError(RuntimeError):
    pass


class SmokeCommandError(SmokeError):
    def __init__(self, message: str, result: dict[str, Any]) -> None:
        super().__init__(message)
        self.result = result


def redact(value: str) -> str:
    return TOKEN_RE.sub("instantml_embed_redacted", value)


def run_command(argv: list[str], *, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(
        argv,
        cwd=HERE.parents[1],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    result = {
        "command": argv,
        "exit_code": completed.returncode,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "stdout": redact(completed.stdout),
        "stderr": redact(completed.stderr),
    }
    if completed.returncode != 0:
        raise SmokeCommandError(f"{' '.join(argv)} failed with exit code {completed.returncode}", result)
    return result


def choose_port(host: str, requested_port: int) -> int:
    if requested_port != 0:
        return requested_port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def port_is_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def wait_for_parent_page(url: str, *, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url, headers={"Accept": "text/html"})
            with urllib.request.urlopen(request, timeout=1.5) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError) as exc:
            last_error = exc
        time.sleep(0.15)
    detail = f": {last_error}" if last_error else ""
    raise SmokeError(f"parent page did not become reachable at {url}{detail}")


def start_server(host: str, port: int) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, str(HERE / "serve_web.py"), "--host", host, "--port", str(port)],
        cwd=HERE.parents[1],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def stop_server(process: subprocess.Popen[str]) -> dict[str, Any]:
    stopped_by_smoke = process.poll() is None
    if stopped_by_smoke:
        process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
    else:
        stdout, stderr = process.communicate(timeout=1)
    return {
        "exit_code": process.returncode,
        "stopped_by_smoke": stopped_by_smoke,
        "stdout": redact(stdout or ""),
        "stderr": redact(stderr or ""),
    }


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local Castform demo browser smoke")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5174, help="Use 0 to choose a free local port")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--desktop-viewport", default="1366x900")
    parser.add_argument("--mobile-viewport", default="390x844")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    port = choose_port(args.host, args.port)
    parent_origin = f"http://{args.host}:{port}"
    parent_url = parent_origin
    commands: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "parent_url": parent_url,
        "commands": commands,
    }
    server: subprocess.Popen[str] | None = None
    try:
        if args.port != 0 and port_is_open(args.host, port):
            raise SmokeError(f"{args.host}:{port} is already in use; pass --port 0 to choose a free port")
        commands.append(
            run_command(
                [
                    sys.executable,
                    "demo/castform/create_smoke_manifest.py",
                    "--parent-origin",
                    parent_origin,
                ],
                timeout=args.timeout,
            )
        )
        server = start_server(args.host, port)
        wait_for_parent_page(parent_url, timeout=args.timeout)
        commands.append(
            run_command(
                [
                    sys.executable,
                    "demo/castform/verify_demo.py",
                    "--local",
                    "--parent-url",
                    parent_url,
                ],
                timeout=args.timeout,
            )
        )
        commands.append(
            run_command(
                [
                    "node",
                    "demo/castform/browser_verify.mjs",
                    "--url",
                    parent_url,
                    "--expect-runs",
                    "3",
                    "--expect-sessions",
                    "3",
                    "--viewport",
                    args.desktop_viewport,
                ],
                timeout=args.timeout,
            )
        )
        commands.append(
            run_command(
                [
                    "node",
                    "demo/castform/browser_verify.mjs",
                    "--url",
                    parent_url,
                    "--expect-runs",
                    "3",
                    "--expect-sessions",
                    "3",
                    "--viewport",
                    args.mobile_viewport,
                ],
                timeout=args.timeout,
            )
        )
        report["ok"] = True
        print(f"local smoke passed: {parent_url}")
    except SmokeCommandError as exc:
        commands.append(exc.result)
        report["error"] = redact(str(exc))
        print(f"local smoke failed: {report['error']}", file=sys.stderr)
        return_code = 1
    except (SmokeError, subprocess.TimeoutExpired) as exc:
        report["error"] = redact(str(exc))
        print(f"local smoke failed: {report['error']}", file=sys.stderr)
        return_code = 1
    else:
        return_code = 0
    finally:
        if server is not None:
            report["server"] = stop_server(server)
        write_report(args.report, report)
        print(f"wrote smoke report: {args.report}")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
