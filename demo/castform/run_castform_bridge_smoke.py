#!/usr/bin/env python3
"""Smoke-test the Castform SDK launch bridge without live credentials."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEFAULT_REPORT = HERE / "run-output" / "castform-bridge-smoke-report.json"
DEFAULT_OUTPUT = HERE / "run-output" / "castform-bridge-smoke-output.json"
SMOKE_API_KEY = "castform_smoke_secret_do_not_print"
SMOKE_RUN_ID = "castform-smoke-sdk-run-001"
TOKEN_RE = re.compile(r"(?:instantml|castform|platform)_[A-Za-z0-9_-]{12,}")


class BridgeSmokeError(RuntimeError):
    pass


class CommandFailure(BridgeSmokeError):
    def __init__(self, message: str, result: dict[str, Any]) -> None:
        super().__init__(message)
        self.result = result


def redact(value: str) -> str:
    return TOKEN_RE.sub("secret_redacted", value)


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


CALL_LOG = Path(os.environ["CASTFORM_BRIDGE_SMOKE_CALL_LOG"])


class TrainerClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def launch_training_run(self, **kwargs):
        CALL_LOG.write_text(json.dumps({{"client_kwargs": self.kwargs, "launch_kwargs": kwargs}}, sort_keys=True), encoding="utf-8")
        return {SMOKE_RUN_ID!r}
""".lstrip(),
        encoding="utf-8",
    )


def run_command(argv: list[str], *, env: dict[str, str], timeout: float) -> dict[str, Any]:
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
    if SMOKE_API_KEY in completed.stdout or SMOKE_API_KEY in completed.stderr:
        raise BridgeSmokeError("castform_live_bridge.py printed the SDK API key")
    if completed.returncode != 0:
        raise CommandFailure(f"{' '.join(argv)} failed with exit code {completed.returncode}: {result['stderr']}", result)
    return result


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BridgeSmokeError(f"missing JSON file: {path}") from exc
    if not isinstance(payload, dict):
        raise BridgeSmokeError(f"{path} must contain a JSON object")
    return payload


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise BridgeSmokeError(f"{label} mismatch: expected {expected!r}, got {actual!r}")


def verify_bridge_output(output: dict[str, Any], call: dict[str, Any]) -> dict[str, Any]:
    assert_equal(output.get("castform_run_id"), SMOKE_RUN_ID, "castform_run_id")
    assert_equal(output.get("castform_url"), f"https://app.castform.com/train/{SMOKE_RUN_ID}", "castform_url")
    assert_equal(output.get("training_run_type"), "simple", "training_run_type")
    assert_equal(output.get("name"), "castform-instantml-smoke", "name")

    client_kwargs = call.get("client_kwargs") if isinstance(call.get("client_kwargs"), dict) else {}
    launch_kwargs = call.get("launch_kwargs") if isinstance(call.get("launch_kwargs"), dict) else {}
    if client_kwargs.get("api_key") != SMOKE_API_KEY:
        raise BridgeSmokeError("TrainerClient did not receive the Castform API key")
    expected_launch = {
        "training_run_type": "simple",
        "env_cls_path": "envs/castform-demo/env-cls.pkl",
        "env_metadata_path": "envs/castform-demo/env-metadata.json",
        "train_dataset_path": "datasets/castform-demo/train.jsonl",
        "eval_dataset_path": "datasets/castform-demo/eval.jsonl",
        "name": "castform-instantml-smoke",
        "launcher_args": {
            "model": "Qwen/Qwen3.5-4B",
            "learning_rate": 0.00001,
            "batch_size": 14,
        },
    }
    assert_equal(launch_kwargs, expected_launch, "TrainerClient.launch_training_run kwargs")
    return {
        "client": {
            "api_key_present": bool(client_kwargs.get("api_key")),
            "base_url": client_kwargs.get("base_url"),
        },
        "launch": expected_launch,
        "bridge_output": {
            "castform_run_id": output.get("castform_run_id"),
            "castform_url": output.get("castform_url"),
            "training_run_type": output.get("training_run_type"),
            "name": output.get("name"),
        },
    }


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke-test the Castform SDK bridge with a fake Benchmax SDK")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report: dict[str, Any] = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "commands": [],
    }
    try:
        with tempfile.TemporaryDirectory(prefix="castform-bridge-smoke-") as temp_name:
            temp_root = Path(temp_name)
            call_log = temp_root / "trainer-call.json"
            write_fake_benchmax(temp_root, call_log)
            env = {
                **os.environ,
                "CASTFORM_API_KEY": SMOKE_API_KEY,
                "CASTFORM_BRIDGE_SMOKE_CALL_LOG": str(call_log),
                "PYTHONPATH": str(temp_root),
            }
            command = [
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
                "castform-instantml-smoke",
                "--launcher-arg",
                'model="Qwen/Qwen3.5-4B"',
                "--launcher-arg",
                "learning_rate=0.00001",
                "--launcher-arg",
                "batch_size=14",
                "--output",
                str(args.output),
            ]
            report["commands"].append(run_command(command, env=env, timeout=args.timeout))
            report.update(verify_bridge_output(load_json(args.output), load_json(call_log)))
        report["ok"] = True
        print(f"castform bridge smoke passed: {args.output}")
        return_code = 0
    except CommandFailure as exc:
        report["commands"].append(exc.result)
        report["error"] = redact(str(exc))
        print(f"castform bridge smoke failed: {report['error']}", file=sys.stderr)
        return_code = 1
    except Exception as exc:  # noqa: BLE001
        report["error"] = redact(str(exc))
        print(f"castform bridge smoke failed: {report['error']}", file=sys.stderr)
        return_code = 1
    finally:
        write_report(args.report, report)
        print(f"wrote bridge smoke report: {args.report}")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
