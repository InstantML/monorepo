#!/usr/bin/env python3
"""Run a no-secret Castform SDK launch -> mirror -> iframe smoke."""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from run_mocked_e2e import FakeInstantMLState, ReusableTCPServer, make_handler, start_server


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEFAULT_REPORT = HERE / "run-output" / "castform-sdk-e2e-smoke-report.json"
DEFAULT_BRIDGE_OUTPUT = HERE / "run-output" / "castform-sdk-e2e-bridge-output.json"
DEFAULT_SUMMARY = HERE / "run-output" / "castform-sdk-e2e-summary.json"
CASTFORM_RUN_ID = "castform-sdk-e2e-run-001"
CASTFORM_API_KEY = "castform_sdk_e2e_secret_do_not_print"
INSTANTML_API_KEY = "instantml_local_mock"
TOKEN_RE = re.compile(r"(?:instantml|castform|platform)_[A-Za-z0-9_-]{12,}")


class CastformSdkE2EError(RuntimeError):
    pass


class CommandFailure(CastformSdkE2EError):
    def __init__(self, message: str, result: dict[str, Any]) -> None:
        super().__init__(message)
        self.result = result


def redact(value: str) -> str:
    return TOKEN_RE.sub("secret_redacted", value)


def free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def wait_for_url(url: str, *, timeout: float, marker: str | None = None) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url, headers={"Accept": "text/html,application/json"})
            with urllib.request.urlopen(request, timeout=1.5) as response:
                body = response.read(4096).decode("utf-8", errors="replace")
                if response.status == 200 and (marker is None or marker in body):
                    return
        except (OSError, urllib.error.URLError) as exc:
            last_error = exc
        time.sleep(0.15)
    raise CastformSdkE2EError(f"{url} did not become reachable: {last_error}")


def write_fake_benchmax(root: Path, call_log: Path) -> None:
    client_dir = root / "benchmax" / "platform"
    client_dir.mkdir(parents=True, exist_ok=True)
    (root / "benchmax" / "__init__.py").write_text("", encoding="utf-8")
    (client_dir / "__init__.py").write_text("", encoding="utf-8")
    (client_dir / "client.py").write_text(
        f"""
import json
import os
from pathlib import Path


CALL_LOG = Path(os.environ["CASTFORM_SDK_E2E_CALL_LOG"])
RUN_ID = {CASTFORM_RUN_ID!r}


def append_call(name, payload):
    calls = json.loads(CALL_LOG.read_text(encoding="utf-8")) if CALL_LOG.exists() else []
    calls.append({{"name": name, "payload": payload}})
    CALL_LOG.write_text(json.dumps(calls, sort_keys=True), encoding="utf-8")


class TrainerClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        append_call("init", kwargs)

    def __enter__(self):
        append_call("enter", {{}})
        return self

    def __exit__(self, exc_type, exc, tb):
        append_call("exit", {{"exc_type": str(exc_type) if exc_type else None}})
        return False

    def launch_training_run(self, **kwargs):
        append_call("launch_training_run", kwargs)
        return RUN_ID

    def get_run(self, run_id, include_config=False):
        append_call("get_run", {{"run_id": run_id, "include_config": include_config}})
        return {{
            "id": run_id,
            "name": "castform-sdk-e2e-company-docs",
            "status": "completed",
            "createdAt": "2026-07-01T00:00:00Z",
            "updatedAt": "2026-07-01T00:12:00Z",
            "launcherArgs": {{
                "model": "Qwen/Qwen3.5-4B",
                "baseline_model": "gpt-5.4-nano",
                "learning_rate": 0.00001,
                "group_size": 9,
                "batch_size": 14,
                "environment": "CompanyDocsSearchEnv",
                "dataset": "company-docs-search-synth-v3",
                "reward_version": "rag-reward-v2"
            }}
        }}

    def get_run_details(self, run_id):
        append_call("get_run_details", {{"run_id": run_id}})
        return {{
            "modes": ["train", "eval", "comp"],
            "environment": "CompanyDocsSearchEnv",
            "reward_version": "rag-reward-v2"
        }}

    def get_run_scalars(self, run_id, mode):
        append_call("get_run_scalars", {{"run_id": run_id, "mode": mode}})
        if mode == "train":
            return {{
                "Average Reward": [
                    {{"step": 0, "value": 0.18, "createdAt": "2026-07-01T00:01:00Z"}},
                    {{"step": 10, "value": 0.48, "createdAt": "2026-07-01T00:04:00Z"}},
                    {{"step": 20, "value": 0.73, "createdAt": "2026-07-01T00:08:00Z"}}
                ],
                "Solve Rate": [
                    {{"step": 0, "value": 0.12}},
                    {{"step": 10, "value": 0.44}},
                    {{"step": 20, "value": 0.69}}
                ],
                "Response Length": [
                    {{"step": 0, "value": 1050}},
                    {{"step": 20, "value": 760}}
                ]
            }}
        if mode == "comp":
            return {{
                "Reward Comparison": [
                    {{"step": 20, "value": 0.08}}
                ],
                "Inference Cost Comparison": [
                    {{"step": 20, "value": 0.55}}
                ],
                "Baseline Inference Cost": [
                    {{"step": 20, "value": 2.90}}
                ],
                "Cost Reduction": [
                    {{"step": 20, "value": 81.0}}
                ]
            }}
        return {{
            "Average Reward": [
                {{"step": 0, "value": 0.16}},
                {{"step": 10, "value": 0.42}},
                {{"step": 20, "value": 0.66}}
            ],
            "Solve Rate": [
                {{"step": 0, "value": 0.10}},
                {{"step": 10, "value": 0.39}},
                {{"step": 20, "value": 0.61}}
            ]
        }}

    def get_run_events(self, run_id):
        append_call("get_run_events", {{"run_id": run_id}})
        return [
            {{"type": "castform.setup.completed", "step": 0}},
            {{"type": "training.completed", "step": 20}}
        ]

    def get_environment_logs(self, run_id):
        append_call("get_environment_logs", {{"run_id": run_id}})
        return [
            {{"createdAt": "2026-07-01T00:04:00Z", "level": "info", "content": "reward checkpoint eval solve_rate=0.39"}},
            {{"createdAt": "2026-07-01T00:08:00Z", "level": "info", "content": "final eval solve_rate=0.61"}}
        ]
""".lstrip(),
        encoding="utf-8",
    )


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
    combined = f"{completed.stdout}\n{completed.stderr}"
    if CASTFORM_API_KEY in combined or INSTANTML_API_KEY in combined:
        raise CastformSdkE2EError("a smoke secret appeared in command output")
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


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def redacted_json_value(value: Any) -> Any:
    return json.loads(redact(json.dumps(value, sort_keys=True)))


def read_manifest_summary(path: Path) -> dict[str, Any]:
    manifest = read_json(path)
    if not isinstance(manifest, dict):
        raise CastformSdkE2EError("manifest must be a JSON object")
    runs = manifest.get("runs") if isinstance(manifest.get("runs"), list) else []
    sessions = manifest.get("embed_sessions") if isinstance(manifest.get("embed_sessions"), list) else []
    return {
        "project": manifest.get("project"),
        "runs": len(runs),
        "embed_sessions": len(sessions),
        "run_titles": [run.get("title") for run in runs if isinstance(run, dict)],
    }


def validate_state(state: FakeInstantMLState) -> dict[str, Any]:
    summary = state.summary()
    if summary["runs"] != 1:
        raise CastformSdkE2EError(f"expected 1 mirrored InstantML run, saw {summary['runs']}")
    required_metrics = {"train/reward_mean", "eval/solve_rate", "comp/inference_cost_index"}
    if not required_metrics.issubset(set(summary["metric_keys"])):
        raise CastformSdkE2EError(f"mirrored metrics missing expected keys: {summary['metric_keys']}")
    if summary["log_batches"] < 1:
        raise CastformSdkE2EError("expected Castform logs to be mirrored")
    if set(summary["run_statuses"].values()) != {"finished"}:
        raise CastformSdkE2EError(f"mirrored run did not finish cleanly: {summary['run_statuses']}")
    return summary


def stop_process(process: subprocess.Popen[str] | None) -> dict[str, Any] | None:
    if process is None:
        return None
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
    parser = argparse.ArgumentParser(description="Run fake Castform SDK launch, mirror, and iframe smoke")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--project", default="castform-sdk-e2e-smoke")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--bridge-output", type=Path, default=DEFAULT_BRIDGE_OUTPUT)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_port = free_port(args.host)
    web_port = free_port(args.host)
    api_base_url = f"http://{args.host}:{api_port}"
    web_base_url = f"http://{args.host}:{web_port}"
    state = FakeInstantMLState(instantml_web_base_url=api_base_url)
    api_server = ReusableTCPServer((args.host, api_port), make_handler(state))
    web_server: subprocess.Popen[str] | None = None
    report: dict[str, Any] = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "api_base_url": api_base_url,
        "web_base_url": web_base_url,
        "project": args.project,
        "commands": [],
    }
    try:
        start_server(api_server)
        wait_for_url(api_base_url + "/health", timeout=args.timeout)
        with tempfile.TemporaryDirectory(prefix="castform-sdk-e2e-") as temp_name:
            temp_root = Path(temp_name)
            call_log = temp_root / "benchmax-calls.json"
            write_fake_benchmax(temp_root, call_log)
            env = {
                **os.environ,
                "CASTFORM_API_KEY": CASTFORM_API_KEY,
                "INSTANTML_API_KEY": INSTANTML_API_KEY,
                "CASTFORM_SDK_E2E_CALL_LOG": str(call_log),
                "PYTHONPATH": f"{temp_root}{os.pathsep}{REPO_ROOT / 'packages' / 'python-sdk'}",
            }
            record_command(
                report,
                [
                    sys.executable,
                    "demo/castform/castform_live_bridge.py",
                    "--training-run-type",
                    "simple",
                    "--env-cls-path",
                    "envs/castform-demo/env-cls.pkl",
                    "--env-metadata-path",
                    "envs/castform-demo/env-metadata.json",
                    "--train-dataset-path",
                    "datasets/castform-demo/train.jsonl",
                    "--eval-dataset-path",
                    "datasets/castform-demo/eval.jsonl",
                    "--name",
                    "castform-sdk-e2e-company-docs",
                    "--launcher-arg",
                    'model="Qwen/Qwen3.5-4B"',
                    "--launcher-arg",
                    "learning_rate=0.00001",
                    "--output",
                    str(args.bridge_output),
                ],
                env=env,
                timeout=args.timeout,
            )
            bridge_output = read_json(args.bridge_output)
            if not isinstance(bridge_output, dict) or bridge_output.get("castform_run_id") != CASTFORM_RUN_ID:
                raise CastformSdkE2EError("bridge did not return the expected Castform run ID")
            record_command(
                report,
                [
                    sys.executable,
                    "demo/castform/castform_instantml_adapter.py",
                    "--castform-run-id",
                    CASTFORM_RUN_ID,
                    "--instantml-project",
                    args.project,
                    "--instantml-base-url",
                    api_base_url,
                    "--castform-base-url",
                    "https://api.castform.local",
                ],
                env=env,
                timeout=args.timeout,
            )
            report["benchmax_calls"] = redacted_json_value(read_json(call_log))
        report["fake_api_after_mirror"] = validate_state(state)

        run_ids = list(state.runs.keys())
        if len(run_ids) != 1:
            raise CastformSdkE2EError(f"expected one mirrored run ID, saw {run_ids}")
        recover_command = [
            sys.executable,
            "demo/castform/run_demo.py",
            "--api-base-url",
            api_base_url,
            "--instantml-web-base-url",
            api_base_url,
            "--parent-origin",
            web_base_url,
            "--project",
            args.project,
            "--summary",
            str(args.summary),
            "--instantml-run-id",
            run_ids[0],
        ]
        record_command(report, recover_command, env={**os.environ, "INSTANTML_API_KEY": INSTANTML_API_KEY}, timeout=args.timeout)

        web_server = subprocess.Popen(
            [sys.executable, "demo/castform/serve_web.py", "--host", args.host, "--port", str(web_port)],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        wait_for_url(web_base_url, timeout=args.timeout, marker="Castform InstantML Demo")
        record_command(
            report,
            [sys.executable, "demo/castform/verify_demo.py", "--local", "--parent-url", web_base_url, "--summary", str(args.summary)],
            timeout=args.timeout,
        )
        record_command(
            report,
            [
                "node",
                "demo/castform/browser_verify.mjs",
                "--url",
                web_base_url,
                "--expect-runs",
                "1",
                "--expect-sessions",
                "1",
                "--viewport",
                "1366x900",
            ],
            timeout=args.timeout,
        )
        report["manifest"] = read_manifest_summary(HERE / "web" / "public" / "demo-manifest.json")
        report["fake_api_final"] = state.summary()
        report["ok"] = True
        print(f"castform sdk e2e smoke passed: api={api_base_url} web={web_base_url}")
        return_code = 0
    except Exception as exc:  # noqa: BLE001
        report["error"] = redact(str(exc))
        print(f"castform sdk e2e smoke failed: {report['error']}", file=sys.stderr)
        return_code = 1
    finally:
        api_server.shutdown()
        api_server.server_close()
        stopped_web = stop_process(web_server)
        if stopped_web is not None:
            report["web_server"] = stopped_web
        write_report(args.report, report)
        print(f"wrote Castform SDK e2e smoke report: {args.report}")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
