#!/usr/bin/env python3
"""Verify Castform demo manifests without exposing embed tokens."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "web" / "public" / "demo-manifest.json"
DEFAULT_SUMMARY = HERE / "run-output" / "latest-summary.json"
LIVE_EMBED_TOKEN_RE = re.compile(r"instantml_embed_(?!redacted\b)[A-Za-z0-9_-]+")


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise VerificationError(f"missing file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise VerificationError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise VerificationError(f"{path} must contain a JSON object")
    return payload


class VerificationError(RuntimeError):
    pass


def verify_manifest(manifest: dict[str, Any], *, hosted: bool, allow_blocked_embeds: bool = False) -> list[str]:
    notes: list[str] = []
    if manifest.get("schema_version") != 1:
        raise VerificationError("manifest schema_version must be 1")
    project = _string(manifest.get("project"), "project")
    if not project:
        raise VerificationError("manifest project is required")
    parent_origin = normalize_origin(_string(manifest.get("parent_origin"), "parent_origin"), hosted=hosted)
    runs = _list(manifest.get("runs"), "runs")
    sessions = _list(manifest.get("embed_sessions"), "embed_sessions")
    if not runs:
        raise VerificationError("manifest must include at least one run")
    embeds_blocked = not sessions and _dict(manifest.get("embed_status")).get("status") == "blocked"
    if not sessions and not (allow_blocked_embeds and embeds_blocked):
        raise VerificationError("manifest must include at least one embed session")
    run_ids = {_string(run.get("instantml_run_id"), "run.instantml_run_id") for run in runs if isinstance(run, dict)}
    if len(run_ids) != len(runs):
        raise VerificationError("each run must include a unique instantml_run_id")
    for session in sessions:
        if not isinstance(session, dict):
            raise VerificationError("each embed session must be an object")
        session_key = _string(session.get("key"), "embed_session.key")
        session_id = _string(session.get("id"), f"{session_key}.id")
        iframe_src = _string(session.get("iframe_src"), f"{session_key}.iframe_src")
        redacted = _string(session.get("redacted_iframe_src"), f"{session_key}.redacted_iframe_src")
        if not session_id:
            raise VerificationError(f"{session_key} is missing id")
        if not LIVE_EMBED_TOKEN_RE.search(iframe_src):
            raise VerificationError(f"{session_key} iframe_src is missing an embed token fragment")
        if "instantml_embed_redacted" not in redacted:
            raise VerificationError(f"{session_key} redacted_iframe_src must redact the embed token")
        if redacted == iframe_src:
            raise VerificationError(f"{session_key} redacted_iframe_src still matches the live iframe_src")
        if LIVE_EMBED_TOKEN_RE.search(redacted):
            raise VerificationError(f"{session_key} redacted_iframe_src appears to include a live token")
        if session.get("allowed_parent_origin") != parent_origin:
            raise VerificationError(f"{session_key} allowed_parent_origin does not match manifest parent_origin")
        session_runs = _list(session.get("run_ids"), f"{session_key}.run_ids")
        if not session_runs:
            raise VerificationError(f"{session_key} must include at least one run id")
        unknown = [run_id for run_id in session_runs if run_id not in run_ids]
        if unknown:
            raise VerificationError(f"{session_key} references unknown run IDs")
    notes.append(f"project={project}")
    notes.append(f"runs={len(runs)}")
    notes.append(f"embed_sessions={len(sessions)}")
    if embeds_blocked:
        notes.append("embed_status=blocked")
    notes.append(f"parent_origin={parent_origin}")
    return notes


def verify_summary(summary: dict[str, Any], *, allow_blocked_embeds: bool = False) -> list[str]:
    encoded = json.dumps(summary, sort_keys=True)
    if LIVE_EMBED_TOKEN_RE.search(encoded):
        raise VerificationError("summary appears to contain a live embed token")
    if "instantml_embed_redacted" not in encoded:
        embeds_blocked = not summary.get("embed_sessions") and _dict(summary.get("embed_status")).get("status") == "blocked"
        if allow_blocked_embeds and embeds_blocked:
            return ["blocked_summary=ok"]
        raise VerificationError("summary does not include redacted embed URLs")
    return ["redacted_summary=ok"]


def check_parent_page(parent_url: str, *, timeout: float) -> list[str]:
    request = urllib.request.Request(parent_url, headers={"Accept": "text/html"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(256_000).decode("utf-8", errors="replace")
            final_url = response.geturl()
    except urllib.error.HTTPError as exc:
        detail = exc.read(512).decode("utf-8", errors="replace")
        raise VerificationError(f"parent page returned {exc.code}: {detail}") from exc
    except OSError as exc:
        raise VerificationError(f"parent page fetch failed: {exc}") from exc
    if "Tunnel website ahead" in body:
        raise VerificationError("parent page is behind a localtunnel browser warning")
    expected_markers = (
        "Castform InstantML Demo",
        "Loading Castform demo manifest",
        "Castform InstantML demo page",
        "Castform -> InstantML",
    )
    if not any(marker in body for marker in expected_markers):
        raise VerificationError("parent page did not look like the Castform demo")
    return [f"parent_page={final_url}"]


def normalize_origin(raw: str, *, hosted: bool) -> str:
    parsed = urllib.parse.urlsplit(raw.strip())
    if not parsed.scheme or not parsed.netloc:
        raise VerificationError("parent_origin must be a bare origin")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise VerificationError("parent_origin must not include path, query, fragment, or credentials")
    host = parsed.hostname or ""
    if hosted:
        if parsed.scheme != "https":
            raise VerificationError("hosted manifests require HTTPS parent_origin")
        lower = host.lower()
        if lower == "instantml.ai" or lower.endswith(".instantml.ai") or lower == "instantml.com" or lower.endswith(".instantml.com"):
            raise VerificationError("hosted manifests cannot use an InstantML-owned parent_origin")
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{host}{port}"


def _string(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise VerificationError(f"{name} must be a string")
    return value


def _list(value: Any, name: str) -> list[Any]:
    if not isinstance(value, list):
        raise VerificationError(f"{name} must be a list")
    return value


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify Castform demo generated artifacts")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--local", action="store_true", help="Allow local non-HTTPS parent origins")
    parser.add_argument("--allow-blocked-embeds", action="store_true", help="Allow a blocked hosted-embed manifest with persisted runs and zero sessions")
    parser.add_argument("--parent-url", help="Optional parent page URL to fetch")
    parser.add_argument("--timeout", type=float, default=10.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    hosted = not args.local
    notes = verify_manifest(load_json(args.manifest), hosted=hosted, allow_blocked_embeds=args.allow_blocked_embeds)
    if args.summary.exists():
        notes.extend(verify_summary(load_json(args.summary), allow_blocked_embeds=args.allow_blocked_embeds))
    else:
        notes.append(f"summary_missing={args.summary}")
    if args.parent_url:
        notes.extend(check_parent_page(args.parent_url, timeout=args.timeout))
    for note in notes:
        print(note)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as exc:
        print(f"verification failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
