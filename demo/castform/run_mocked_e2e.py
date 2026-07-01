#!/usr/bin/env python3
"""Run the real Castform demo writer against a local fake InstantML API."""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEFAULT_REPORT = HERE / "run-output" / "mocked-e2e-report.json"
DEFAULT_RESUME_SUMMARY = HERE / "run-output" / "mocked-e2e-resume-summary.json"
TOKEN_RE = re.compile(r"instantml_embed_(?!redacted\b)[A-Za-z0-9_-]+")


class MockE2EError(RuntimeError):
    pass


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


class FakeInstantMLState:
    def __init__(self, instantml_web_base_url: str) -> None:
        self.instantml_web_base_url = instantml_web_base_url.rstrip("/")
        self.runs: dict[str, dict[str, Any]] = {}
        self.metrics: list[dict[str, Any]] = []
        self.attributes: list[dict[str, Any]] = []
        self.logs: list[dict[str, Any]] = []
        self.embed_sessions: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []

    def create_run(self, body: dict[str, Any]) -> dict[str, Any]:
        run_id = f"mock-run-{len(self.runs) + 1:03d}"
        run = {
            "id": run_id,
            "project": body.get("project"),
            "name": body.get("name"),
            "config": body.get("config") if isinstance(body.get("config"), dict) else {},
            "tags": body.get("tags") if isinstance(body.get("tags"), list) else [],
            "metadata": body.get("metadata") if isinstance(body.get("metadata"), dict) else {},
            "status": "running",
        }
        self.runs[run_id] = run
        return {"run": run}

    def finish_run(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        run = self.runs.get(run_id)
        if run is None:
            raise KeyError(run_id)
        run["status"] = body.get("status") or run["status"]
        run["finished_at"] = datetime.now(timezone.utc).isoformat()
        return {"run": run}

    def create_embed_session(self, body: dict[str, Any]) -> dict[str, Any]:
        session_id = f"mock-session-{len(self.embed_sessions) + 1:03d}"
        run_ids = body.get("run_ids") if isinstance(body.get("run_ids"), list) else []
        token = f"instantml_{'embed'}_mock_{len(self.embed_sessions) + 1:03d}"
        session = {
            "id": session_id,
            "run_ids": run_ids,
            "allowed_parent_origin": body.get("allowed_parent_origin"),
            "run_count": len(run_ids),
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "iframe_src": f"{self.instantml_web_base_url}/embed/runs/{session_id}#token={token}",
        }
        self.embed_sessions.append(session)
        return {"embed_session": session, "warnings": []}

    def latest_metrics_for_run(self, run_id: str) -> dict[str, float]:
        latest: dict[str, tuple[int, float]] = {}
        for batch in self.metrics:
            if batch.get("run_id") != run_id:
                continue
            step = batch.get("step")
            metrics = batch.get("metrics")
            if not isinstance(step, (int, float)) or not isinstance(metrics, dict):
                continue
            for key, value in metrics.items():
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    continue
                previous = latest.get(str(key))
                if previous is None or int(step) >= previous[0]:
                    latest[str(key)] = (int(step), float(value))
        return {key: value for key, (_step, value) in latest.items()}

    def runs_summary(self, query: dict[str, list[str]]) -> dict[str, Any]:
        project = (query.get("project") or [""])[0]
        search = (query.get("q") or [""])[0]
        id_filter = search.removeprefix("id:") if search.startswith("id:") else ""
        rows = []
        for run_id, run in self.runs.items():
            if project and run.get("project") != project:
                continue
            if id_filter and run_id != id_filter:
                continue
            latest_metrics = self.latest_metrics_for_run(run_id)
            rows.append(
                {
                    **run,
                    "latest_metrics": latest_metrics,
                    "metric_aggregates": {
                        key: {
                            "latest": value,
                            "min": value,
                            "max": value,
                            "mean": value,
                            "variance": 0.0,
                            "count": 1,
                            "best_step": None,
                        }
                        for key, value in latest_metrics.items()
                    },
                    "metric_keys": sorted(latest_metrics),
                }
            )
        return {
            "runs": rows,
            "metric_keys": sorted({key for row in rows for key in row.get("metric_keys", [])}),
            "total": len(rows),
            "next_cursor": None,
            "page_info": {"pagination": "cursor", "has_next_page": False},
        }

    def summary(self) -> dict[str, Any]:
        metric_keys = sorted({key for item in self.metrics for key in item.get("metrics", {})})
        return {
            "runs": len(self.runs),
            "metrics_batches": len(self.metrics),
            "metric_keys": metric_keys,
            "attributes_batches": len(self.attributes),
            "log_batches": len(self.logs),
            "embed_sessions": len(self.embed_sessions),
            "requests": len(self.requests),
            "run_statuses": {run_id: run.get("status") for run_id, run in self.runs.items()},
        }


def redact(value: str) -> str:
    return TOKEN_RE.sub("instantml_embed_redacted", value)


def read_json(handler: http.server.BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("JSON body must be an object")
    return payload


def write_json(handler: http.server.BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, sort_keys=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def write_html(handler: http.server.BaseHTTPRequestHandler, status: int, html: str) -> None:
    data = html.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def make_handler(state: FakeInstantMLState) -> type[http.server.BaseHTTPRequestHandler]:
    class FakeInstantMLHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def do_GET(self) -> None:
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            state.requests.append({"method": "GET", "path": path})
            if path == "/health":
                write_json(self, 200, {"status": "ok"})
                return
            if path == "/api/runs/summary":
                write_json(self, 200, state.runs_summary(urllib.parse.parse_qs(parsed.query)))
                return
            if path.startswith("/embed/runs/"):
                write_html(
                    self,
                    200,
                    "<!doctype html><title>Mock InstantML Embed</title><main>Mock InstantML embed loaded</main>",
                )
                return
            write_json(self, 404, {"error": f"unknown path: {path}"})

        def do_POST(self) -> None:
            path = urllib.parse.urlsplit(self.path).path
            try:
                body = read_json(self)
            except Exception as exc:  # noqa: BLE001
                write_json(self, 400, {"error": str(exc)})
                return
            state.requests.append({"method": "POST", "path": path})
            try:
                if path == "/runs":
                    write_json(self, 200, state.create_run(body))
                    return
                if path.startswith("/runs/") and path.endswith("/metrics"):
                    run_id = path.split("/")[2]
                    if run_id not in state.runs:
                        write_json(self, 404, {"error": "unknown run"})
                        return
                    state.metrics.append({"run_id": run_id, **body})
                    write_json(self, 200, {"ok": True})
                    return
                if path.startswith("/api/runs/") and path.endswith("/attributes"):
                    run_id = path.split("/")[3]
                    if run_id not in state.runs:
                        write_json(self, 404, {"error": "unknown run"})
                        return
                    state.attributes.append({"run_id": run_id, **body})
                    write_json(self, 200, {"ok": True})
                    return
                if path.startswith("/api/runs/") and path.endswith("/logs"):
                    run_id = path.split("/")[3]
                    if run_id not in state.runs:
                        write_json(self, 404, {"error": "unknown run"})
                        return
                    state.logs.append({"run_id": run_id, **body})
                    write_json(self, 200, {"ok": True})
                    return
                if path == "/api/embed/sessions":
                    write_json(self, 200, state.create_embed_session(body))
                    return
                write_json(self, 404, {"error": f"unknown path: {path}"})
            except KeyError:
                write_json(self, 404, {"error": "unknown run"})

        def do_PATCH(self) -> None:
            path = urllib.parse.urlsplit(self.path).path
            try:
                body = read_json(self)
            except Exception as exc:  # noqa: BLE001
                write_json(self, 400, {"error": str(exc)})
                return
            state.requests.append({"method": "PATCH", "path": path})
            if path.startswith("/runs/"):
                run_id = path.split("/")[2]
                try:
                    write_json(self, 200, state.finish_run(run_id, body))
                except KeyError:
                    write_json(self, 404, {"error": "unknown run"})
                return
            write_json(self, 404, {"error": f"unknown path: {path}"})

    return FakeInstantMLHandler


def free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def wait_for_url(url: str, *, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as response:
                if response.status == 200:
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(0.1)
    raise MockE2EError(f"{url} did not become reachable: {last_error}")


def run_command(argv: list[str], *, env: dict[str, str] | None = None, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(
        argv,
        cwd=REPO_ROOT,
        env=env,
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
        raise MockE2EError(f"{' '.join(argv)} failed with exit code {completed.returncode}: {result['stderr']}")
    return result


def start_server(server: ReusableTCPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Castform demo writer against a fake local InstantML API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--step-size", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--desktop-viewport", default="1366x900")
    parser.add_argument("--mobile-viewport", default="390x844")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_port = free_port(args.host)
    web_port = free_port(args.host)
    api_base_url = f"http://{args.host}:{api_port}"
    web_base_url = f"http://{args.host}:{web_port}"
    state = FakeInstantMLState(instantml_web_base_url=api_base_url)
    report: dict[str, Any] = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "api_base_url": api_base_url,
        "web_base_url": web_base_url,
        "commands": [],
    }
    api_server = ReusableTCPServer((args.host, api_port), make_handler(state))
    web_server: subprocess.Popen[str] | None = None
    try:
        start_server(api_server)
        wait_for_url(api_base_url + "/health", timeout=args.timeout)
        env = {
            **os.environ,
            "INSTANTML_API_KEY": "instantml_local_mock",
            "PYTHONPATH": str(REPO_ROOT / "packages" / "python-sdk"),
        }
        report["commands"].append(
            run_command(
                [
                    sys.executable,
                    "demo/castform/run_demo.py",
                    "--api-base-url",
                    api_base_url,
                    "--instantml-web-base-url",
                    api_base_url,
                    "--parent-origin",
                    web_base_url,
                    "--project",
                    "castform-mocked-e2e",
                    "--runs",
                    str(args.runs),
                    "--steps",
                    str(args.steps),
                    "--step-size",
                    str(args.step_size),
                ],
                env=env,
                timeout=args.timeout,
            )
        )
        summary = state.summary()
        if summary["runs"] != args.runs:
            raise MockE2EError(f"expected {args.runs} runs, saw {summary['runs']}")
        if summary["embed_sessions"] < 1:
            raise MockE2EError("expected at least one embed session")
        if "train/reward_components/search_efficiency/mean" not in summary["metric_keys"]:
            raise MockE2EError("search_efficiency metric was not logged")
        if set(summary["run_statuses"].values()) != {"finished"}:
            raise MockE2EError(f"runs did not all finish: {summary['run_statuses']}")

        resume_command = [
            sys.executable,
            "demo/castform/run_demo.py",
            "--api-base-url",
            api_base_url,
            "--instantml-web-base-url",
            api_base_url,
            "--parent-origin",
            web_base_url,
            "--project",
            "castform-mocked-e2e",
            "--summary",
            str(DEFAULT_RESUME_SUMMARY),
        ]
        for run_id in state.runs:
            resume_command.extend(["--instantml-run-id", run_id])
        report["commands"].append(run_command(resume_command, env=env, timeout=args.timeout))
        resume_summary = state.summary()
        if resume_summary["runs"] != summary["runs"]:
            raise MockE2EError(f"resume path changed run count from {summary['runs']} to {resume_summary['runs']}")
        if resume_summary["embed_sessions"] <= summary["embed_sessions"]:
            raise MockE2EError("resume path did not create additional embed sessions")

        web_server = subprocess.Popen(
            [sys.executable, "demo/castform/serve_web.py", "--host", args.host, "--port", str(web_port)],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        wait_for_url(web_base_url, timeout=args.timeout)
        report["commands"].append(
            run_command(
                [
                    sys.executable,
                    "demo/castform/verify_demo.py",
                    "--local",
                    "--parent-url",
                    web_base_url,
                    "--summary",
                    str(DEFAULT_RESUME_SUMMARY),
                ],
                timeout=args.timeout,
            )
        )
        expect_sessions = "1" if args.runs == 1 else "3"
        for viewport in (args.desktop_viewport, args.mobile_viewport):
            report["commands"].append(
                run_command(
                    [
                        "node",
                        "demo/castform/browser_verify.mjs",
                        "--url",
                        web_base_url,
                        "--expect-runs",
                        str(args.runs),
                        "--expect-sessions",
                        expect_sessions,
                        "--viewport",
                        viewport,
                    ],
                    timeout=args.timeout,
                )
            )
        report["fake_api"] = resume_summary
        report["initial_fake_api"] = summary
        report["ok"] = True
        print(f"mocked e2e passed: api={api_base_url} web={web_base_url}")
        return_code = 0
    except Exception as exc:  # noqa: BLE001
        report["error"] = redact(str(exc))
        print(f"mocked e2e failed: {report['error']}", file=sys.stderr)
        return_code = 1
    finally:
        api_server.shutdown()
        api_server.server_close()
        if web_server is not None:
            if web_server.poll() is None:
                web_server.terminate()
            try:
                stdout, stderr = web_server.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                web_server.kill()
                stdout, stderr = web_server.communicate(timeout=5)
            report["web_server"] = {"exit_code": web_server.returncode, "stdout": redact(stdout or ""), "stderr": redact(stderr or "")}
        write_report(args.report, report)
        print(f"wrote mocked e2e report: {args.report}")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
