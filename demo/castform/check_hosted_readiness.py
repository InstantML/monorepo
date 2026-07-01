#!/usr/bin/env python3
"""Check hosted Castform demo readiness without writing data or printing secrets."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from run_demo import DEFAULT_API_BASE_URL, DEFAULT_INSTANTML_WEB_BASE_URL, DEFAULT_PROJECT
from verify_demo import VerificationError, check_parent_page as verify_parent_page, normalize_origin


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
DEFAULT_REPORT = HERE / "run-output" / "hosted-readiness-report.json"
LOCAL_SDK = REPO_ROOT / "packages" / "python-sdk"
if LOCAL_SDK.exists():
    sys.path.insert(0, str(LOCAL_SDK))


def check(statuses: list[dict[str, Any]], name: str, status: str, message: str, **extra: Any) -> None:
    statuses.append({"name": name, "status": status, "message": message, **extra})


def run_command(argv: list[str], *, timeout: float) -> tuple[int, str, str]:
    completed = subprocess.run(
        argv,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return completed.returncode, completed.stdout.strip(), completed.stderr.strip()


def check_python_sdk(statuses: list[dict[str, Any]]) -> None:
    spec = importlib.util.find_spec("instantml")
    if spec is None:
        check(statuses, "instantml_python_sdk", "fail", "instantml Python SDK is not importable")
        return
    check(statuses, "instantml_python_sdk", "ok", "instantml Python SDK is importable", origin=str(spec.origin or "unknown"))


def check_benchmax(statuses: list[dict[str, Any]], *, required: bool) -> None:
    spec = importlib.util.find_spec("benchmax")
    if spec is None:
        status = "fail" if required else "warn"
        message = "benchmax/Castform SDK is not importable"
        if not required:
            message += "; fallback generated Castform-shaped runs can still be used"
        check(statuses, "benchmax_sdk", status, message)
        return
    check(statuses, "benchmax_sdk", "ok", "benchmax/Castform SDK is importable", origin=str(spec.origin or "unknown"))


def check_node_and_playwright(statuses: list[dict[str, Any]], *, timeout: float) -> None:
    code, stdout, stderr = run_command(["node", "--version"], timeout=timeout)
    if code != 0:
        check(statuses, "node", "fail", "node is not available", stderr=stderr)
        return
    check(statuses, "node", "ok", f"node available: {stdout}")

    code, _stdout, stderr = run_command(["node", "--check", "demo/castform/browser_verify.mjs"], timeout=timeout)
    if code != 0:
        check(statuses, "browser_verify_syntax", "fail", "browser verifier syntax check failed", stderr=stderr)
    else:
        check(statuses, "browser_verify_syntax", "ok", "browser verifier syntax check passed")

    code, _stdout, stderr = run_command(
        ["node", "-e", "import('playwright').then(()=>process.exit(0)).catch((error)=>{console.error(error.message); process.exit(1)})"],
        timeout=timeout,
    )
    if code != 0:
        check(statuses, "playwright", "fail", "playwright is not importable from node", stderr=stderr)
    else:
        check(statuses, "playwright", "ok", "playwright is importable from node")


def check_ignored_paths(statuses: list[dict[str, Any]], *, timeout: float) -> None:
    paths = [
        "demo/castform/web/public/demo-manifest.json",
        "demo/castform/run-output/latest-summary.json",
        "demo/castform/run-output/hosted-readiness-report.json",
    ]
    failed = []
    for path in paths:
        code, _stdout, _stderr = run_command(["git", "check-ignore", "-q", path], timeout=timeout)
        if code != 0:
            failed.append(path)
    if failed:
        check(statuses, "ignored_generated_paths", "fail", "generated output path is not ignored by Git", paths=failed)
    else:
        check(statuses, "ignored_generated_paths", "ok", "generated manifests, summaries, and reports are ignored")


def check_parent_origin(statuses: list[dict[str, Any]], raw: str | None, *, allow_missing: bool) -> str | None:
    if not raw:
        status = "warn" if allow_missing else "fail"
        check(statuses, "parent_origin", status, "CASTFORM_DEMO_PARENT_ORIGIN or --parent-origin is required for hosted iframes")
        return None
    try:
        origin = normalize_origin(raw, hosted=True)
    except VerificationError as exc:
        check(statuses, "parent_origin", "fail", str(exc))
        return None
    check(statuses, "parent_origin", "ok", "hosted parent origin is valid", origin=origin)
    return origin


def check_parent_page(statuses: list[dict[str, Any]], parent_url: str | None, *, timeout: float) -> None:
    if not parent_url:
        check(statuses, "parent_page", "skip", "no --parent-url provided")
        return
    try:
        notes = verify_parent_page(parent_url, timeout=timeout)
    except VerificationError as exc:
        check(statuses, "parent_page", "fail", str(exc))
        return
    check(statuses, "parent_page", "ok", "parent page is reachable and not behind a tunnel warning", notes=notes)


def check_api_health(statuses: list[dict[str, Any]], api_base_url: str, *, timeout: float, skip_network: bool) -> None:
    if skip_network:
        check(statuses, "instantml_api_health", "skip", "network health check skipped")
        return
    url = api_base_url.rstrip("/") + "/health"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(512).decode("utf-8", errors="replace")
            status_code = response.status
    except (OSError, urllib.error.URLError) as exc:
        check(statuses, "instantml_api_health", "fail", f"health request failed: {exc}", url=url)
        return
    elapsed_ms = round((time.monotonic() - started) * 1000)
    if status_code != 200:
        check(statuses, "instantml_api_health", "fail", f"unexpected health status {status_code}", url=url, elapsed_ms=elapsed_ms)
        return
    check(statuses, "instantml_api_health", "ok", "InstantML hosted API health check passed", url=url, elapsed_ms=elapsed_ms, response=body)


def fetch_json(url: str, *, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(1_000_000).decode("utf-8", errors="replace")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError(f"{url} did not return a JSON object")
    return payload


def check_hosted_embed_route(
    statuses: list[dict[str, Any]],
    api_base_url: str,
    *,
    timeout: float,
    skip_network: bool,
    required: bool,
) -> None:
    if skip_network:
        check(statuses, "hosted_embed_route", "skip", "hosted embed OpenAPI check skipped")
        return
    url = api_base_url.rstrip("/") + "/openapi.json"
    try:
        payload = fetch_json(url, timeout=timeout)
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError) as exc:
        status = "fail" if required else "warn"
        check(statuses, "hosted_embed_route", status, f"could not inspect hosted OpenAPI: {exc}", url=url)
        return
    paths = payload.get("paths")
    if not isinstance(paths, dict):
        status = "fail" if required else "warn"
        check(statuses, "hosted_embed_route", status, "hosted OpenAPI does not include a paths object", url=url)
        return
    path = paths.get("/api/embed/sessions")
    post_present = isinstance(path, dict) and "post" in {str(method).lower() for method in path}
    if post_present:
        check(statuses, "hosted_embed_route", "ok", "hosted embed-session API route is advertised", url=url, route="/api/embed/sessions")
        return
    status = "fail" if required else "warn"
    check(
        statuses,
        "hosted_embed_route",
        status,
        "hosted embed-session API route is not advertised; use blocked hosted mode or local real iframe E2E",
        url=url,
        route="/api/embed/sessions",
        embed_paths=[key for key in sorted(paths) if "embed" in key.lower()][:20],
    )


def check_live_secrets(
    statuses: list[dict[str, Any]],
    *,
    allow_missing: bool,
    castform_run_ids: list[str],
) -> None:
    instantml_key = os.environ.get("INSTANTML_API_KEY")
    if instantml_key:
        check(statuses, "instantml_api_key", "ok", "INSTANTML_API_KEY is present", length=len(instantml_key))
    else:
        status = "warn" if allow_missing else "fail"
        check(statuses, "instantml_api_key", status, "INSTANTML_API_KEY is required before hosted ingestion")

    castform_key = os.environ.get("CASTFORM_API_KEY") or os.environ.get("PLATFORM_API_KEY")
    if castform_run_ids and castform_key:
        check(statuses, "castform_api_key", "ok", "Castform API key is present for live mirror mode", run_ids=len(castform_run_ids))
    elif castform_run_ids:
        status = "warn" if allow_missing else "fail"
        check(statuses, "castform_api_key", status, "CASTFORM_API_KEY or PLATFORM_API_KEY is required with --castform-run-id", run_ids=len(castform_run_ids))
    else:
        check(statuses, "castform_api_key", "skip", "no live Castform run IDs requested; deterministic fallback can be used")


def write_report(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check hosted Castform demo readiness without writing data")
    parser.add_argument("--api-base-url", default=os.environ.get("INSTANTML_API_BASE_URL", DEFAULT_API_BASE_URL))
    parser.add_argument("--instantml-web-base-url", default=os.environ.get("INSTANTML_WEB_BASE_URL", DEFAULT_INSTANTML_WEB_BASE_URL))
    parser.add_argument("--parent-origin", default=os.environ.get("CASTFORM_DEMO_PARENT_ORIGIN"))
    parser.add_argument("--parent-url", help="Optional HTTPS parent page URL to fetch after a tunnel is running")
    parser.add_argument("--project", default=os.environ.get("CASTFORM_DEMO_PROJECT", DEFAULT_PROJECT))
    parser.add_argument("--castform-run-id", action="append", default=[])
    parser.add_argument("--allow-missing-live-inputs", action="store_true", help="Downgrade missing secrets/origin to warnings for dry preflight")
    parser.add_argument("--skip-network", action="store_true", help="Skip hosted InstantML network checks")
    parser.add_argument("--require-hosted-embeds", action="store_true", help="Fail if the hosted embed-session API route is not deployed")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    statuses: list[dict[str, Any]] = []
    report = {
        "ok": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project": args.project,
        "api_base_url": args.api_base_url,
        "instantml_web_base_url": args.instantml_web_base_url,
        "parent_origin": None,
        "checks": statuses,
    }

    parent_origin = check_parent_origin(statuses, args.parent_origin, allow_missing=args.allow_missing_live_inputs)
    report["parent_origin"] = parent_origin
    check_live_secrets(statuses, allow_missing=args.allow_missing_live_inputs, castform_run_ids=args.castform_run_id)
    check_python_sdk(statuses)
    check_benchmax(statuses, required=bool(args.castform_run_id))
    check_node_and_playwright(statuses, timeout=args.timeout)
    check_ignored_paths(statuses, timeout=args.timeout)
    check_api_health(statuses, args.api_base_url, timeout=args.timeout, skip_network=args.skip_network)
    check_hosted_embed_route(
        statuses,
        args.api_base_url,
        timeout=args.timeout,
        skip_network=args.skip_network,
        required=args.require_hosted_embeds,
    )
    check_parent_page(statuses, args.parent_url, timeout=args.timeout)

    failures = [item for item in statuses if item["status"] == "fail"]
    warnings = [item for item in statuses if item["status"] == "warn"]
    skipped = [item for item in statuses if item["status"] == "skip"]
    passed = [item for item in statuses if item["status"] == "ok"]
    report["ok"] = not failures
    report["summary"] = {
        "ok": len(passed),
        "warn": len(warnings),
        "skip": len(skipped),
        "fail": len(failures),
        "total": len(statuses),
    }
    write_report(args.report, report)
    for item in statuses:
        print(f"{item['status']}: {item['name']}: {item['message']}")
    print(f"wrote readiness report: {args.report}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
