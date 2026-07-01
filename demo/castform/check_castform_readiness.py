#!/usr/bin/env python3
"""Check live Castform SDK readiness without printing secrets."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
DEFAULT_REPORT = HERE / "run-output" / "castform-readiness-report.json"
DEFAULT_CASTFORM_APP_URL = "https://app.castform.com/home"


def module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def check_app_home(url: str, *, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "text/html"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(64_000).decode("utf-8", errors="replace")
            return {
                "name": "castform_app_home",
                "status": "ok" if 200 <= response.status < 400 else "fail",
                "http_status": response.status,
                "url": response.geturl(),
                "looks_like_castform": "Castform" in body or "castform" in body.lower(),
            }
    except urllib.error.HTTPError as exc:
        return {"name": "castform_app_home", "status": "fail", "http_status": exc.code, "url": url}
    except OSError as exc:
        return {"name": "castform_app_home", "status": "warn", "url": url, "detail": str(exc)}


def credential_present() -> bool:
    return bool(os.environ.get("CASTFORM_API_KEY") or os.environ.get("PLATFORM_API_KEY"))


def asset_checks(args: argparse.Namespace) -> list[dict[str, Any]]:
    values = {
        "env_cls_path": args.env_cls_path,
        "env_metadata_path": args.env_metadata_path,
        "train_dataset_path": args.train_dataset_path,
        "eval_dataset_path": args.eval_dataset_path,
    }
    return [
        {
            "name": name,
            "status": "ok" if value else "missing",
            "provided": bool(value),
        }
        for name, value in values.items()
    ]


def status_counts(checks: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for check in checks:
        status = str(check.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return counts


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check live Castform SDK readiness without printing secrets")
    parser.add_argument("--training-run-type", default="simple")
    parser.add_argument("--env-cls-path")
    parser.add_argument("--env-metadata-path")
    parser.add_argument("--train-dataset-path")
    parser.add_argument("--eval-dataset-path")
    parser.add_argument("--castform-app-url", default=os.environ.get("CASTFORM_APP_URL", DEFAULT_CASTFORM_APP_URL))
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--allow-missing-live-inputs", action="store_true")
    parser.add_argument("--skip-network", action="store_true")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--json", action="store_true", help="Print JSON instead of concise text")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    checks: list[dict[str, Any]] = [
        {
            "name": "benchmax_sdk_import",
            "status": "ok" if module_available("benchmax.platform.client") else "missing",
            "module": "benchmax.platform.client",
        },
        {
            "name": "castform_api_key",
            "status": "ok" if credential_present() else "missing",
            "env_names": ["CASTFORM_API_KEY", "PLATFORM_API_KEY"],
        },
        {
            "name": "training_run_type",
            "status": "ok" if args.training_run_type else "missing",
            "value": args.training_run_type,
        },
        *asset_checks(args),
    ]
    if args.skip_network:
        checks.append({"name": "castform_app_home", "status": "skipped", "url": args.castform_app_url})
    else:
        checks.append(check_app_home(args.castform_app_url, timeout=args.timeout))

    counts = status_counts(checks)
    blocking = [check for check in checks if check.get("status") in {"fail", "missing"}]
    ok = not blocking or args.allow_missing_live_inputs
    report = {
        "ok": ok,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "training_run_type": args.training_run_type,
        "checks": checks,
        "counts": counts,
        "allow_missing_live_inputs": args.allow_missing_live_inputs,
    }
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        for check in checks:
            print(f"{check['name']}={check['status']}")
        print(f"report={args.report}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
