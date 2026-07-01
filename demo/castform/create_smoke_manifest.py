#!/usr/bin/env python3
"""Write a local Castform demo manifest for browser smoke verification."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from run_demo import (
    CASTFORM_APP_HOME,
    DEFAULT_MANIFEST,
    DEFAULT_SUMMARY,
    MirroredRun,
    build_manifest,
    redact_iframe_src,
    redacted_manifest,
    write_json,
)


DEFAULT_PARENT_ORIGIN = "http://127.0.0.1:5174"


def smoke_runs() -> list[MirroredRun]:
    return [
        MirroredRun(
            instantml_run_id="run_smoke_balanced",
            castform_run_id="castform-smoke-001",
            castform_url=f"{CASTFORM_APP_HOME.rstrip('/')}/train/castform-smoke-001",
            name="castform-smoke-balanced",
            profile_slug="company-docs-rag-balanced",
            title="company docs search (rag) - balanced",
            tags=["castform", "rag", "candidate", "best"],
            model="Qwen/Qwen3.5-4B",
            baseline_model="gpt-5.4-nano",
            learning_rate=0.00001,
            group_size=9,
            environment="CompanyDocsSearchEnv",
            dataset="company-docs-search-synth-v3",
            reward_version="rag-reward-v2",
            final_metrics={
                "eval/reward_mean": 0.842,
                "eval/solve_rate": 0.887,
                "train/response_tokens_mean": 721.4,
            },
        ),
        MirroredRun(
            instantml_run_id="run_smoke_overfit",
            castform_run_id="castform-smoke-002",
            castform_url=f"{CASTFORM_APP_HOME.rstrip('/')}/train/castform-smoke-002",
            name="castform-smoke-overfit",
            profile_slug="company-docs-rag-fast-overfit",
            title="company docs search (rag) - fast overfit",
            tags=["castform", "rag", "candidate", "overfit"],
            model="Qwen/Qwen3.5-4B",
            baseline_model="gpt-5.4-nano",
            learning_rate=0.00003,
            group_size=9,
            environment="CompanyDocsSearchEnv",
            dataset="company-docs-search-synth-v3",
            reward_version="rag-reward-v2",
            final_metrics={
                "eval/reward_mean": 0.713,
                "eval/solve_rate": 0.701,
                "train/response_tokens_mean": 836.9,
            },
        ),
        MirroredRun(
            instantml_run_id="run_smoke_verbose",
            castform_run_id="castform-smoke-003",
            castform_url=f"{CASTFORM_APP_HOME.rstrip('/')}/train/castform-smoke-003",
            name="castform-smoke-verbose",
            profile_slug="customer-support-traces-verbose",
            title="customer support (traces) - verbose regression",
            tags=["castform", "traces", "candidate", "verbose-regression"],
            model="Qwen/Qwen3.5-4B",
            baseline_model="gpt-5.4-nano",
            learning_rate=0.00001,
            group_size=6,
            environment="CustomerSupportTraceEnv",
            dataset="support-trace-replay-v1",
            reward_version="trace-reward-v4",
            final_metrics={
                "eval/reward_mean": 0.761,
                "eval/solve_rate": 0.742,
                "train/response_tokens_mean": 1186.2,
            },
        ),
    ]


def smoke_sessions(parent_origin: str, generated_at: datetime) -> list[dict[str, object]]:
    expires_at = (generated_at + timedelta(hours=1)).isoformat()
    groups = [
        (
            "overview",
            "All Castform candidates",
            "Local browser smoke for the full Castform candidate set.",
            ["run_smoke_balanced", "run_smoke_overfit", "run_smoke_verbose"],
        ),
        (
            "winner-vs-overfit",
            "Best vs overfit",
            "Local browser smoke for the balanced run against overfit behavior.",
            ["run_smoke_balanced", "run_smoke_overfit"],
        ),
        (
            "winner-vs-verbose",
            "Best vs verbose regression",
            "Local browser smoke for the balanced run against response-length drift.",
            ["run_smoke_balanced", "run_smoke_verbose"],
        ),
    ]
    sessions: list[dict[str, object]] = []
    for index, (key, label, description, run_ids) in enumerate(groups, start=1):
        token = f"instantml_{'embed'}_local_smoke_{generated_at.strftime('%Y%m%d%H%M%S')}_{index}"
        iframe_src = f"about:blank#token={token}"
        sessions.append(
            {
                "key": key,
                "label": label,
                "description": description,
                "id": f"session-smoke-{index:02d}",
                "expires_at": expires_at,
                "allowed_parent_origin": parent_origin,
                "run_count": len(run_ids),
                "run_ids": run_ids,
                "iframe_src": iframe_src,
                "redacted_iframe_src": redact_iframe_src(iframe_src),
                "warnings": ["local smoke manifest uses about:blank iframe targets"],
            }
        )
    return sessions


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a local Castform demo smoke manifest")
    parser.add_argument("--parent-origin", default=DEFAULT_PARENT_ORIGIN)
    parser.add_argument("--project", default="castform-browser-smoke")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    generated_at = datetime.now(timezone.utc)
    runs = smoke_runs()
    manifest = build_manifest(
        project=args.project,
        api_base_url="http://127.0.0.1:8000",
        instantml_web_base_url="http://127.0.0.1:5174",
        parent_origin=args.parent_origin,
        runs=runs,
        sessions=smoke_sessions(args.parent_origin, generated_at),
    )
    manifest["generated_at"] = generated_at.isoformat()
    manifest["castform"]["source"] = "local browser smoke manifest"
    write_json(args.manifest, manifest)
    write_json(args.summary, redacted_manifest(manifest))
    print(f"Wrote smoke manifest: {args.manifest}")
    print(f"Wrote redacted smoke summary: {args.summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
