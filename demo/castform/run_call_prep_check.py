#!/usr/bin/env python3
"""Run the Castform demo call-prep verification suite."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEFAULT_REPORT = HERE / "run-output" / "call-prep-check-report.json"
TOKEN_RE = re.compile(r"instantml_(?:embed_)?(?!redacted\b)[A-Za-z0-9_-]{20,}")


class CallPrepError(RuntimeError):
    pass


class CommandFailure(CallPrepError):
    def __init__(self, message: str, result: dict[str, Any]) -> None:
        super().__init__(message)
        self.result = result


def redact(value: str) -> str:
    return TOKEN_RE.sub("instantml_redacted", value)


def run_command(argv: list[str], *, timeout: float) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            argv,
            cwd=REPO_ROOT,
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


def record_command(report: dict[str, Any], argv: list[str], *, timeout: float) -> None:
    try:
        report["commands"].append(run_command(argv, timeout=timeout))
    except CommandFailure as exc:
        report["commands"].append(exc.result)
        raise


def read_report(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def compact_report(path: Path) -> dict[str, Any] | None:
    payload = read_report(path)
    if payload is None:
        return None
    summary: dict[str, Any] = {"path": str(path), "ok": payload.get("ok")}
    for key in (
        "initial_fake_api",
        "fake_api",
        "blocked_fake_api",
        "live_blocked_smoke",
        "client",
        "launch",
        "bridge_output",
        "fake_api_after_mirror",
        "fake_api_final",
        "initial_manifest",
        "manifest",
        "screenshots",
        "resume_run_total_before",
        "resume_run_total_after",
        "counts",
        "summary",
        "parent_origin",
        "parent_url",
        "run_ids",
        "source",
        "castform_sdk_run_ids",
        "benchmax_calls",
    ):
        if key in payload:
            summary[key] = payload[key]
    return summary


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Castform demo call-prep checks")
    parser.add_argument("--full", action="store_true", help="Include the heavier real local InstantML iframe E2E")
    parser.add_argument("--live", action="store_true", help="Include hosted readiness and live persisted-data browser smoke")
    parser.add_argument("--timeout", type=float, default=240.0)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--real-runs", type=int, default=3)
    parser.add_argument("--real-steps", type=int, default=40)
    parser.add_argument("--real-step-size", type=int, default=10)
    parser.add_argument("--real-source", choices=("fallback", "castform-sdk"), default="fallback", help="Training source for the --full local real iframe E2E")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report: dict[str, Any] = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "full": args.full,
        "live": args.live,
        "real_source": args.real_source,
        "commands": [],
        "reports": {},
    }
    try:
        castform_report = HERE / "run-output" / "castform-readiness-report.json"
        bridge_report = HERE / "run-output" / "castform-bridge-smoke-report.json"
        sdk_e2e_report = HERE / "run-output" / "castform-sdk-e2e-smoke-report.json"
        mocked_report = HERE / "run-output" / "mocked-e2e-report.json"
        smoke_report = HERE / "run-output" / "local-smoke-report.json"
        real_report = HERE / "run-output" / "local-real-iframe-e2e-report.json"
        hosted_report = HERE / "run-output" / "hosted-readiness-call-prep-report.json"
        live_report = HERE / "run-output" / "live-blocked-smoke-call-prep-report.json"
        live_summary = HERE / "run-output" / "live-blocked-smoke-call-prep-summary.json"

        record_command(
            report,
            [
                sys.executable,
                "demo/castform/check_castform_readiness.py",
                "--allow-missing-live-inputs",
                "--skip-network",
                "--report",
                str(castform_report),
            ],
            timeout=args.timeout,
        )
        report["reports"]["castform_readiness"] = compact_report(castform_report)

        record_command(
            report,
            [sys.executable, "demo/castform/run_castform_bridge_smoke.py", "--report", str(bridge_report)],
            timeout=args.timeout,
        )
        report["reports"]["castform_bridge_smoke"] = compact_report(bridge_report)

        record_command(
            report,
            [sys.executable, "demo/castform/run_castform_sdk_e2e_smoke.py", "--report", str(sdk_e2e_report)],
            timeout=args.timeout,
        )
        report["reports"]["castform_sdk_e2e_smoke"] = compact_report(sdk_e2e_report)

        record_command(
            report,
            [sys.executable, "demo/castform/run_mocked_e2e.py", "--report", str(mocked_report)],
            timeout=args.timeout,
        )
        report["reports"]["mocked_e2e"] = compact_report(mocked_report)

        record_command(
            report,
            [sys.executable, "demo/castform/run_local_smoke.py", "--port", "0", "--report", str(smoke_report)],
            timeout=args.timeout,
        )
        report["reports"]["local_smoke"] = compact_report(smoke_report)

        if args.live:
            record_command(
                report,
                [sys.executable, "demo/castform/check_hosted_readiness.py", "--report", str(hosted_report)],
                timeout=args.timeout,
            )
            report["reports"]["hosted_readiness"] = compact_report(hosted_report)

            record_command(
                report,
                [
                    sys.executable,
                    "demo/castform/run_live_blocked_smoke.py",
                    "--timeout",
                    str(args.timeout),
                    "--report",
                    str(live_report),
                    "--summary",
                    str(live_summary),
                ],
                timeout=max(args.timeout + 30.0, args.timeout * 1.5),
            )
            report["reports"]["live_blocked_smoke"] = compact_report(live_report)
        else:
            report["reports"]["hosted_readiness"] = {"skipped": True, "reason": "pass --live to run"}
            report["reports"]["live_blocked_smoke"] = {"skipped": True, "reason": "pass --live to run"}

        if args.full:
            record_command(
                report,
                [
                    sys.executable,
                    "demo/castform/run_local_real_iframe_e2e.py",
                    "--source",
                    args.real_source,
                    "--runs",
                    str(args.real_runs),
                    "--steps",
                    str(args.real_steps),
                    "--step-size",
                    str(args.real_step_size),
                    "--timeout",
                    str(args.timeout),
                    "--report",
                    str(real_report),
                ],
                timeout=max(args.timeout + 60.0, args.timeout * 2.0),
            )
            report["reports"]["local_real_iframe_e2e"] = compact_report(real_report)
        else:
            report["reports"]["local_real_iframe_e2e"] = {"skipped": True, "reason": "pass --full to run"}

        report["ok"] = True
        print(f"call prep check passed: {args.report}")
        return 0
    except Exception as exc:  # noqa: BLE001
        report["error"] = redact(str(exc))
        print(f"call prep check failed: {report['error']}", file=sys.stderr)
        return 1
    finally:
        write_json(args.report, report)
        print(f"wrote call prep report: {args.report}")


if __name__ == "__main__":
    raise SystemExit(main())
