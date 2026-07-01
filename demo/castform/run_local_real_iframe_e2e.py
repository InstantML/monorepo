#!/usr/bin/env python3
"""Run a local real InstantML iframe E2E for the Castform demo."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEFAULT_REPORT = HERE / "run-output" / "local-real-iframe-e2e-report.json"
DEFAULT_SUMMARY = HERE / "run-output" / "local-real-iframe-summary.json"
DEFAULT_RESUME_SUMMARY = HERE / "run-output" / "local-real-iframe-resume-summary.json"
DEFAULT_SCREENSHOT_DIR = HERE / "run-output" / "local-real-iframe-screenshots"
TOKEN_RE = re.compile(r"instantml_(?:embed_)?(?!redacted\b)[A-Za-z0-9_-]{20,}")


class LocalRealIframeError(RuntimeError):
    pass


class CommandFailure(LocalRealIframeError):
    def __init__(self, message: str, result: dict[str, Any]) -> None:
        super().__init__(message)
        self.result = result


def redact(value: str) -> str:
    return TOKEN_RE.sub("instantml_redacted", value)


def free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def wait_for_url(url: str, *, timeout: float, expected: str | None = None) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2.0) as response:
                body = response.read(4096).decode("utf-8", errors="replace")
                if 200 <= response.status < 300 and (expected is None or expected in body):
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(0.5)
    raise LocalRealIframeError(f"{url} did not become ready: {last_error}")


def start_process(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
) -> subprocess.Popen[str]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    process._castform_log_file = log_file  # type: ignore[attr-defined]
    return process


def stop_process(process: subprocess.Popen[str] | None, *, timeout: float = 10.0) -> None:
    if process is None:
        return
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=timeout)
    log_file = getattr(process, "_castform_log_file", None)
    if log_file is not None:
        log_file.close()


def process_log_tail(path: Path, *, limit: int = 4000) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return redact(text[-limit:])


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


def run_and_record(
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


def http_json(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    *,
    headers: dict[str, str] | None = None,
    timeout: float,
) -> tuple[dict[str, Any], http.client.HTTPMessage]:
    data = json.dumps(body or {}).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
            payload = json.loads(text) if text else {}
            if not isinstance(payload, dict):
                raise LocalRealIframeError(f"{method} {url} returned non-object JSON")
            return payload, response.headers
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise LocalRealIframeError(f"{method} {url} failed with {exc.code}: {redact(detail)}") from exc


def mint_local_api_key(api_base_url: str, *, timeout: float) -> tuple[str, str]:
    unique = str(int(time.time() * 1000))
    signup, headers = http_json(
        "POST",
        api_base_url + "/api/auth/dev/google",
        {
            "email": f"castform-local-e2e+{unique}@example.com",
            "display_name": "Castform Local E2E",
            "mode": "signup",
            "account_type": "customer",
            "org_name": f"Castform Local E2E {unique}",
            "plan_tier": "free",
        },
        headers={"Origin": api_base_url},
        timeout=timeout,
    )
    cookie = (headers.get("Set-Cookie") or "").split(";", 1)[0]
    org_id = str((signup.get("organization") or {}).get("id") or "")
    if not cookie or not org_id:
        raise LocalRealIframeError("local dev signup did not return a session cookie and organization")
    created, _headers = http_json(
        "POST",
        f"{api_base_url}/api/orgs/{org_id}/api-keys",
        {
            "name": "Castform local iframe E2E key",
            "scopes": ["sdk:ingest", "artifacts:write", "export:read"],
        },
        headers={"Cookie": cookie, "Origin": api_base_url},
        timeout=timeout,
    )
    api_key = created.get("api_key")
    if not isinstance(api_key, str) or not api_key.startswith("instantml_"):
        raise LocalRealIframeError("local API key response did not include a plaintext key")
    return api_key, org_id


def local_run_total(api_base_url: str, api_key: str, project: str, *, timeout: float) -> int:
    query = urllib.parse.urlencode({"project": project, "limit": 1})
    payload, _headers = http_json(
        "GET",
        f"{api_base_url}/api/runs/summary?{query}",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=timeout,
    )
    total = payload.get("total")
    if not isinstance(total, int):
        raise LocalRealIframeError("local run summary did not return an integer total")
    return total


def manifest_summary(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    runs = manifest.get("runs") or []
    sessions = manifest.get("embed_sessions") or []
    return manifest, {
        "project": manifest.get("project"),
        "runs": len(runs),
        "embed_sessions": len(sessions),
        "parent_origin": manifest.get("parent_origin"),
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def screenshot_path(screenshot_dir: Path, viewport: str) -> Path:
    return screenshot_dir / f"local-real-iframe-{viewport}.png"


def open_presentation_url(url: str) -> dict[str, Any]:
    if sys.platform == "darwin":
        chrome_error = ""
        try:
            chrome = subprocess.run(
                ["open", "-a", "Google Chrome", url],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if chrome.returncode == 0:
                return {"ok": True, "method": "macos_google_chrome"}
            chrome_error = (chrome.stderr or chrome.stdout or "").strip()
        except (OSError, subprocess.TimeoutExpired) as exc:
            chrome_error = str(exc)
        fallback = webbrowser.open(url, new=2)
        return {
            "ok": bool(fallback),
            "method": "webbrowser_fallback",
            "chrome_error": redact(chrome_error),
        }
    return {"ok": bool(webbrowser.open(url, new=2)), "method": "webbrowser"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local Castform -> real InstantML iframe E2E")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api-port", type=int, default=0)
    parser.add_argument("--web-port", type=int, default=0)
    parser.add_argument("--parent-port", type=int, default=0)
    parser.add_argument("--project", default="castform-local-real-iframe")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--step-size", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--resume-summary", type=Path, default=DEFAULT_RESUME_SUMMARY)
    parser.add_argument("--screenshot-dir", type=Path, default=DEFAULT_SCREENSHOT_DIR)
    parser.add_argument("--skip-resume-check", action="store_true", help="Skip the existing-InstantML-run iframe resume check")
    parser.add_argument(
        "--keep-running",
        action="store_true",
        help="Keep the local API/web/parent servers alive after verification until Ctrl-C, then stop them cleanly",
    )
    parser.add_argument("--open-browser", action="store_true", help="Open the verified parent page after --keep-running verification")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.open_browser and not args.keep_running:
        raise SystemExit("--open-browser requires --keep-running so the opened page stays reachable")
    api_port = args.api_port or free_port(args.host)
    web_port = args.web_port or free_port(args.host)
    parent_port = args.parent_port or free_port(args.host)
    clickhouse_http_port = free_port(args.host)
    clickhouse_tcp_port = free_port(args.host)
    clickhouse_interserver_port = free_port(args.host)
    api_base_url = f"http://{args.host}:{api_port}"
    web_base_url = f"http://{args.host}:{web_port}"
    parent_origin = f"http://{args.host}:{parent_port}"
    state_root = HERE / "run-output" / f"local-real-iframe-state-{int(time.time())}"
    report: dict[str, Any] = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "api_base_url": api_base_url,
        "instantml_web_base_url": web_base_url,
        "parent_origin": parent_origin,
        "project": args.project,
        "commands": [],
        "processes": {},
    }
    api_process: subprocess.Popen[str] | None = None
    web_process: subprocess.Popen[str] | None = None
    parent_process: subprocess.Popen[str] | None = None
    temp_context = tempfile.TemporaryDirectory(prefix="castform-real-iframe-") if not args.keep_running else None
    state_base = Path(temp_context.name) if temp_context is not None else state_root
    try:
        api_log = state_root / "api.log"
        web_log = state_root / "web.log"
        parent_log = state_root / "parent.log"
        clickhouse_url = f"http://default:@{args.host}:{clickhouse_http_port}/instantml_castform_real"
        api_env = {
            **os.environ,
            "CLICKHOUSE_URL": clickhouse_url,
            "INSTANTML_API_PORT": str(api_port),
            "INSTANTML_BIND_ADDR": f"{args.host}:{api_port}",
            "INSTANTML_AUTH_MODE": "local",
            "INSTANTML_EMBED_ENABLED": "1",
            "INSTANTML_EMBED_FRAME_ENABLED": "1",
            "INSTANTML_EMBED_TOKEN_HMAC_SECRET": "local-castform-e2e-secret",
            "INSTANTML_DEV_CHDATA": str(state_base / "clickhouse"),
            "INSTANTML_DEV_CH_LOG_DIR": str(state_root / "clickhouse-logs"),
            "INSTANTML_DEV_CH_TCP_PORT": str(clickhouse_tcp_port),
            "INSTANTML_DEV_CH_INTERSERVER_PORT": str(clickhouse_interserver_port),
            "INSTANTML_ARTIFACT_ROOT": str(state_base / "artifacts"),
        }
        api_process = start_process(["npm", "run", "dev:api"], cwd=REPO_ROOT, env=api_env, log_path=api_log)
        wait_for_url(api_base_url + "/readyz", timeout=args.timeout, expected='"status":"ok"')

        web_env = {
            **os.environ,
            "INSTANTML_WEB_EXPLICIT_API_BASES": "1",
            "INSTANTML_API_BASE": api_base_url,
            "INSTANTML_CONTROL_API_BASE": api_base_url,
            "INSTANTML_DATA_API_BASE": api_base_url,
            "INSTANTML_API_ALLOWED_ORIGINS": api_base_url,
        }
        web_process = start_process(
            ["../../node_modules/.bin/next", "dev", "--port", str(web_port)],
            cwd=REPO_ROOT / "apps" / "web",
            env=web_env,
            log_path=web_log,
        )
        wait_for_url(web_base_url + "/embed/runs/00000000-0000-0000-0000-000000000000", timeout=args.timeout)

        parent_process = start_process(
            [sys.executable, "demo/castform/serve_web.py", "--host", args.host, "--port", str(parent_port)],
            cwd=REPO_ROOT,
            env=os.environ.copy(),
            log_path=parent_log,
        )
        wait_for_url(parent_origin, timeout=args.timeout, expected="Castform InstantML Demo")

        api_key, org_id = mint_local_api_key(api_base_url, timeout=args.timeout)
        report["org_id"] = org_id
        writer_env = {
            **os.environ,
            "INSTANTML_API_KEY": api_key,
            "PYTHONPATH": str(REPO_ROOT / "packages" / "python-sdk"),
        }
        run_and_record(
            report,
            [
                sys.executable,
                "demo/castform/run_demo.py",
                "--api-base-url",
                api_base_url,
                "--instantml-web-base-url",
                web_base_url,
                "--parent-origin",
                parent_origin,
                "--project",
                args.project,
                "--runs",
                str(args.runs),
                "--steps",
                str(args.steps),
                "--step-size",
                str(args.step_size),
                "--summary",
                str(args.summary),
            ],
            env=writer_env,
            timeout=args.timeout,
        )
        run_and_record(
            report,
            [sys.executable, "demo/castform/verify_demo.py", "--local", "--parent-url", parent_origin],
            timeout=args.timeout,
        )
        manifest_path = HERE / "web" / "public" / "demo-manifest.json"
        initial_manifest, initial_summary = manifest_summary(manifest_path)
        report["initial_manifest"] = initial_summary

        if not args.skip_resume_check:
            run_ids = [
                str(run.get("instantml_run_id"))
                for run in initial_manifest.get("runs") or []
                if isinstance(run, dict) and run.get("instantml_run_id")
            ]
            if len(run_ids) != args.runs:
                raise LocalRealIframeError(f"expected {args.runs} run IDs for resume check, found {len(run_ids)}")
            before_total = local_run_total(api_base_url, api_key, args.project, timeout=args.timeout)
            resume_command = [
                sys.executable,
                "demo/castform/run_demo.py",
                "--api-base-url",
                api_base_url,
                "--instantml-web-base-url",
                web_base_url,
                "--parent-origin",
                parent_origin,
                "--project",
                args.project,
                "--summary",
                str(args.resume_summary),
            ]
            for run_id in run_ids:
                resume_command.extend(["--instantml-run-id", run_id])
            run_and_record(report, resume_command, env=writer_env, timeout=args.timeout)
            after_total = local_run_total(api_base_url, api_key, args.project, timeout=args.timeout)
            if after_total != before_total:
                raise LocalRealIframeError(f"resume check changed run count from {before_total} to {after_total}")
            report["resume_run_total_before"] = before_total
            report["resume_run_total_after"] = after_total
            run_and_record(
                report,
                [
                    sys.executable,
                    "demo/castform/verify_demo.py",
                    "--local",
                    "--parent-url",
                    parent_origin,
                    "--summary",
                    str(args.resume_summary),
                ],
                timeout=args.timeout,
            )

        expect_sessions = 1 if args.runs == 1 else 3
        browser_process_timeout = max(args.timeout + 60.0, args.timeout * 2.0)
        args.screenshot_dir.mkdir(parents=True, exist_ok=True)
        report["screenshots"] = []
        for viewport in ("1366x900", "390x844"):
            screenshot = screenshot_path(args.screenshot_dir, viewport)
            run_and_record(
                report,
                [
                    "node",
                    "demo/castform/browser_verify.mjs",
                    "--url",
                    parent_origin,
                    "--expect-runs",
                    str(args.runs),
                    "--expect-sessions",
                    str(expect_sessions),
                    "--require-iframe-content",
                    "--viewport",
                    viewport,
                    "--screenshot",
                    str(screenshot),
                    "--timeout-ms",
                    str(round(args.timeout * 1000)),
                ],
                timeout=browser_process_timeout,
            )
            report["screenshots"].append({"viewport": viewport, "path": str(screenshot)})
        _manifest, report["manifest"] = manifest_summary(manifest_path)
        report["processes"] = {
            "api_pid": api_process.pid if api_process else None,
            "web_pid": web_process.pid if web_process else None,
            "parent_pid": parent_process.pid if parent_process else None,
            "state_root": str(state_root),
            "keep_running": args.keep_running,
        }
        report["presentation"] = {
            "parent_url": parent_origin,
            "api_base_url": api_base_url,
            "instantml_web_base_url": web_base_url,
            "report_path": str(args.report),
        }
        report["ok"] = True
        print(f"local real iframe e2e passed: {parent_origin}")
        if args.keep_running:
            if args.open_browser:
                report["presentation"]["browser_open"] = open_presentation_url(parent_origin)
            write_report(args.report, report)
            print(f"Parent page: {parent_origin}")
            print(f"API: {api_base_url}")
            print(f"InstantML web: {web_base_url}")
            if args.open_browser:
                opened = report["presentation"].get("browser_open", {})
                print(f"Browser open: {opened.get('method')} ok={opened.get('ok')}")
            print(f"Report: {args.report}")
            print("Press Ctrl-C to stop local services.")
            try:
                while True:
                    time.sleep(60)
            except KeyboardInterrupt:
                report["stopped_after_keep_running"] = True
                print("Stopping local services.")
        return 0
    except KeyboardInterrupt:
        report["error"] = "interrupted"
        return 130
    except Exception as exc:  # noqa: BLE001
        report["error"] = redact(str(exc))
        report["process_logs"] = {
            "api": process_log_tail(state_root / "api.log"),
            "web": process_log_tail(state_root / "web.log"),
            "parent": process_log_tail(state_root / "parent.log"),
        }
        print(f"local real iframe e2e failed: {report['error']}", file=sys.stderr)
        return 1
    finally:
        stop_process(parent_process)
        stop_process(web_process)
        stop_process(api_process, timeout=20.0)
        if temp_context is not None:
            temp_context.cleanup()
        write_report(args.report, report)
        print(f"wrote local real iframe e2e report: {args.report}")


if __name__ == "__main__":
    raise SystemExit(main())
