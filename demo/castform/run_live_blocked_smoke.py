#!/usr/bin/env python3
"""Regenerate and browser-test the current live blocked-embed demo page."""

from __future__ import annotations

import argparse
import json
import os
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

from run_demo import DEFAULT_API_BASE_URL, DEFAULT_INSTANTML_WEB_BASE_URL, DEFAULT_PROJECT


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEFAULT_REPORT = HERE / "run-output" / "live-blocked-smoke-report.json"
DEFAULT_SUMMARY = HERE / "run-output" / "live-blocked-smoke-summary.json"
DEFAULT_PRODUCTION_RUN_IDS = [
    "a0c53fce-5351-476b-bd63-537c6ce442be",
    "01fff006-b7e6-4329-9d6d-c32b44eb4d3c",
    "b9a7b17a-8e37-4bec-9ae2-9ea4a9bba429",
    "a51f74e9-1077-4587-87ad-9d678002aa49",
    "1ddca3ef-fd24-4032-a95b-1d77f1c4b8aa",
]
TOKEN_RE = re.compile(r"instantml_(?:embed_)?(?!redacted\b)[A-Za-z0-9_-]{20,}")


class LiveBlockedSmokeError(RuntimeError):
    pass


class CommandFailure(LiveBlockedSmokeError):
    def __init__(self, message: str, result: dict[str, Any]) -> None:
        super().__init__(message)
        self.result = result


def redact(value: str) -> str:
    return TOKEN_RE.sub("instantml_redacted", value)


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
    raise LiveBlockedSmokeError(f"parent page did not become reachable at {url}: {last_error}")


def run_command(argv: list[str], *, env: dict[str, str] | None = None, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            argv,
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        result = {
            "command": argv,
            "exit_code": None,
            "timed_out": True,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "stdout": redact(exc.stdout or ""),
            "stderr": redact(exc.stderr or ""),
        }
        raise CommandFailure(f"{' '.join(argv)} timed out after {timeout:.1f} seconds", result) from exc
    result = {
        "command": argv,
        "exit_code": completed.returncode,
        "timed_out": False,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "stdout": redact(completed.stdout),
        "stderr": redact(completed.stderr),
    }
    if completed.returncode != 0:
        raise CommandFailure(f"{' '.join(argv)} failed with exit code {completed.returncode}: {result['stderr']}", result)
    return result


def record_command(
    report: dict[str, Any],
    argv: list[str],
    *,
    env: dict[str, str] | None = None,
    timeout: float,
) -> None:
    try:
        report["commands"].append(run_command(argv, env=env, timeout=timeout))
    except CommandFailure as exc:
        report["commands"].append(exc.result)
        raise


def start_server(host: str, port: int) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "demo/castform/serve_web.py", "--host", host, "--port", str(port)],
        cwd=REPO_ROOT,
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


def read_manifest_summary(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise LiveBlockedSmokeError(f"missing generated manifest: {path}") from exc
    if not isinstance(manifest, dict):
        raise LiveBlockedSmokeError("generated manifest must be a JSON object")
    runs = manifest.get("runs") if isinstance(manifest.get("runs"), list) else []
    sessions = manifest.get("embed_sessions") if isinstance(manifest.get("embed_sessions"), list) else []
    embed_status = manifest.get("embed_status") if isinstance(manifest.get("embed_status"), dict) else {}
    return {
        "project": manifest.get("project"),
        "runs": len(runs),
        "embed_sessions": len(sessions),
        "embed_status": embed_status.get("status"),
        "parent_origin": manifest.get("parent_origin"),
    }


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Regenerate and verify the live persisted-data blocked-embed page")
    parser.add_argument("--api-base-url", default=os.environ.get("INSTANTML_API_BASE_URL", DEFAULT_API_BASE_URL))
    parser.add_argument("--instantml-web-base-url", default=os.environ.get("INSTANTML_WEB_BASE_URL", DEFAULT_INSTANTML_WEB_BASE_URL))
    parser.add_argument("--project", default=os.environ.get("CASTFORM_DEMO_PROJECT", DEFAULT_PROJECT))
    parser.add_argument("--parent-origin", default="https://castform-demo.local.invalid")
    parser.add_argument("--run-id", action="append", default=[], help="Existing InstantML run ID. Defaults to the current live demo run IDs.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--desktop-viewport", default="1366x900")
    parser.add_argument("--mobile-viewport", default="390x844")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_ids = args.run_id or DEFAULT_PRODUCTION_RUN_IDS
    port = choose_port(args.host, args.port)
    parent_url = f"http://{args.host}:{port}"
    report: dict[str, Any] = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "api_base_url": args.api_base_url,
        "instantml_web_base_url": args.instantml_web_base_url,
        "project": args.project,
        "parent_origin": args.parent_origin,
        "parent_url": parent_url,
        "run_ids": run_ids,
        "commands": [],
    }
    server: subprocess.Popen[str] | None = None
    try:
        if not os.environ.get("INSTANTML_API_KEY"):
            raise LiveBlockedSmokeError("INSTANTML_API_KEY is required to read existing production runs")
        if args.port != 0 and port_is_open(args.host, port):
            raise LiveBlockedSmokeError(f"{args.host}:{port} is already in use; pass --port 0 to choose a free port")

        env = {
            **os.environ,
            "PYTHONPATH": str(REPO_ROOT / "packages" / "python-sdk"),
        }
        writer_command = [
            sys.executable,
            "demo/castform/run_demo.py",
            "--api-base-url",
            args.api_base_url,
            "--instantml-web-base-url",
            args.instantml_web_base_url,
            "--parent-origin",
            args.parent_origin,
            "--project",
            args.project,
            "--summary",
            str(args.summary),
            "--allow-embed-blocked",
            "--timeout",
            str(args.timeout),
        ]
        for run_id in run_ids:
            writer_command.extend(["--instantml-run-id", run_id])
        record_command(report, writer_command, env=env, timeout=max(args.timeout + 15.0, args.timeout * 2.0))

        manifest_path = HERE / "web" / "public" / "demo-manifest.json"
        report["manifest"] = read_manifest_summary(manifest_path)
        if report["manifest"]["runs"] != len(run_ids):
            raise LiveBlockedSmokeError(f"expected {len(run_ids)} run cards, got {report['manifest']['runs']}")
        if report["manifest"]["embed_sessions"] != 0 or report["manifest"]["embed_status"] != "blocked":
            raise LiveBlockedSmokeError("expected a blocked hosted-embed manifest with zero sessions")

        server = start_server(args.host, port)
        wait_for_parent_page(parent_url, timeout=args.timeout)
        record_command(
            report,
            [
                sys.executable,
                "demo/castform/verify_demo.py",
                "--parent-url",
                parent_url,
                "--summary",
                str(args.summary),
                "--allow-blocked-embeds",
            ],
            timeout=args.timeout,
        )
        for viewport in (args.desktop_viewport, args.mobile_viewport):
            record_command(
                report,
                [
                    "node",
                    "demo/castform/browser_verify.mjs",
                    "--url",
                    parent_url,
                    "--expect-runs",
                    str(len(run_ids)),
                    "--expect-sessions",
                    "0",
                    "--allow-blocked-embeds",
                    "--viewport",
                    viewport,
                    "--timeout-ms",
                    str(round(args.timeout * 1000)),
                ],
                timeout=max(args.timeout + 15.0, args.timeout * 2.0),
            )
        report["ok"] = True
        print(f"live blocked smoke passed: {parent_url}")
        return_code = 0
    except Exception as exc:  # noqa: BLE001
        report["error"] = redact(str(exc))
        print(f"live blocked smoke failed: {report['error']}", file=sys.stderr)
        return_code = 1
    finally:
        if server is not None:
            report["server"] = stop_server(server)
        write_report(args.report, report)
        print(f"wrote live blocked smoke report: {args.report}")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
