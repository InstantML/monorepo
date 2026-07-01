#!/usr/bin/env python3
"""Run the hosted Castform -> InstantML iframe demo.

This script writes Castform-shaped training observations into InstantML using
the real InstantML Python SDK, then creates read-only iframe embed sessions for
the generated runs. The Castform side is a deterministic local trainer fallback
that mirrors the public Castform workflow shape: setup, launch, monitor, and
compare training runs.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
LOCAL_SDK = REPO_ROOT / "packages" / "python-sdk"
if LOCAL_SDK.exists():
    sys.path.insert(0, str(LOCAL_SDK))

DEFAULT_API_BASE_URL = "https://api.instantml.ai"
DEFAULT_INSTANTML_WEB_BASE_URL = "https://instantml.ai"
DEFAULT_PROJECT = "castform-live-demo"
DEFAULT_MANIFEST = HERE / "web" / "public" / "demo-manifest.json"
DEFAULT_SUMMARY = HERE / "run-output" / "latest-summary.json"
CASTFORM_APP_HOME = "https://app.castform.com/home"


@dataclass(frozen=True)
class CastformTrainingSpec:
    slug: str
    title: str
    castform_run_id: str
    environment: str
    model: str
    baseline_model: str
    learning_rate: float
    group_size: int
    batch_size: int
    max_turns: int
    lora_rank: int
    reward_version: str
    dataset: str
    tags: list[str]
    reward_ceiling: float
    solve_ceiling: float
    eval_gap: float
    length_drift: float
    stability: float
    seed: int


@dataclass(frozen=True)
class CastformStepEvent:
    step: int
    metrics: dict[str, float]
    lifecycle_events: list[str]
    environment_logs: list[str]


@dataclass
class MirroredRun:
    instantml_run_id: str
    castform_run_id: str
    castform_url: str
    name: str
    profile_slug: str
    title: str
    tags: list[str]
    model: str
    baseline_model: str
    learning_rate: float
    group_size: int
    environment: str
    dataset: str
    reward_version: str
    final_metrics: dict[str, float]


class LocalCastformTrainer:
    """Small Castform SDK-shaped trainer used when live Castform launch is unavailable."""

    def launch_training_run(
        self,
        spec: CastformTrainingSpec,
        *,
        steps: int,
        step_size: int,
    ) -> list[CastformStepEvent]:
        rng = random.Random(spec.seed)
        events: list[CastformStepEvent] = []
        for step in range(0, steps + 1, step_size):
            progress = step / max(1, steps)
            train_reward = _learning_curve(step, ceiling=spec.reward_ceiling, speed=steps * 0.34, rng=rng, noise=0.020)
            solve_rate = _learning_curve(step, ceiling=spec.solve_ceiling, speed=steps * 0.29, rng=rng, noise=0.018)
            eval_penalty = spec.eval_gap
            if "overfit" in spec.tags and progress > 0.48:
                eval_penalty += 0.10 + (progress - 0.48) * 0.18
            eval_reward = max(0.0, min(1.0, train_reward - eval_penalty + rng.uniform(-0.015, 0.015)))
            eval_solve = max(0.0, min(1.0, solve_rate - eval_penalty + rng.uniform(-0.018, 0.018)))

            response_tokens = 860 + (210 * math.exp(-step / max(1, steps * 0.45))) + spec.length_drift * step
            response_tokens += rng.uniform(-18.0, 18.0)
            response_tokens = max(180.0, response_tokens)

            correctness = max(0.0, min(1.0, train_reward + rng.uniform(-0.018, 0.018)))
            citation = max(0.0, min(1.0, train_reward - 0.08 + rng.uniform(-0.024, 0.024)))
            search_efficiency = max(0.0, min(1.0, 1.0 - response_tokens / 1500.0 + rng.uniform(-0.025, 0.025)))
            kl = max(0.003, 0.042 * math.exp(-step / max(1, steps * 0.30)) + rng.uniform(-0.002, 0.002))
            policy_loss = -0.012 - (train_reward * 0.035) + rng.uniform(-0.006, 0.006)

            lifecycle_events = []
            environment_logs = []
            if step == 0:
                lifecycle_events.extend(
                    [
                        "castform.setup.completed",
                        "castform.launch.accepted",
                        "training.gpu_warmup",
                    ]
                )
                environment_logs.append(f"{spec.environment}: synthetic dataset attached from {spec.dataset}")
            if step and step % max(step_size, steps // 4) == 0:
                lifecycle_events.append(f"training.eval_checkpoint.step_{step}")
                environment_logs.append(
                    f"reward breakdown correctness={correctness:.3f} citation={citation:.3f} search_efficiency={search_efficiency:.3f}"
                )
            if step == steps:
                lifecycle_events.extend(["training.completed", "model.candidate.ready"])
                environment_logs.append(f"final solve_rate={eval_solve:.3f} response_tokens={response_tokens:.0f}")

            events.append(
                CastformStepEvent(
                    step=step,
                    metrics={
                        "train/reward_mean": train_reward,
                        "train/reward_max": min(1.0, train_reward + 0.10 + rng.uniform(0.0, 0.025)),
                        "train/solve_rate": solve_rate,
                        "train/response_tokens_mean": response_tokens,
                        "train/kl": kl,
                        "train/policy_loss": policy_loss,
                        "eval/reward_mean": eval_reward,
                        "eval/reward_max": min(1.0, eval_reward + 0.09 + rng.uniform(0.0, 0.020)),
                        "eval/solve_rate": eval_solve,
                        "eval/response_tokens_mean": response_tokens * (1.0 + rng.uniform(-0.025, 0.025)),
                        "train/reward_components/correctness/mean": correctness,
                        "train/reward_components/citation/mean": citation,
                        "train/reward_components/search_efficiency/mean": search_efficiency,
                        "eval/reward_components/correctness/mean": max(0.0, correctness - eval_penalty),
                        "eval/reward_components/citation/mean": max(0.0, citation - eval_penalty),
                        "eval/reward_components/search_efficiency/mean": search_efficiency,
                    },
                    lifecycle_events=lifecycle_events,
                    environment_logs=environment_logs,
                )
            )
        return events


def _learning_curve(step: int, *, ceiling: float, speed: float, rng: random.Random, noise: float) -> float:
    value = ceiling * (1.0 - math.exp(-step / max(1.0, speed)))
    return max(0.0, min(1.0, value + rng.uniform(-noise, noise)))


def _profiles(count: int) -> list[CastformTrainingSpec]:
    base = [
        CastformTrainingSpec(
            slug="company-docs-rag-balanced",
            title="company docs search (rag) - balanced",
            castform_run_id="demo-company-docs-rag-001",
            environment="CompanyDocsSearchEnv",
            model="Qwen/Qwen3.5-4B",
            baseline_model="gpt-5.4-nano",
            learning_rate=1e-5,
            group_size=9,
            batch_size=14,
            max_turns=6,
            lora_rank=128,
            reward_version="rag-reward-v2",
            dataset="company-docs-search-synth-v3",
            tags=["castform", "rag", "candidate", "best"],
            reward_ceiling=0.88,
            solve_ceiling=0.90,
            eval_gap=0.035,
            length_drift=-0.14,
            stability=0.92,
            seed=1101,
        ),
        CastformTrainingSpec(
            slug="company-docs-rag-fast-overfit",
            title="company docs search (rag) - fast overfit",
            castform_run_id="demo-company-docs-rag-002",
            environment="CompanyDocsSearchEnv",
            model="Qwen/Qwen3.5-4B",
            baseline_model="gpt-5.4-nano",
            learning_rate=3e-5,
            group_size=9,
            batch_size=14,
            max_turns=6,
            lora_rank=128,
            reward_version="rag-reward-v2",
            dataset="company-docs-search-synth-v3",
            tags=["castform", "rag", "candidate", "overfit"],
            reward_ceiling=0.94,
            solve_ceiling=0.93,
            eval_gap=0.12,
            length_drift=-0.04,
            stability=0.63,
            seed=1102,
        ),
        CastformTrainingSpec(
            slug="customer-support-traces-verbose",
            title="customer support (traces) - verbose regression",
            castform_run_id="demo-support-traces-003",
            environment="CustomerSupportTraceEnv",
            model="Qwen/Qwen3.5-4B",
            baseline_model="gpt-5.4-nano",
            learning_rate=1e-5,
            group_size=6,
            batch_size=12,
            max_turns=8,
            lora_rank=96,
            reward_version="trace-reward-v4",
            dataset="support-trace-replay-v1",
            tags=["castform", "traces", "candidate", "verbose-regression"],
            reward_ceiling=0.80,
            solve_ceiling=0.78,
            eval_gap=0.075,
            length_drift=0.58,
            stability=0.70,
            seed=1103,
        ),
        CastformTrainingSpec(
            slug="company-docs-rag-sparse-reward",
            title="company docs search (rag) - sparse reward",
            castform_run_id="demo-company-docs-rag-004",
            environment="CompanyDocsSearchEnv",
            model="Qwen/Qwen3.5-8B",
            baseline_model="gpt-5.4-nano",
            learning_rate=8e-6,
            group_size=9,
            batch_size=10,
            max_turns=6,
            lora_rank=128,
            reward_version="rag-reward-v1-sparse",
            dataset="company-docs-search-synth-v2",
            tags=["castform", "rag", "candidate", "sparse-reward"],
            reward_ceiling=0.61,
            solve_ceiling=0.58,
            eval_gap=0.060,
            length_drift=0.06,
            stability=0.74,
            seed=1104,
        ),
        CastformTrainingSpec(
            slug="company-docs-rag-larger-model",
            title="company docs search (rag) - larger model",
            castform_run_id="demo-company-docs-rag-005",
            environment="CompanyDocsSearchEnv",
            model="Qwen/Qwen3.5-8B",
            baseline_model="gpt-5.4-nano",
            learning_rate=7e-6,
            group_size=9,
            batch_size=8,
            max_turns=6,
            lora_rank=128,
            reward_version="rag-reward-v2",
            dataset="company-docs-search-synth-v3",
            tags=["castform", "rag", "candidate", "larger-model"],
            reward_ceiling=0.84,
            solve_ceiling=0.86,
            eval_gap=0.045,
            length_drift=-0.08,
            stability=0.85,
            seed=1105,
        ),
    ]
    selected = []
    for index in range(count):
        spec = base[index % len(base)]
        if index >= len(base):
            round_number = index // len(base) + 1
            spec = replace(
                spec,
                slug=f"{spec.slug}-round-{round_number}",
                title=f"{spec.title} round {round_number}",
                castform_run_id=f"{spec.castform_run_id}-round-{round_number}",
                seed=spec.seed + (round_number * 100),
            )
        selected.append(spec)
    return selected


def mirror_training_runs(
    *,
    api_key: str,
    api_base_url: str,
    project: str,
    run_count: int,
    steps: int,
    step_size: int,
    stream_delay: float,
) -> list[MirroredRun]:
    import instantml as im

    trainer = LocalCastformTrainer()
    mirrored: list[MirroredRun] = []
    for spec in _profiles(run_count):
        events = trainer.launch_training_run(spec, steps=steps, step_size=step_size)
        run_name = f"castform-{spec.slug}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        notes = (
            "Hosted Castform collaboration demo run.\n"
            f"Castform app: {CASTFORM_APP_HOME}\n"
            f"Source run placeholder: {castform_run_url(spec.castform_run_id)}\n"
            "The Castform-side trainer is a deterministic SDK-shaped fallback for call prep."
        )
        config = {
            "castform": {
                "run_id": spec.castform_run_id,
                "run_url": castform_run_url(spec.castform_run_id),
                "app_home": CASTFORM_APP_HOME,
                "workflow": ["uv tool install -U castform", "castform setup", "castform launch"],
                "source": "local Castform SDK-shaped fallback",
                "mirrored_at": datetime.now(timezone.utc).isoformat(),
            },
            "launcher_args": {
                "model": spec.model,
                "baseline_model": spec.baseline_model,
                "learning_rate": spec.learning_rate,
                "num_epochs": 5,
                "batch_size": spec.batch_size,
                "group_size": spec.group_size,
                "max_rollout_len": 4000,
                "max_turns": spec.max_turns,
                "lora_rank": spec.lora_rank,
                "lora_alpha": spec.lora_rank * 2,
            },
            "environment": {
                "name": spec.environment,
                "dataset": spec.dataset,
                "reward_version": spec.reward_version,
            },
        }
        print(f"Launching Castform-shaped run: {spec.title}")
        run = im.init(
            project=project,
            name=run_name,
            config=config,
            tags=spec.tags,
            notes=notes,
            base_url=api_base_url,
            api_key=api_key,
            upload_mode="sync",
            async_init=False,
            source_tracking=False,
            system_metrics=False,
        )
        final_metrics: dict[str, float] = {}
        try:
            for event in events:
                run.log(event.metrics, step=event.step)
                final_metrics = event.metrics
                if event.lifecycle_events:
                    run.log_text({"castform/lifecycle": "\n".join(event.lifecycle_events)}, step=event.step)
                if event.environment_logs:
                    run.log_text({"castform/environment_logs": "\n".join(event.environment_logs)}, step=event.step)
                    run.log_stdout([f"{spec.castform_run_id} {line}" for line in event.environment_logs])
                if stream_delay > 0:
                    time.sleep(stream_delay)
            run.finish(status="finished")
        except Exception:
            run.finish(status="failed")
            raise
        mirrored.append(
            MirroredRun(
                instantml_run_id=run.run_id,
                castform_run_id=spec.castform_run_id,
                castform_url=castform_run_url(spec.castform_run_id),
                name=run_name,
                profile_slug=spec.slug,
                title=spec.title,
                tags=spec.tags,
                model=spec.model,
                baseline_model=spec.baseline_model,
                learning_rate=spec.learning_rate,
                group_size=spec.group_size,
                environment=spec.environment,
                dataset=spec.dataset,
                reward_version=spec.reward_version,
                final_metrics={key: round(value, 6) for key, value in final_metrics.items()},
            )
        )
        print(f"  InstantML run: {run.run_id}")
    return mirrored


def mirror_existing_castform_runs(
    *,
    castform_run_ids: list[str],
    instantml_api_key: str,
    instantml_api_base_url: str,
    instantml_project: str,
    castform_api_key: str,
    castform_base_url: str | None,
    include_logs: bool,
) -> list[MirroredRun]:
    from castform_instantml_adapter import mirror_castform_run

    mirrored: list[MirroredRun] = []
    for castform_run_id in castform_run_ids:
        print(f"Mirroring live Castform run: {castform_run_id}")
        summary = mirror_castform_run(
            castform_run_id=castform_run_id,
            instantml_project=instantml_project,
            castform_api_key=castform_api_key,
            instantml_api_key=instantml_api_key,
            castform_base_url=castform_base_url,
            instantml_base_url=instantml_api_base_url,
            include_logs=include_logs,
            dry_run=False,
        )
        instantml_run_id = str(summary.get("instantml_run_id") or "")
        if not instantml_run_id:
            raise RuntimeError(f"Castform run {castform_run_id} did not produce an InstantML run ID")
        launcher_args = summary.get("launcher_args") if isinstance(summary.get("launcher_args"), dict) else {}
        final_metrics = summary.get("final_metrics") if isinstance(summary.get("final_metrics"), dict) else {}
        mirrored.append(
            MirroredRun(
                instantml_run_id=instantml_run_id,
                castform_run_id=castform_run_id,
                castform_url=str(summary.get("castform_url") or castform_run_url(castform_run_id)),
                name=str(summary.get("name") or f"castform-{castform_run_id}"),
                profile_slug=f"live-{castform_run_id}",
                title=str(summary.get("name") or f"Live Castform run {castform_run_id}"),
                tags=["castform", "mirrored", "live"],
                model=str(launcher_args.get("model") or launcher_args.get("base_model") or "Castform model"),
                baseline_model=str(launcher_args.get("baseline_model") or "n/a"),
                learning_rate=float(launcher_args.get("learning_rate") or 0.0),
                group_size=int(launcher_args.get("group_size") or 0),
                environment=str(launcher_args.get("environment") or "Castform environment"),
                dataset=str(launcher_args.get("dataset") or "Castform dataset"),
                reward_version=str(launcher_args.get("reward_version") or "Castform reward"),
                final_metrics={str(key): float(value) for key, value in final_metrics.items() if isinstance(value, (int, float))},
            )
        )
        print(f"  InstantML mirror run: {instantml_run_id}")
    return mirrored


def mirror_existing_instantml_runs(
    *,
    instantml_run_ids: list[str],
    api_key: str,
    api_base_url: str,
    project: str,
    timeout: float,
) -> list[MirroredRun]:
    mirrored: list[MirroredRun] = []
    for run_id in instantml_run_ids:
        print(f"Reusing existing InstantML run: {run_id}")
        query = urllib.parse.urlencode({"project": project, "q": f"id:{run_id}", "limit": 10})
        payload = http_json(
            "GET",
            f"/api/runs/summary?{query}",
            api_base_url=api_base_url,
            api_key=api_key,
            timeout=timeout,
        )
        rows = payload.get("runs")
        if not isinstance(rows, list):
            raise RuntimeError("InstantML run summary response did not include a runs array")
        row = next((candidate for candidate in rows if isinstance(candidate, dict) and str(candidate.get("id")) == run_id), None)
        if row is None:
            raise RuntimeError(f"InstantML run {run_id} was not found in project {project}")
        mirrored.append(mirrored_run_from_summary(row))
    return mirrored


def mirrored_run_from_summary(row: dict[str, Any]) -> MirroredRun:
    config = _dict(row.get("config"))
    castform = _dict(config.get("castform"))
    launcher_args = _dict(config.get("launcher_args"))
    environment = _dict(config.get("environment"))
    run_id = str(row.get("id") or "")
    name = str(row.get("name") or run_id)
    castform_run_id = str(castform.get("run_id") or f"instantml-{run_id}")
    profile_spec = next((spec for spec in _profiles(5) if spec.castform_run_id == castform_run_id), None)
    profile_slug = profile_spec.slug if profile_spec else infer_profile_slug(name, castform_run_id)
    title = profile_spec.title if profile_spec else infer_title(name, profile_slug)
    tags = [str(tag) for tag in row.get("tags") or [] if isinstance(tag, str)]
    castform_url = str(castform.get("run_url") or "")
    if not castform_url:
        castform_url = castform_run_url(castform_run_id) if not castform_run_id.startswith("instantml-") else CASTFORM_APP_HOME
    final_metrics = numeric_metrics(_dict(row.get("latest_metrics")))
    if not final_metrics:
        aggregates = _dict(row.get("metric_aggregates"))
        final_metrics = {
            str(key): round(float(value["latest"]), 6)
            for key, value in aggregates.items()
            if isinstance(value, dict) and isinstance(value.get("latest"), (int, float))
        }
    model = launcher_args.get("model") or (profile_spec.model if profile_spec else "Castform model")
    baseline_model = launcher_args.get("baseline_model") or (profile_spec.baseline_model if profile_spec else "n/a")
    learning_rate = safe_float(launcher_args.get("learning_rate"), profile_spec.learning_rate if profile_spec else 0.0)
    group_size = safe_int(launcher_args.get("group_size"), profile_spec.group_size if profile_spec else 0)
    return MirroredRun(
        instantml_run_id=run_id,
        castform_run_id=castform_run_id,
        castform_url=castform_url,
        name=name,
        profile_slug=profile_slug,
        title=title,
        tags=tags,
        model=str(model),
        baseline_model=str(baseline_model),
        learning_rate=learning_rate,
        group_size=group_size,
        environment=str(environment.get("name") or (profile_spec.environment if profile_spec else "Castform environment")),
        dataset=str(environment.get("dataset") or (profile_spec.dataset if profile_spec else "Castform dataset")),
        reward_version=str(environment.get("reward_version") or (profile_spec.reward_version if profile_spec else "Castform reward")),
        final_metrics=final_metrics,
    )


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def numeric_metrics(value: dict[str, Any]) -> dict[str, float]:
    return {
        str(key): round(float(metric), 6)
        for key, metric in value.items()
        if isinstance(metric, (int, float)) and not isinstance(metric, bool)
    }


def safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def infer_profile_slug(name: str, castform_run_id: str) -> str:
    if name.startswith("castform-"):
        slug = name.removeprefix("castform-")
        slug = re.sub(r"-\d{8}-\d{6}$", "", slug)
        if slug:
            return slug
    return castform_run_id


def infer_title(name: str, profile_slug: str) -> str:
    if name and name != profile_slug:
        return name
    return profile_slug.replace("-", " ")


def create_embed_sessions(
    *,
    api_key: str,
    api_base_url: str,
    instantml_web_base_url: str,
    parent_origin: str,
    runs: list[MirroredRun],
    timeout: float,
) -> list[dict[str, Any]]:
    groups = _embed_groups(runs)
    sessions = []
    for group in groups:
        body = {
            "run_ids": group["run_ids"],
            "allowed_parent_origin": parent_origin,
            "ttl_seconds": 3600,
            "options": {
                "metric_point_limit": 500,
                "max_panels": 8,
                "theme": "system",
            },
        }
        payload = http_json(
            "POST",
            "/api/embed/sessions",
            body,
            api_base_url=api_base_url,
            api_key=api_key,
            timeout=timeout,
        )
        embed_session = payload.get("embed_session")
        if not isinstance(embed_session, dict):
            raise RuntimeError("InstantML did not return an embed_session object")
        iframe_src = str(embed_session.get("iframe_src") or "")
        if instantml_web_base_url.rstrip("/") != DEFAULT_INSTANTML_WEB_BASE_URL:
            iframe_src = _rewrite_iframe_base(iframe_src, instantml_web_base_url)
        sessions.append(
            {
                "key": group["key"],
                "label": group["label"],
                "description": group["description"],
                "id": embed_session.get("id"),
                "expires_at": embed_session.get("expires_at"),
                "allowed_parent_origin": embed_session.get("allowed_parent_origin"),
                "run_count": embed_session.get("run_count"),
                "run_ids": group["run_ids"],
                "iframe_src": iframe_src,
                "redacted_iframe_src": redact_iframe_src(iframe_src),
                "warnings": payload.get("warnings") or [],
            }
        )
        print(f"Created embed session {group['key']}: {embed_session.get('id')}")
    return sessions


def _embed_groups(runs: list[MirroredRun]) -> list[dict[str, Any]]:
    if len(runs) == 1:
        return [
            {
                "key": "overview",
                "label": "Castform run",
                "description": "Read-only InstantML board for the mirrored Castform run.",
                "run_ids": [runs[0].instantml_run_id],
            }
        ]
    by_slug = {run.profile_slug: run for run in runs}
    best = by_slug.get("company-docs-rag-balanced") or runs[0]
    overfit = by_slug.get("company-docs-rag-fast-overfit") or runs[min(1, len(runs) - 1)]
    verbose = by_slug.get("customer-support-traces-verbose") or runs[min(2, len(runs) - 1)]
    groups = [
        {
            "key": "overview",
            "label": "All Castform candidates",
            "description": "Read-only InstantML comparison board for the Castform candidate set.",
            "run_ids": [run.instantml_run_id for run in runs],
        },
        {
            "key": "winner-vs-overfit",
            "label": "Best vs overfit",
            "description": "Balanced run compared against the high-learning-rate overfit candidate.",
            "run_ids": _unique([best.instantml_run_id, overfit.instantml_run_id]),
        },
        {
            "key": "winner-vs-verbose",
            "label": "Best vs verbose regression",
            "description": "Balanced run compared against the candidate with rising response length.",
            "run_ids": _unique([best.instantml_run_id, verbose.instantml_run_id]),
        },
    ]
    return [group for group in groups if group["run_ids"]]


def _unique(values: list[str]) -> list[str]:
    seen = set()
    out = []
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def http_json(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    api_base_url: str,
    api_key: str,
    timeout: float,
) -> dict[str, Any]:
    url = api_base_url.rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed with {exc.code}: {detail}") from exc
    decoded = json.loads(payload)
    if not isinstance(decoded, dict):
        raise RuntimeError(f"{method} {path} returned a non-object response")
    return decoded


def build_manifest(
    *,
    project: str,
    api_base_url: str,
    instantml_web_base_url: str,
    parent_origin: str,
    runs: list[MirroredRun],
    sessions: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project": project,
        "api_base_url": api_base_url,
        "instantml_web_base_url": instantml_web_base_url,
        "parent_origin": parent_origin,
        "castform": {
            "app_home": CASTFORM_APP_HOME,
            "workflow": ["uv tool install -U castform", "castform setup", "castform launch"],
            "example_source": "https://app.castform.com/train/f810d5f4-c234-4dd7-a8f1-31c64bca9c8c",
            "source": "live Castform mirror" if any("live" in run.tags for run in runs) else "local Castform SDK-shaped fallback",
        },
        "runs": [asdict(run) for run in runs],
        "embed_sessions": sessions,
        "metric_groups": [
            "train/reward_mean",
            "eval/reward_mean",
            "eval/solve_rate",
            "train/response_tokens_mean",
            "train/reward_components/correctness/mean",
            "train/reward_components/citation/mean",
            "train/reward_components/search_efficiency/mean",
        ],
        "notes": [
            "Manifest contains token-bearing iframe_src values and must stay local.",
            "The page displays only redacted URLs while passing iframe_src to iframe elements.",
        ],
    }


def redacted_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    safe = json.loads(json.dumps(manifest))
    for session in safe.get("embed_sessions", []):
        if isinstance(session, dict):
            session["iframe_src"] = redact_iframe_src(str(session.get("iframe_src") or ""))
    return safe


def redact_iframe_src(value: str) -> str:
    if "#token=" not in value:
        return value
    prefix, _token = value.split("#token=", 1)
    return f"{prefix}#token=instantml_embed_redacted"


def _rewrite_iframe_base(iframe_src: str, base_url: str) -> str:
    parsed = urllib.parse.urlsplit(iframe_src)
    replacement = urllib.parse.urlsplit(base_url.rstrip("/"))
    return urllib.parse.urlunsplit(
        (
            replacement.scheme,
            replacement.netloc,
            parsed.path,
            parsed.query,
            parsed.fragment,
        )
    )


def castform_run_url(run_id: str) -> str:
    return f"https://app.castform.com/train/{urllib.parse.quote(run_id, safe='')}"


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def validate_parent_origin(parent_origin: str, *, hosted: bool) -> str:
    parsed = urllib.parse.urlsplit(parent_origin.strip())
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit("--parent-origin must be a bare origin such as https://demo.example.com")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise SystemExit("--parent-origin must not include a path, query, fragment, or credentials")
    host = parsed.hostname or ""
    if hosted:
        if parsed.scheme != "https":
            raise SystemExit("hosted InstantML embeds require an HTTPS --parent-origin")
        lower = host.lower()
        if lower == "instantml.ai" or lower.endswith(".instantml.ai") or lower == "instantml.com" or lower.endswith(".instantml.com"):
            raise SystemExit("hosted InstantML embeds reject InstantML-owned parent origins")
    elif parsed.scheme != "https" and not (parsed.scheme == "http" and host in {"localhost", "127.0.0.1", "::1"}):
        raise SystemExit("local embeds require HTTPS or loopback HTTP --parent-origin")
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{host}{port}"


def is_hosted_api(api_base_url: str) -> bool:
    host = urllib.parse.urlsplit(api_base_url).hostname or ""
    return not (host in {"localhost", "127.0.0.1", "::1"} or host.startswith("192.168."))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the hosted Castform -> InstantML iframe demo")
    parser.add_argument("--api-base-url", default=os.environ.get("INSTANTML_API_BASE_URL", DEFAULT_API_BASE_URL))
    parser.add_argument("--instantml-web-base-url", default=os.environ.get("INSTANTML_WEB_BASE_URL", DEFAULT_INSTANTML_WEB_BASE_URL))
    parser.add_argument("--parent-origin", default=os.environ.get("CASTFORM_DEMO_PARENT_ORIGIN"))
    parser.add_argument("--project", default=os.environ.get("CASTFORM_DEMO_PROJECT", DEFAULT_PROJECT))
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--steps", type=int, default=240)
    parser.add_argument("--step-size", type=int, default=10)
    parser.add_argument("--stream-delay", type=float, default=0.0)
    parser.add_argument("--castform-run-id", action="append", default=[], help="Mirror an existing live Castform run ID instead of generating fallback runs")
    parser.add_argument("--instantml-run-id", action="append", default=[], help="Reuse an existing InstantML run ID and only mint iframe sessions")
    parser.add_argument("--castform-base-url", default=os.environ.get("CASTFORM_BASE_URL"))
    parser.add_argument("--no-castform-logs", action="store_true", help="Skip Castform environment logs in live mirror mode")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.runs < 1:
        raise SystemExit("--runs must be at least 1")
    if args.steps < 1 or args.step_size < 1:
        raise SystemExit("--steps and --step-size must be positive")
    hosted = is_hosted_api(args.api_base_url)
    parent_origin = args.parent_origin
    if not parent_origin:
        if hosted:
            raise SystemExit("--parent-origin is required for hosted InstantML embeds")
        parent_origin = "http://127.0.0.1:5174"
    parent_origin = validate_parent_origin(parent_origin, hosted=hosted)
    api_key = require_env("INSTANTML_API_KEY")

    if args.castform_run_id and args.instantml_run_id:
        raise SystemExit("--castform-run-id and --instantml-run-id cannot be used together")

    if args.instantml_run_id:
        runs = mirror_existing_instantml_runs(
            instantml_run_ids=args.instantml_run_id,
            api_key=api_key,
            api_base_url=args.api_base_url,
            project=args.project,
            timeout=args.timeout,
        )
    elif args.castform_run_id:
        castform_api_key = os.environ.get("CASTFORM_API_KEY") or os.environ.get("PLATFORM_API_KEY")
        if not castform_api_key:
            raise SystemExit("CASTFORM_API_KEY or PLATFORM_API_KEY is required with --castform-run-id")
        runs = mirror_existing_castform_runs(
            castform_run_ids=args.castform_run_id,
            instantml_api_key=api_key,
            instantml_api_base_url=args.api_base_url,
            instantml_project=args.project,
            castform_api_key=castform_api_key,
            castform_base_url=args.castform_base_url,
            include_logs=not args.no_castform_logs,
        )
    else:
        runs = mirror_training_runs(
            api_key=api_key,
            api_base_url=args.api_base_url,
            project=args.project,
            run_count=args.runs,
            steps=args.steps,
            step_size=args.step_size,
            stream_delay=args.stream_delay,
        )
    sessions = create_embed_sessions(
        api_key=api_key,
        api_base_url=args.api_base_url,
        instantml_web_base_url=args.instantml_web_base_url,
        parent_origin=parent_origin,
        runs=runs,
        timeout=args.timeout,
    )
    manifest = build_manifest(
        project=args.project,
        api_base_url=args.api_base_url,
        instantml_web_base_url=args.instantml_web_base_url,
        parent_origin=parent_origin,
        runs=runs,
        sessions=sessions,
    )
    write_json(args.manifest, manifest)
    write_json(args.summary, redacted_manifest(manifest))

    print("")
    print(f"Wrote local iframe manifest: {args.manifest}")
    print(f"Wrote redacted review summary: {args.summary}")
    print(f"Parent origin: {parent_origin}")
    print("Embed sessions:")
    for session in sessions:
        print(f"- {session['key']}: {session['id']} {session['redacted_iframe_src']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
