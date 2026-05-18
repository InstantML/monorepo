#!/usr/bin/env python3
"""Seed and benchmark W&B hosted cloud against InstantML hosted benchmarks.

This file intentionally lives under benchmarks/ because it is an external,
cost-incurring benchmark harness rather than product code. It never seeds
InstantML hosted ClickHouse; the InstantML subcommand only invokes the existing
read-only Cloud Run benchmark.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE_PROJECTS = ["hosted-scale-control", "hosted-scale-data"]
DEFAULT_METRIC_KEYS = [
    "eval/return_mean",
    "eval/success_rate",
    "train/loss",
    "train/reward_mean",
    "system/cpu_percent",
    "system/gpu_util",
]
DEFAULT_SEARCH_QUERY = "seed-13"
MANIFEST_VERSION = 1


@dataclass(frozen=True)
class SourceRun:
    index: int
    source_project: str
    run_id: str
    name: str
    source_status: str
    seed: int
    framework: str
    model: str
    optimizer: str
    accelerator: str
    accelerator_count: int
    notes: str
    tags: list[str]


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in os.environ:
            continue
        os.environ[key] = unquote(value.strip())


def unquote(value: str) -> str:
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    return value


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def source_status(index: int) -> str:
    if index % 197 == 0:
        return "failed"
    if index % 31 == 0:
        return "running"
    return "finished"


def source_run(index: int, projects: list[str]) -> SourceRun:
    project = projects[index % len(projects)]
    status = source_status(index)
    seed = index % 10_000
    model = "transformer" if index % 5 == 0 else "rl-policy"
    optimizer = "adamw" if index % 3 == 0 else "ppo"
    accelerator = "H100" if index % 7 == 0 else "A100"
    notes = f"split-service scale validation {project} cohort {index % 37}"
    tags = ["instantml-hosted-compare", "hosted-scale", project, f"seed-{index % 100}", status]
    return SourceRun(
        index=index,
        source_project=project,
        run_id=f"iml{index + 1:06d}",
        name=f"{project}-run-{index + 1:06d}",
        source_status=status,
        seed=seed,
        framework="torch" if index % 2 == 0 else "jax",
        model=model,
        optimizer=optimizer,
        accelerator=accelerator,
        accelerator_count=1 + (index % 8),
        notes=notes,
        tags=tags,
    )


def metric_value(key: str, run_index: int, step: int) -> float:
    if key == "eval/return_mean":
        return (
            100
            + math.log2(float(step + 1)) * 7
            + math.sin((float(step) / 25) + float(run_index % 997)) * 2
            + (float(run_index % 500) / 10)
        )
    if key == "eval/success_rate":
        return min(1.0, 0.2 + (float(step) / 1250) + (float(run_index % 10) / 100))
    if key == "train/loss":
        return max(0.001, (4 / math.sqrt(float(step + 1))) + (float(run_index % 7) / 100))
    if key == "train/reward_mean":
        return 45 + (math.log1p(float(step)) * 10) + (float(run_index % 250) / 8)
    if key == "system/cpu_percent":
        return 50 + (math.sin((float(step) / 19) + float(run_index)) * 20)
    if key == "system/gpu_util":
        return 65 + (math.sin((float(step) / 13) + float(run_index)) * 25)
    return 0.0


def precompute_eval_return_max(steps: int) -> list[float]:
    values: list[float] = []
    for residue in range(997):
        best = max(
            math.log2(float(step + 1)) * 7 + math.sin((float(step) / 25) + float(residue)) * 2
            for step in range(1, steps + 1)
        )
        values.append(best)
    return values


def summary_metrics(run_index: int, steps: int, eval_return_base_max: list[float]) -> dict[str, float]:
    eval_return_max = 100 + eval_return_base_max[run_index % 997] + (float(run_index % 500) / 10)
    metrics = {
        "eval/return_mean": eval_return_max,
        "eval_return_mean": eval_return_max,
        "eval/success_rate": metric_value("eval/success_rate", run_index, steps),
        "eval_success_rate": metric_value("eval/success_rate", run_index, steps),
        "train/loss": metric_value("train/loss", run_index, steps),
        "train_loss": metric_value("train/loss", run_index, steps),
        "train/reward_mean": metric_value("train/reward_mean", run_index, steps),
        "train_reward_mean": metric_value("train/reward_mean", run_index, steps),
        "system/cpu_percent": metric_value("system/cpu_percent", run_index, steps),
        "system_cpu_percent": metric_value("system/cpu_percent", run_index, steps),
        "system/gpu_util": metric_value("system/gpu_util", run_index, steps),
        "system_gpu_util": metric_value("system/gpu_util", run_index, steps),
    }
    return metrics


def history_indices(
    mode: str,
    run_count: int,
    newest_count: int,
    search_count: int,
    selection_query: str,
) -> set[int]:
    if mode == "none":
        return set()
    if mode == "exact":
        return set(range(run_count))
    selected: set[int] = set()
    if mode in {"newest", "dashboard"}:
        selected.update(range(max(0, run_count - newest_count), run_count))
    if mode in {"seed-query", "dashboard"}:
        match = re.fullmatch(r"seed-(\d+)", selection_query.strip())
        if match:
            seed_value = int(match.group(1))
            for index in range(seed_value, run_count, 100):
                selected.add(index)
                if sum(1 for item in selected if item % 100 == seed_value) >= search_count:
                    break
    return selected


def summarize_timings(timings: list[float]) -> dict[str, Any]:
    sorted_timings = sorted(timings)
    if not sorted_timings:
        return {"samples": 0, "p50_ms": 0, "p95_ms": 0, "min_ms": 0, "max_ms": 0, "timings_ms": []}
    return {
        "samples": len(sorted_timings),
        "p50_ms": round(percentile(sorted_timings, 0.5)),
        "p95_ms": round(percentile(sorted_timings, 0.95)),
        "min_ms": round(sorted_timings[0]),
        "max_ms": round(sorted_timings[-1]),
        "mean_ms": round(statistics.fmean(sorted_timings)),
        "timings_ms": [round(value) for value in sorted_timings],
    }


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, math.ceil(len(sorted_values) * p) - 1)
    return sorted_values[index]


def require_wandb() -> Any:
    try:
        import wandb  # type: ignore
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing wandb. Run: .venv/bin/python -m pip install -r benchmarks/requirements-wandb.txt"
        ) from exc
    return wandb


def configure_wandb_env() -> None:
    os.environ.setdefault("WANDB_SILENT", "true")
    os.environ.setdefault("WANDB_QUIET", "true")
    os.environ.setdefault("WANDB_CONSOLE", "off")
    os.environ.setdefault("WANDB_DISABLE_GIT", "true")
    os.environ.setdefault("WANDB_DISABLE_CODE", "true")
    os.environ.setdefault("WANDB_ERROR_REPORTING", "false")


def default_entity(wandb: Any, requested: str | None) -> str:
    if requested:
        return requested
    api = wandb.Api(timeout=60)
    entity = getattr(api, "default_entity", None)
    if not entity:
        viewer = getattr(api, "viewer", None)
        entity = getattr(viewer, "username", None) or getattr(viewer, "name", None)
    if not entity:
        raise SystemExit("Could not infer W&B entity. Set WANDB_ENTITY or pass --entity.")
    return str(entity)


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": MANIFEST_VERSION, "runs": {}, "events": []}
    return json.loads(path.read_text())


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")


def save_manifest(path: Path, manifest: dict[str, Any]) -> None:
    write_json(path, manifest)


def seed_wandb(args: argparse.Namespace) -> None:
    load_dotenv(REPO_ROOT / ".env")
    configure_wandb_env()
    if not args.allow and os.environ.get("INSTANTML_WANDB_BENCH_ALLOW_UPLOAD") != "1":
        raise SystemExit(
            "W&B seeding is external and cost-incurring. Pass --allow or set INSTANTML_WANDB_BENCH_ALLOW_UPLOAD=1."
        )
    if args.history_mode == "exact" and not args.allow_exact:
        raise SystemExit("Exact W&B history seeding requires --allow-exact.")

    wandb = require_wandb()
    entity = default_entity(wandb, args.entity or os.environ.get("WANDB_ENTITY"))
    projects = csv_list(args.source_projects, DEFAULT_SOURCE_PROJECTS)
    metric_keys = csv_list(args.metric_keys, DEFAULT_METRIC_KEYS)
    if "eval/return_mean" not in metric_keys:
        raise SystemExit("metric keys must include eval/return_mean")

    manifest_path = Path(args.manifest)
    manifest = load_manifest(manifest_path)
    if manifest.get("project") and manifest.get("project") != args.project:
        manifest = {"version": MANIFEST_VERSION, "runs": {}, "events": []}
    if manifest.get("entity") and manifest.get("entity") != entity:
        manifest = {"version": MANIFEST_VERSION, "runs": {}, "events": []}
    run_records: dict[str, Any] = manifest.setdefault("runs", {})
    full_history = history_indices(
        args.history_mode,
        args.runs,
        args.history_newest_runs,
        args.history_search_runs,
        args.selection_query,
    )
    if args.max_full_history_runs is not None and len(full_history) > args.max_full_history_runs:
        full_history = set(sorted(full_history)[-args.max_full_history_runs:])

    eval_return_base_max = precompute_eval_return_max(args.steps)
    wandb_dir = BENCHMARK_DIR / ".wandb"
    wandb_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    seeded = 0
    skipped = 0
    failed: list[dict[str, Any]] = []
    manifest.update(
        {
            "version": MANIFEST_VERSION,
            "entity": entity,
            "project": args.project,
            "generated_at": manifest.get("generated_at") or now_iso(),
            "updated_at": now_iso(),
            "dataset": {
                "runs": args.runs,
                "steps": args.steps,
                "source_projects": projects,
                "metric_keys": metric_keys,
                "history_mode": args.history_mode,
                "seed_mode": args.seed_mode,
                "full_history_runs": len(full_history),
                "selection_query": args.selection_query,
            },
        }
    )

    end_index = min(args.end_index if args.end_index is not None else args.runs, args.runs)
    for index in range(args.start_index, end_index):
        row = source_run(index, projects)
        if row.run_id in run_records and run_records[row.run_id].get("status") == "seeded":
            skipped += 1
            continue
        should_log_full_history = index in full_history
        try:
            seed_one_run(
                wandb=wandb,
                api=None,
                entity=entity,
                project=args.project,
                row=row,
                steps=args.steps,
                metric_keys=metric_keys,
                eval_return_base_max=eval_return_base_max,
                full_history=should_log_full_history,
                seed_mode=args.seed_mode,
                wandb_dir=wandb_dir,
                run_group=args.run_group,
            )
            run_records[row.run_id] = {
                "status": "seeded",
                "run_index": index,
                "source_project": row.source_project,
                "source_status": row.source_status,
                "full_history": should_log_full_history,
                "updated_at": now_iso(),
            }
            seeded += 1
            if seeded % args.save_every == 0:
                manifest["updated_at"] = now_iso()
                save_manifest(manifest_path, manifest)
            if (seeded + skipped) % args.progress_every == 0:
                print(
                    json.dumps(
                        {
                            "status": "progress",
                            "processed": seeded + skipped,
                            "seeded": seeded,
                            "skipped": skipped,
                            "failed": len(failed),
                        }
                    ),
                    flush=True,
                )
        except Exception as exc:  # W&B exceptions vary by SDK version.
            failed.append({"run_id": row.run_id, "index": index, "error": str(exc)[:500]})
            run_records[row.run_id] = {
                "status": "failed",
                "run_index": index,
                "error": str(exc)[:500],
                "updated_at": now_iso(),
            }
            manifest["updated_at"] = now_iso()
            save_manifest(manifest_path, manifest)
            if not args.continue_on_error:
                raise

    elapsed = time.perf_counter() - started
    manifest["updated_at"] = now_iso()
    manifest["seed_summary"] = {
        "seeded_this_run": seeded,
        "skipped_this_run": skipped,
        "failed_this_run": len(failed),
        "elapsed_seconds": round(elapsed, 3),
        "runs_per_second": round(seeded / elapsed, 3) if elapsed > 0 else 0,
    }
    if failed:
        manifest["recent_failures"] = failed[-20:]
    save_manifest(manifest_path, manifest)
    print(json.dumps({"status": "ok", **manifest["seed_summary"], "manifest": str(manifest_path)}, indent=2))


def seed_one_run(
    *,
    wandb: Any,
    api: Any | None,
    entity: str,
    project: str,
    row: SourceRun,
    steps: int,
    metric_keys: list[str],
    eval_return_base_max: list[float],
    full_history: bool,
    seed_mode: str,
    wandb_dir: Path,
    run_group: str,
) -> None:
    effective_seed_mode = "init" if seed_mode == "init" or full_history else "api-create"
    if effective_seed_mode == "api-create":
        seed_one_run_api_create(
            wandb=wandb,
            api=api,
            entity=entity,
            project=project,
            row=row,
            steps=steps,
            eval_return_base_max=eval_return_base_max,
            run_group=run_group,
        )
        return

    config = {
        "instantml_source_project": row.source_project,
        "instantml_source_status": row.source_status,
        "instantml_source_run_index": row.index,
        "instantml_source_run_id": row.run_id,
        "instantml_notes": row.notes,
        "seed": row.seed,
        "framework": row.framework,
        "model": row.model,
        "optimizer": row.optimizer,
        "hardware": {
            "accelerator": row.accelerator,
            "accelerator_count": row.accelerator_count,
        },
    }
    run = wandb.init(
        entity=entity,
        project=project,
        id=row.run_id,
        name=row.name,
        tags=row.tags,
        notes=row.notes,
        config=config,
        group=run_group,
        dir=str(wandb_dir),
        mode="online",
        resume="never",
        reinit=True,
    )
    exit_code = 1 if row.source_status == "failed" else 0
    try:
        for key in metric_keys:
            if hasattr(run, "define_metric"):
                summary = "max"
                if key == "train/loss":
                    summary = "min"
                run.define_metric(key, summary=summary)
        if full_history:
            for step in range(1, steps + 1):
                run.log({key: metric_value(key, row.index, step) for key in metric_keys}, step=step)
        else:
            run.log({key: metric_value(key, row.index, steps) for key in metric_keys}, step=steps)
        for key, value in summary_metrics(row.index, steps, eval_return_base_max).items():
            run.summary[key] = value
        try:
            run.summary.update()
        except TypeError:
            run.summary.update(dict(run.summary))
    finally:
        run.finish(exit_code=exit_code, quiet=True)


def seed_one_run_api_create(
    *,
    wandb: Any,
    api: Any | None,
    entity: str,
    project: str,
    row: SourceRun,
    steps: int,
    eval_return_base_max: list[float],
    run_group: str,
) -> None:
    api = api or wandb.Api(timeout=60)
    run = api.create_run(entity=entity, project=project, run_id=row.run_id)
    run._attrs.setdefault("group", run_group)
    run._attrs.setdefault("jobType", None)
    run._attrs["displayName"] = row.name
    run._attrs["tags"] = row.tags
    run._attrs["notes"] = row.notes
    run.config.update(
        {
            "instantml_source_project": row.source_project,
            "instantml_source_status": row.source_status,
            "instantml_source_run_index": row.index,
            "instantml_source_run_id": row.run_id,
            "instantml_notes": row.notes,
            "instantml_seed_mode": "api-create-summary",
            "seed": row.seed,
            "framework": row.framework,
            "model": row.model,
            "optimizer": row.optimizer,
            "hardware": {
                "accelerator": row.accelerator,
                "accelerator_count": row.accelerator_count,
            },
        }
    )
    for key, value in summary_metrics(row.index, steps, eval_return_base_max).items():
        run.summary[key] = value
    run.update()


def benchmark_wandb(args: argparse.Namespace) -> None:
    load_dotenv(REPO_ROOT / ".env")
    configure_wandb_env()
    wandb = require_wandb()
    entity = default_entity(wandb, args.entity or os.environ.get("WANDB_ENTITY"))
    api = wandb.Api(timeout=args.timeout)
    path = f"{entity}/{args.project}"
    projects = csv_list(args.source_projects, DEFAULT_SOURCE_PROJECTS)
    metric_keys = csv_list(args.metric_keys, DEFAULT_METRIC_KEYS)
    started = now_iso()

    preflight = wandb_preflight(api, path, projects, args)
    cases = wandb_cases(preflight, projects, metric_keys, args)
    measurements: list[dict[str, Any]] = []
    for index, case in enumerate(cases, start=1):
        print(json.dumps({"status": "case_start", "index": index, "total": len(cases), "name": case["name"]}), flush=True)
        measurements.append(measure_case(case, args.warmups, args.samples))
        print(json.dumps({"status": "case_done", "index": index, "name": case["name"]}), flush=True)

    result = {
        "status": "ok",
        "generated_at": started,
        "git": git_metadata(),
        "environment": {
            "python_version": sys.version.split()[0],
            "wandb_version": getattr(wandb, "__version__", "unknown"),
            "entity": entity,
            "project": args.project,
        },
        "measurement_protocol": {
            "warmups": args.warmups,
            "samples": args.samples,
            "p95": "nearest-rank",
            "endpoint_order": "fixed",
            "hydrate_runs": args.hydrate_runs,
            "include_length": args.include_length,
        },
        "dataset": {
            "configured_runs": args.runs,
            "expected_steps_per_run": args.steps,
            "source_projects": projects,
            "metric_keys": metric_keys,
            "metric_key": args.metric_key,
            "selection_search_query": args.selection_query,
            **preflight["dataset"],
        },
        "notes": [
            "W&B timings use documented SDK/Public API surfaces only.",
            "Source project/status and notes search are mirrored through config/tags because W&B's documented run API is project-scoped.",
        ],
        "measurements": measurements,
    }
    write_json(Path(args.output), result)
    print(json.dumps({"status": "ok", "output": args.output, "measurements": len(measurements)}, indent=2))


def seed_wandb_parallel(args: argparse.Namespace) -> None:
    load_dotenv(REPO_ROOT / ".env")
    if not args.allow and os.environ.get("INSTANTML_WANDB_BENCH_ALLOW_UPLOAD") != "1":
        raise SystemExit(
            "W&B seeding is external and cost-incurring. Pass --allow or set INSTANTML_WANDB_BENCH_ALLOW_UPLOAD=1."
        )
    if args.history_mode == "exact" and not args.allow_exact:
        raise SystemExit("Exact W&B history seeding requires --allow-exact.")
    if args.workers <= 1:
        seed_wandb(args)
        return
    start = args.start_index
    end = min(args.end_index if args.end_index is not None else args.runs, args.runs)
    if start >= end:
        raise SystemExit("--start-index must be lower than --end-index/--runs")
    shard_ranges = split_ranges(start, end, args.workers)
    manifest_base = Path(args.manifest)
    commands: list[tuple[int, list[str]]] = []
    for shard_index, (shard_start, shard_end) in enumerate(shard_ranges):
        shard_manifest = manifest_base.with_name(
            f"{manifest_base.stem}-shard-{shard_index + 1:02d}{manifest_base.suffix}"
        )
        cmd = [
            sys.executable,
            str(Path(__file__).resolve()),
            "seed-wandb",
            "--runs",
            str(args.runs),
            "--steps",
            str(args.steps),
            "--source-projects",
            args.source_projects,
            "--metric-keys",
            args.metric_keys,
            "--metric-key",
            args.metric_key,
            "--selection-query",
            args.selection_query,
            "--project",
            args.project,
            "--manifest",
            str(shard_manifest),
            "--history-mode",
            args.history_mode,
            "--history-newest-runs",
            str(args.history_newest_runs),
            "--history-search-runs",
            str(args.history_search_runs),
            "--seed-mode",
            args.seed_mode,
            "--start-index",
            str(shard_start),
            "--end-index",
            str(shard_end),
            "--run-group",
            args.run_group,
            "--save-every",
            str(args.save_every),
            "--progress-every",
            str(args.progress_every),
            "--allow",
        ]
        if args.entity:
            cmd.extend(["--entity", args.entity])
        if args.max_full_history_runs is not None:
            cmd.extend(["--max-full-history-runs", str(args.max_full_history_runs)])
        if args.allow_exact:
            cmd.append("--allow-exact")
        if args.continue_on_error:
            cmd.append("--continue-on-error")
        commands.append((shard_index + 1, [item for item in cmd if item != ""]))

    started = time.perf_counter()
    results: list[dict[str, Any]] = []
    print(json.dumps({"status": "parallel_start", "workers": args.workers, "shards": shard_ranges}), flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(run_seed_shard, shard_index, cmd): shard_index
            for shard_index, cmd in commands
        }
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            print(json.dumps({"status": "parallel_shard_done", **result}), flush=True)
            if result["returncode"] != 0 and not args.continue_on_error:
                raise SystemExit(f"Shard {result['shard']} failed; see stderr_tail in output.")
    elapsed = time.perf_counter() - started
    summary = {
        "status": "ok" if all(result["returncode"] == 0 for result in results) else "failed",
        "generated_at": now_iso(),
        "workers": args.workers,
        "runs": args.runs,
        "range": [start, end],
        "elapsed_seconds": round(elapsed, 3),
        "shards": sorted(results, key=lambda item: item["shard"]),
    }
    write_json(Path(args.parallel_result), summary)
    print(json.dumps({"status": summary["status"], "output": args.parallel_result, "elapsed_seconds": summary["elapsed_seconds"]}, indent=2))


def split_ranges(start: int, end: int, workers: int) -> list[tuple[int, int]]:
    total = end - start
    base = total // workers
    remainder = total % workers
    ranges = []
    cursor = start
    for index in range(workers):
        size = base + (1 if index < remainder else 0)
        if size <= 0:
            continue
        ranges.append((cursor, cursor + size))
        cursor += size
    return ranges


def run_seed_shard(shard: int, cmd: list[str]) -> dict[str, Any]:
    started = time.perf_counter()
    result = subprocess.run(cmd, cwd=REPO_ROOT, text=True, capture_output=True)
    return {
        "shard": shard,
        "returncode": result.returncode,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "stdout_tail": result.stdout[-2000:],
        "stderr_tail": result.stderr[-2000:],
    }


def wandb_preflight(api: Any, path: str, projects: list[str], args: argparse.Namespace) -> dict[str, Any]:
    newest = fetch_wandb_runs(
        api,
        path,
        limit=25,
        order="-created_at",
        filters=None,
        hydrate=args.hydrate_runs,
        include_length=args.include_length,
    )
    if not newest["runs"]:
        raise SystemExit(f"W&B project {path} has no visible runs.")
    default_selected = fetch_wandb_runs(
        api,
        path,
        limit=args.default_selected_runs,
        order="-created_at",
        filters=None,
        hydrate=False,
        include_length=False,
    )["runs"]
    max_selected = fetch_wandb_runs(
        api,
        path,
        limit=args.selected_runs,
        order="-created_at",
        filters=None,
        hydrate=False,
        include_length=False,
    )["runs"]
    search_selected = fetch_wandb_runs(
        api,
        path,
        limit=args.search_selected_runs,
        order="-created_at",
        filters={"tags": {"$in": [args.selection_query]}},
        hydrate=False,
        include_length=False,
    )["runs"]
    source_counts = {}
    status_counts = {}
    for project in projects:
        page = fetch_wandb_runs(
            api,
            path,
            limit=5,
            order="-created_at",
            filters={"config.instantml_source_project": project},
            hydrate=False,
            include_length=True,
        )
        source_counts[project] = page.get("total")
    for status in ["failed", "running", "finished"]:
        page = fetch_wandb_runs(
            api,
            path,
            limit=5,
            order="-created_at",
            filters={"config.instantml_source_status": status},
            hydrate=False,
            include_length=True,
        )
        status_counts[status] = page.get("total")
    return {
        "first_run_id": newest["runs"][0]["id"],
        "default_selected_ids": [run["id"] for run in default_selected],
        "max_selected_ids": [run["id"] for run in max_selected],
        "search_selected_ids": [run["id"] for run in search_selected],
        "dataset": {
            "observed_total_runs": newest.get("total"),
            "source_project_counts": source_counts,
            "source_status_counts": status_counts,
            "default_selected_run_count": len(default_selected),
            "max_selected_run_count": len(max_selected),
            "search_selected_run_count": len(search_selected),
        },
    }


def wandb_cases(
    preflight: dict[str, Any],
    projects: list[str],
    metric_keys: list[str],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    api_path = args._api_path
    api = args._api
    cases: list[dict[str, Any]] = [
        list_case(api, api_path, "wandb_newest_25", limit=25, args=args),
        list_case(api, api_path, "wandb_newest_100_default_page", limit=100, args=args),
        list_case(
            api,
            api_path,
            "wandb_search_hosted_scale",
            limit=25,
            filters={"tags": {"$in": ["hosted-scale"]}},
            args=args,
        ),
        list_case(
            api,
            api_path,
            "wandb_search_seed_13",
            limit=25,
            filters={"tags": {"$in": [args.selection_query]}},
            args=args,
        ),
        list_case(
            api,
            api_path,
            "wandb_sort_metric_best_exact_key",
            limit=25,
            order=f"-summary_metrics.{args.metric_key}",
            args=args,
            allow_failure=True,
        ),
        list_case(
            api,
            api_path,
            "wandb_sort_metric_best_alias",
            limit=25,
            order="-summary_metrics.eval_return_mean",
            args=args,
            caveat="alias metric because some W&B public API paths do not sort slash keys consistently",
        ),
        list_case(api, api_path, "wandb_default_selection_100", limit=args.default_selected_runs, args=args, hydrate=False, include_length=False),
        list_case(api, api_path, "wandb_max_selection_page_1", limit=1000, args=args, hydrate=False, include_length=False),
        list_case(api, api_path, "wandb_search_seed_13_selection", limit=args.search_selected_runs, filters={"tags": {"$in": [args.selection_query]}}, args=args, hydrate=False, include_length=False),
        overview_case(api, api_path, "wandb_derived_overview", args=args),
        history_case(api, api_path, "wandb_chart_eval_return_history", preflight["first_run_id"], args.metric_key, args.chart_limit),
        scan_history_case(api, api_path, "wandb_chart_eval_return_scan_history", preflight["first_run_id"], args.metric_key, min(args.chart_limit, args.scan_history_limit)),
    ]
    for project in projects:
        slug = safe_slug(project)
        cases.extend(
            [
                list_case(api, api_path, f"{slug}_newest_25", limit=25, filters={"config.instantml_source_project": project}, args=args),
                list_case(api, api_path, f"{slug}_newest_100", limit=100, filters={"config.instantml_source_project": project}, args=args),
                list_case(api, api_path, f"{slug}_search_project_tag", limit=25, filters={"tags": {"$in": [project]}}, args=args),
                list_case(api, api_path, f"{slug}_search_config_transformer", limit=25, filters={"config.model": "transformer", "config.instantml_source_project": project}, args=args),
                list_case(api, api_path, f"{slug}_search_notes_scale_validation_mirror", limit=25, filters={"config.instantml_notes": {"$regex": "scale validation"}, "config.instantml_source_project": project}, args=args, caveat="notes search uses mirrored config field"),
                list_case(api, api_path, f"{slug}_filter_failed_source_status", limit=25, filters={"config.instantml_source_status": "failed", "config.instantml_source_project": project}, args=args, caveat="source status mirror"),
                list_case(api, api_path, f"{slug}_filter_running_source_status", limit=25, filters={"config.instantml_source_status": "running", "config.instantml_source_project": project}, args=args, caveat="source status mirror"),
                list_case(api, api_path, f"{slug}_filter_finished_source_status", limit=25, filters={"config.instantml_source_status": "finished", "config.instantml_source_project": project}, args=args, caveat="source status mirror"),
            ]
        )
    if args.include_batched_series:
        for label, ids in [
            (f"default_{len(preflight['default_selected_ids'])}", preflight["default_selected_ids"]),
            (f"search_{safe_slug(args.selection_query)}_{len(preflight['search_selected_ids'])}", preflight["search_selected_ids"]),
            (f"max_{len(preflight['max_selected_ids'])}", preflight["max_selected_ids"]),
        ]:
            if not ids:
                continue
            for key in metric_keys:
                cases.append(histories_case(api, api_path, f"wandb_histories_{label}_{safe_slug(key)}", ids, key, adaptive_series_limit(len(ids))))
    return cases


def list_case(
    api: Any,
    path: str,
    name: str,
    *,
    limit: int,
    args: argparse.Namespace,
    filters: dict[str, Any] | None = None,
    order: str = "-created_at",
    hydrate: bool | None = None,
    include_length: bool | None = None,
    allow_failure: bool = False,
    caveat: str | None = None,
) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        return fetch_wandb_runs(
            api,
            path,
            limit=limit,
            order=order,
            filters=filters,
            hydrate=args.hydrate_runs if hydrate is None else hydrate,
            include_length=args.include_length if include_length is None else include_length,
        )

    return {
        "name": name,
        "kind": "summary",
        "method": "W&B Public API",
        "route_template": "wandb.Api.runs",
        "limit": limit,
        "run": run,
        "allow_failure": allow_failure,
        "caveat": caveat,
    }


def overview_case(api: Any, path: str, name: str, *, args: argparse.Namespace) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        totals = {}
        for status in ["failed", "running", "finished"]:
            page = fetch_wandb_runs(
                api,
                path,
                limit=1,
                filters={"config.instantml_source_status": status},
                order="-created_at",
                hydrate=False,
                include_length=True,
            )
            totals[status] = page.get("total")
        return {"rows": sum(int(value or 0) for value in totals.values()), "source_status_counts": totals}

    return {
        "name": name,
        "kind": "overview",
        "method": "W&B Public API",
        "route_template": "wandb.Api.runs count queries",
        "run": run,
        "caveat": "derived from multiple W&B count queries",
    }


def history_case(api: Any, path: str, name: str, run_id: str, key: str, limit: int) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        flush_api(api)
        run_obj = api.run(f"{path}/{run_id}")
        rows = run_obj.history(samples=limit, keys=[key], pandas=False)
        return {"rows": len(rows), "run_id": run_id}

    return {
        "name": name,
        "kind": "chart",
        "method": "W&B Public API",
        "route_template": "wandb.Run.history",
        "limit": limit,
        "run": run,
    }


def scan_history_case(api: Any, path: str, name: str, run_id: str, key: str, limit: int) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        flush_api(api)
        run_obj = api.run(f"{path}/{run_id}")
        count = 0
        for _row in run_obj.scan_history(keys=[key]):
            count += 1
            if count >= limit:
                break
        return {"rows": count, "run_id": run_id}

    return {
        "name": name,
        "kind": "chart",
        "method": "W&B Public API",
        "route_template": "wandb.Run.scan_history",
        "limit": limit,
        "run": run,
        "caveat": "exact scan is not the same sampled surface W&B charts normally use",
    }


def histories_case(api: Any, path: str, name: str, run_ids: list[str], key: str, limit: int) -> dict[str, Any]:
    def run() -> dict[str, Any]:
        flush_api(api)
        # W&B filters by run id through the internal "name" field in the public API.
        runs = api.runs(path=path, filters={"name": {"$in": run_ids}}, order="-created_at", per_page=min(1000, len(run_ids)), lazy=True)
        rows = runs.histories(samples=limit, keys=[key], pandas=False)
        return {"rows": len(rows), "requested_runs": len(run_ids)}

    return {
        "name": name,
        "kind": "batched_series",
        "method": "W&B Public API",
        "route_template": "wandb.Runs.histories",
        "limit": limit,
        "run": run,
        "caveat": "closest documented W&B public equivalent to selected-run series",
        "allow_failure": True,
    }


def fetch_wandb_runs(
    api: Any,
    path: str,
    *,
    limit: int,
    order: str,
    filters: dict[str, Any] | None,
    hydrate: bool,
    include_length: bool,
) -> dict[str, Any]:
    flush_api(api)
    runs_obj = api.runs(
        path=path,
        filters=filters,
        order=order,
        per_page=min(1000, max(50, limit)),
        lazy=True,
    )
    total = None
    if include_length:
        try:
            total = int(runs_obj.length)
        except Exception:
            total = None
    runs = []
    for run in runs_obj:
        item = {
            "id": getattr(run, "id", None),
            "name": getattr(run, "name", None),
            "state": getattr(run, "state", None),
        }
        if hydrate:
            item["tags"] = list(getattr(run, "tags", []) or [])
            item["config_keys"] = mapping_len(getattr(run, "config", {}) or {})
            item["summary_keys"] = mapping_len(getattr(run, "summary", {}) or {})
        runs.append(item)
        if len(runs) >= limit:
            break
    return {"rows": len(runs), "total": total, "runs": runs}


def flush_api(api: Any) -> None:
    flush = getattr(api, "flush", None)
    if callable(flush):
        flush()


def mapping_len(value: Any) -> int:
    try:
        return len(value)
    except TypeError:
        try:
            return len(dict(value))
        except Exception:
            return 0


def measure_case(case: dict[str, Any], warmups: int, samples: int) -> dict[str, Any]:
    stats: dict[str, Any] | None = None
    error: str | None = None
    for _ in range(warmups):
        try:
            stats = case["run"]()
        except Exception as exc:
            if not case.get("allow_failure"):
                raise
            error = str(exc)[:500]
            break
    timings: list[float] = []
    if error is None:
        for _ in range(samples):
            started = time.perf_counter()
            try:
                stats = case["run"]()
                timings.append((time.perf_counter() - started) * 1000)
            except Exception as exc:
                if not case.get("allow_failure"):
                    raise
                error = str(exc)[:500]
                break
    return compact(
        {
            "name": case["name"],
            "kind": case.get("kind"),
            "method": case.get("method"),
            "route_template": case.get("route_template"),
            "limit": case.get("limit"),
            **summarize_timings(timings),
            "stats": stats,
            "caveat": case.get("caveat"),
            "error": error,
            "passed": error is None,
        }
    )


def benchmark_instantml(args: argparse.Namespace) -> None:
    load_dotenv(REPO_ROOT / ".env")
    if args.direct:
        benchmark_instantml_direct(args)
        return
    env = dict(os.environ)
    env["INSTANTML_CLOUD_RUN_BENCH_RESULT_PATH"] = str(Path(args.output).resolve())
    if args.samples:
        env["INSTANTML_CLOUD_RUN_BENCH_SAMPLES"] = str(args.samples)
    if args.warmups:
        env["INSTANTML_CLOUD_RUN_BENCH_WARMUPS"] = str(args.warmups)
    cmd = ["node", "tools/hosted-cloud-run-benchmark.mjs"]
    result = subprocess.run(cmd, cwd=REPO_ROOT, env=env, text=True, capture_output=True)
    if result.returncode != 0:
        if args.fallback_direct:
            benchmark_instantml_direct(args, fallback_error=result.stderr[-2000:])
            return
        payload = {
            "status": "failed",
            "generated_at": now_iso(),
            "command": " ".join(cmd),
            "note": "This wrapper is read-only and did not seed InstantML hosted ClickHouse.",
            "stderr_tail": result.stderr[-4000:],
            "stdout_tail": result.stdout[-4000:],
        }
        write_json(Path(args.output), payload)
        raise SystemExit(f"InstantML read-only benchmark failed; wrote {args.output}")
    print(result.stdout)


def benchmark_instantml_direct(args: argparse.Namespace, fallback_error: str | None = None) -> None:
    base = (
        os.environ.get("INSTANTML_CLOUD_RUN_BENCH_API_BASE")
        or os.environ.get("INSTANTML_DATA_API_BASE")
        or os.environ.get("INSTANTML_API_BASE")
        or ""
    ).rstrip("/")
    api_key = os.environ.get("INSTANTML_CLOUD_RUN_BENCH_API_KEY") or os.environ.get("INSTANTML_API_KEY") or ""
    if not base or not api_key:
        raise SystemExit("Set INSTANTML_DATA_API_BASE/INSTANTML_API_BASE and INSTANTML_API_KEY for direct InstantML benchmark.")
    projects = csv_list(os.environ.get("INSTANTML_CLOUD_RUN_BENCH_PROJECTS"), DEFAULT_SOURCE_PROJECTS)
    metric_key = os.environ.get("INSTANTML_CLOUD_RUN_BENCH_METRIC_KEY", "eval/return_mean")
    system_metric_key = os.environ.get("INSTANTML_CLOUD_RUN_BENCH_SYSTEM_METRIC_KEY", "system/gpu_util")
    samples = args.samples or int(os.environ.get("INSTANTML_CLOUD_RUN_BENCH_SAMPLES", "8"))
    warmups = args.warmups or int(os.environ.get("INSTANTML_CLOUD_RUN_BENCH_WARMUPS", "2"))
    client = InstantMLClient(base, api_key)
    preflight = direct_instantml_preflight(client, projects, metric_key)
    cases = direct_instantml_cases(client, projects, metric_key, system_metric_key, preflight)
    measurements = [measure_case(case, warmups, samples) for case in cases]
    result = {
        "status": "ok",
        "generated_at": now_iso(),
        "git": git_metadata(),
        "environment": {
            "api_mode": "hosted-api-direct-fallback" if fallback_error else "hosted-api-direct",
            "api_host": urllib.parse.urlparse(base).netloc,
            "api_transport": urllib.parse.urlparse(base).scheme,
        },
        "measurement_protocol": {
            "warmups": warmups,
            "samples": samples,
            "p95": "nearest-rank",
            "endpoint_order": "fixed",
        },
        "dataset": {
            "projects": projects,
            "observed_runs": preflight["observed_runs"],
            "observed_metric_points": preflight["observed_metric_points"],
            "metric_key": metric_key,
            "system_metric_key": system_metric_key,
            "selection_search_query": DEFAULT_SEARCH_QUERY,
        },
        "notes": [
            "Direct fallback is read-only and did not seed InstantML hosted ClickHouse.",
            "It omits selection-projection and batched-series cases because the deployed API response shape differs from the local validator.",
        ],
        "fallback_error": fallback_error,
        "measurements": measurements,
    }
    write_json(Path(args.output), result)
    print(json.dumps({"status": "ok", "output": args.output, "measurements": len(measurements)}, indent=2))


class InstantMLClient:
    def __init__(self, base: str, api_key: str) -> None:
        self.base = base
        self.api_key = api_key

    def request(self, path: str, *, method: str = "GET", body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None
        headers = {"authorization": f"Bearer {self.api_key}"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{path} failed with {exc.code}: {text[:500]}") from exc


def direct_instantml_preflight(client: InstantMLClient, projects: list[str], metric_key: str) -> dict[str, Any]:
    observed_runs = 0
    observed_metric_points = 0
    summaries = []
    for project in projects:
        payload = client.request(f"/api/runs/summary?{query_string({'project': project, 'limit': 25, 'sort_by': 'created', 'metric_key': metric_key})}")
        summaries.append((project, payload))
        observed_runs += int(payload.get("total") or 0)
        overview = client.request(f"/api/overview?{query_string({'project': project, 'metric_key': metric_key})}")
        observed_metric_points += int((overview.get("overview") or {}).get("metric_points") or 0)
    first_payload = summaries[0][1] if summaries else client.request(f"/api/runs/summary?{query_string({'limit': 25, 'sort_by': 'created', 'metric_key': metric_key})}")
    first_run_id = first_payload["runs"][0]["id"]
    return {
        "observed_runs": observed_runs,
        "observed_metric_points": observed_metric_points,
        "project_summaries": summaries,
        "first_run_id": first_run_id,
    }


def direct_instantml_cases(
    client: InstantMLClient,
    projects: list[str],
    metric_key: str,
    system_metric_key: str,
    preflight: dict[str, Any],
) -> list[dict[str, Any]]:
    def summary_case(name: str, params: dict[str, Any], caveat: str | None = None) -> dict[str, Any]:
        limit = int(params.get("limit", 25))

        def run() -> dict[str, Any]:
            payload = client.request(f"/api/runs/summary?{query_string({'limit': limit, 'sort_by': 'created', 'metric_key': metric_key, **params})}")
            return {
                "rows": len(payload.get("runs") or []),
                "total": payload.get("total"),
                "metric_keys": len(payload.get("metric_keys") or []),
            }

        return {
            "name": name,
            "kind": "summary",
            "method": "GET",
            "route_template": "/api/runs/summary",
            "limit": limit,
            "run": run,
            "caveat": caveat,
        }

    def overview_case(name: str, params: dict[str, Any]) -> dict[str, Any]:
        def run() -> dict[str, Any]:
            payload = client.request(f"/api/overview?{query_string({'metric_key': metric_key, **params})}")
            overview = payload.get("overview") or {}
            return {
                "rows": overview.get("total_runs"),
                "metric_points": overview.get("metric_points"),
                "failed_runs": overview.get("failed_runs"),
            }

        return {"name": name, "kind": "overview", "method": "GET", "route_template": "/api/overview", "run": run}

    def chart_case(name: str, run_id: str, key: str) -> dict[str, Any]:
        def run() -> dict[str, Any]:
            payload = client.request(f"/runs/{run_id}/metrics?{query_string({'key': key, 'limit': 1000})}")
            return {"rows": len(payload.get("metrics") or [])}

        return {"name": name, "kind": "chart", "method": "GET", "route_template": "/runs/:id/metrics", "limit": 1000, "run": run}

    cases: list[dict[str, Any]] = [
        summary_case("org_newest_25", {}),
        summary_case("org_newest_100_default_page", {"limit": 100}),
        summary_case("org_search_hosted_scale", {"q": "hosted-scale"}),
        summary_case("org_search_seed_13", {"q": "seed-13"}),
        summary_case("org_sort_metric_best", {"sort_by": "metric-best"}),
        overview_case("org_overview", {}),
    ]
    for project, payload in preflight["project_summaries"]:
        slug = safe_slug(project)
        latest_name = ((payload.get("runs") or [{}])[0].get("name") or project)
        cases.extend(
            [
                summary_case(f"{slug}_newest_25", {"project": project, "limit": 25}),
                summary_case(f"{slug}_newest_100", {"project": project, "limit": 100}),
                summary_case(f"{slug}_search_latest_name", {"project": project, "q": latest_name}),
                summary_case(f"{slug}_search_project_tag", {"project": project, "q": project}),
                summary_case(f"{slug}_search_config_transformer", {"project": project, "q": "transformer"}),
                summary_case(f"{slug}_search_notes_scale_validation", {"project": project, "q": "scale validation"}),
                summary_case(f"{slug}_filter_failed", {"project": project, "status": "failed"}),
                summary_case(f"{slug}_filter_running", {"project": project, "status": "running"}),
                summary_case(f"{slug}_filter_finished", {"project": project, "status": "finished"}),
                summary_case(f"{slug}_filter_finished_config", {"project": project, "status": "finished", "q": "transformer"}),
                summary_case(f"{slug}_sort_metric_best", {"project": project, "sort_by": "metric-best"}),
                overview_case(f"{slug}_overview", {"project": project}),
            ]
        )
    cases.extend(
        [
            chart_case("chart_eval_return", preflight["first_run_id"], metric_key),
            chart_case("chart_system_metric", preflight["first_run_id"], system_metric_key),
        ]
    )
    return cases


def query_string(params: dict[str, Any]) -> str:
    return urllib.parse.urlencode({key: str(value) for key, value in params.items() if value is not None and value != ""})


def render_results(args: argparse.Namespace) -> None:
    instantml = load_json_if_exists(Path(args.instantml_json))
    wandb_result = load_json_if_exists(Path(args.wandb_json))
    output = Path(args.output)
    lines: list[str] = [
        "# Hosted Cloud Comparison Results",
        "",
        f"Generated: `{now_iso()}`",
        "",
        "This report compares the existing InstantML hosted Cloud Run benchmark against W&B hosted cloud using documented public APIs. No InstantML hosted ClickHouse seed command was run for this report.",
        "",
        "## Dataset",
        "",
        dataset_line("InstantML", instantml),
        dataset_line("W&B", wandb_result),
        "",
        "## Headline",
        "",
    ]
    lines.extend(headline_lines(instantml, wandb_result))
    lines.extend(["", "## InstantML Measurements", ""])
    lines.extend(measurement_table(instantml))
    lines.extend(["", "## W&B Measurements", ""])
    lines.extend(measurement_table(wandb_result))
    lines.extend(["", "## Caveats", ""])
    lines.extend(
        [
            "- W&B timings use public SDK/Public API surfaces, not private GraphQL documents.",
            "- W&B project/status/notes equivalents use mirrored config and tags where W&B has no documented matching top-level route.",
            "- Exact W&B full-history parity for 100,000 runs x 1,000 steps x six metrics is supported by the seed tool but is intentionally guarded because it is a 600M-scalar external workload.",
            "- InstantML data in this report is read-only from the existing hosted Cloud Run benchmark path.",
        ]
    )
    output.write_text("\n".join(lines).rstrip() + "\n")
    print(json.dumps({"status": "ok", "output": str(output)}, indent=2))


def headline_lines(instantml: dict[str, Any] | None, wandb_result: dict[str, Any] | None) -> list[str]:
    lines: list[str] = []
    pairs = [
        ("newest 100", ["org_newest_100_default_page", "wandb_newest_100_default_page"]),
        ("seed search", ["org_search_seed_13", "wandb_search_seed_13"]),
        ("metric-best sort", ["org_sort_metric_best", "wandb_sort_metric_best_exact_key", "wandb_sort_metric_best_alias"]),
        ("single-run chart", ["chart_eval_return", "wandb_chart_eval_return_history"]),
    ]
    for label, names in pairs:
        instant = find_measurement(instantml, names[0]) if instantml else None
        wandb_measurement = None
        for name in names[1:]:
            wandb_measurement = find_measurement(wandb_result, name) if wandb_result else None
            if wandb_measurement and wandb_measurement.get("passed", True):
                break
        if instant or wandb_measurement:
            lines.append(
                f"- {label}: InstantML p95 `{fmt_ms(instant)}`, W&B p95 `{fmt_ms(wandb_measurement)}`."
            )
    if not lines:
        lines.append("- No comparable measurements were available.")
    return lines


def dataset_line(label: str, payload: dict[str, Any] | None) -> str:
    if not payload:
        return f"- {label}: no result JSON available."
    dataset = payload.get("dataset", {})
    return f"- {label}: `{json.dumps(compact(dataset), sort_keys=True)}`"


def measurement_table(payload: dict[str, Any] | None) -> list[str]:
    if not payload:
        return ["No measurements available."]
    measurements = payload.get("measurements")
    if isinstance(measurements, dict):
        measurements = [{"name": key, **value} for key, value in measurements.items()]
    if not measurements:
        return ["No measurements available."]
    lines = [
        "| Case | Kind | p50 | p95 | Min | Max | Rows/Stats | Caveat |",
        "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ]
    for item in measurements:
        stats = item.get("stats") or {}
        rows = stats.get("rows") or stats.get("total") or stats.get("series") or stats.get("metric_points") or ""
        caveat = item.get("caveat") or item.get("error") or ""
        lines.append(
            f"| `{item.get('name')}` | {item.get('kind', '')} | {item.get('p50_ms', '')} ms | {item.get('p95_ms', '')} ms | {item.get('min_ms', '')} ms | {item.get('max_ms', '')} ms | {rows} | {caveat} |"
        )
    return lines


def find_measurement(payload: dict[str, Any] | None, name: str) -> dict[str, Any] | None:
    if not payload:
        return None
    measurements = payload.get("measurements")
    if isinstance(measurements, dict):
        return measurements.get(name)
    if isinstance(measurements, list):
        for item in measurements:
            if item.get("name") == name:
                return item
    return None


def fmt_ms(measurement: dict[str, Any] | None) -> str:
    if not measurement:
        return "n/a"
    value = measurement.get("p95_ms")
    return "n/a" if value in (None, "") else f"{value} ms"


def load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def adaptive_series_limit(run_count: int) -> int:
    if run_count >= 1500:
        return 60
    if run_count >= 800:
        return 80
    if run_count >= 400:
        return 120
    if run_count >= 250:
        return 160
    if run_count >= 100:
        return 250
    if run_count >= 50:
        return 500
    return 1000


def csv_list(raw: str | None, fallback: list[str]) -> list[str]:
    if not raw:
        return list(fallback)
    return [item.strip() for item in raw.split(",") if item.strip()]


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug[:48] or "value"


def git_metadata() -> dict[str, str | None]:
    return {
        "commit": git_value(["rev-parse", "HEAD"]),
        "branch": git_value(["branch", "--show-current"]),
    }


def git_value(args: list[str]) -> str | None:
    result = subprocess.run(["git", *args], cwd=REPO_ROOT, text=True, capture_output=True)
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def compact(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: compact(entry) for key, entry in value.items() if entry not in (None, "", [], {})}
    if isinstance(value, list):
        return [compact(entry) for entry in value]
    return value


def add_common_dataset_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--runs", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_RUNS", "100000")))
    parser.add_argument("--steps", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_STEPS", "1000")))
    parser.add_argument("--source-projects", default=os.environ.get("INSTANTML_WANDB_BENCH_SOURCE_PROJECTS", ",".join(DEFAULT_SOURCE_PROJECTS)))
    parser.add_argument("--metric-keys", default=os.environ.get("INSTANTML_WANDB_BENCH_METRIC_KEYS", ",".join(DEFAULT_METRIC_KEYS)))
    parser.add_argument("--metric-key", default=os.environ.get("INSTANTML_WANDB_BENCH_METRIC_KEY", "eval/return_mean"))
    parser.add_argument("--selection-query", default=os.environ.get("INSTANTML_WANDB_BENCH_SELECTION_QUERY", DEFAULT_SEARCH_QUERY))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    seed = sub.add_parser("seed-wandb", help="Seed deterministic benchmark data into W&B only.")
    add_common_dataset_args(seed)
    seed.add_argument("--entity", default=os.environ.get("WANDB_ENTITY"))
    seed.add_argument("--project", default=os.environ.get("INSTANTML_WANDB_BENCH_PROJECT", "instantml-hosted-cloud-compare"))
    seed.add_argument("--manifest", default=str(BENCHMARK_DIR / "wandb-seed-manifest.json"))
    seed.add_argument("--history-mode", choices=["none", "newest", "seed-query", "dashboard", "exact"], default=os.environ.get("INSTANTML_WANDB_BENCH_HISTORY_MODE", "none"))
    seed.add_argument("--seed-mode", choices=["hybrid", "init", "api-create"], default=os.environ.get("INSTANTML_WANDB_BENCH_SEED_MODE", "hybrid"))
    seed.add_argument("--history-newest-runs", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_HISTORY_NEWEST_RUNS", "100")))
    seed.add_argument("--history-search-runs", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_HISTORY_SEARCH_RUNS", "1000")))
    seed.add_argument("--max-full-history-runs", type=int, default=env_optional_int("INSTANTML_WANDB_BENCH_MAX_FULL_HISTORY_RUNS"))
    seed.add_argument("--start-index", type=int, default=0)
    seed.add_argument("--end-index", type=int, default=env_optional_int("INSTANTML_WANDB_BENCH_END_INDEX"))
    seed.add_argument("--workers", type=int, default=1, help=argparse.SUPPRESS)
    seed.add_argument("--parallel-result", default=str(BENCHMARK_DIR / "wandb-parallel-seed-result.json"), help=argparse.SUPPRESS)
    seed.add_argument("--run-group", default=os.environ.get("INSTANTML_WANDB_BENCH_RUN_GROUP", "instantml-hosted-comparison"))
    seed.add_argument("--save-every", type=int, default=10)
    seed.add_argument("--progress-every", type=int, default=100)
    seed.add_argument("--allow", action="store_true")
    seed.add_argument("--allow-exact", action="store_true")
    seed.add_argument("--continue-on-error", action="store_true")
    seed.set_defaults(func=seed_wandb)

    seed_parallel = sub.add_parser("seed-wandb-parallel", help="Seed W&B data with disjoint process-level shards.")
    add_common_dataset_args(seed_parallel)
    seed_parallel.add_argument("--entity", default=os.environ.get("WANDB_ENTITY"))
    seed_parallel.add_argument("--project", default=os.environ.get("INSTANTML_WANDB_BENCH_PROJECT", "instantml-hosted-cloud-compare"))
    seed_parallel.add_argument("--manifest", default=str(BENCHMARK_DIR / "wandb-seed-manifest.json"))
    seed_parallel.add_argument("--parallel-result", default=str(BENCHMARK_DIR / "wandb-parallel-seed-result.json"))
    seed_parallel.add_argument("--history-mode", choices=["none", "newest", "seed-query", "dashboard", "exact"], default=os.environ.get("INSTANTML_WANDB_BENCH_HISTORY_MODE", "none"))
    seed_parallel.add_argument("--seed-mode", choices=["hybrid", "init", "api-create"], default=os.environ.get("INSTANTML_WANDB_BENCH_SEED_MODE", "hybrid"))
    seed_parallel.add_argument("--history-newest-runs", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_HISTORY_NEWEST_RUNS", "100")))
    seed_parallel.add_argument("--history-search-runs", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_HISTORY_SEARCH_RUNS", "1000")))
    seed_parallel.add_argument("--max-full-history-runs", type=int, default=env_optional_int("INSTANTML_WANDB_BENCH_MAX_FULL_HISTORY_RUNS"))
    seed_parallel.add_argument("--start-index", type=int, default=0)
    seed_parallel.add_argument("--end-index", type=int, default=env_optional_int("INSTANTML_WANDB_BENCH_END_INDEX"))
    seed_parallel.add_argument("--workers", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_WORKERS", "4")))
    seed_parallel.add_argument("--run-group", default=os.environ.get("INSTANTML_WANDB_BENCH_RUN_GROUP", "instantml-hosted-comparison"))
    seed_parallel.add_argument("--save-every", type=int, default=10)
    seed_parallel.add_argument("--progress-every", type=int, default=100)
    seed_parallel.add_argument("--allow", action="store_true")
    seed_parallel.add_argument("--allow-exact", action="store_true")
    seed_parallel.add_argument("--continue-on-error", action="store_true")
    seed_parallel.set_defaults(func=seed_wandb_parallel)

    bench = sub.add_parser("benchmark-wandb", help="Benchmark W&B hosted public API reads.")
    add_common_dataset_args(bench)
    bench.add_argument("--entity", default=os.environ.get("WANDB_ENTITY"))
    bench.add_argument("--project", default=os.environ.get("INSTANTML_WANDB_BENCH_PROJECT", "instantml-hosted-cloud-compare"))
    bench.add_argument("--output", default=str(BENCHMARK_DIR / "wandb-hosted-result.json"))
    bench.add_argument("--samples", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_SAMPLES", "8")))
    bench.add_argument("--warmups", type=int, default=int(os.environ.get("INSTANTML_WANDB_BENCH_WARMUPS", "2")))
    bench.add_argument("--timeout", type=int, default=120)
    bench.add_argument("--default-selected-runs", type=int, default=100)
    bench.add_argument("--search-selected-runs", type=int, default=1000)
    bench.add_argument("--selected-runs", type=int, default=2000)
    bench.add_argument("--chart-limit", type=int, default=1000)
    bench.add_argument("--scan-history-limit", type=int, default=1000)
    bench.add_argument("--hydrate-runs", action=argparse.BooleanOptionalAction, default=True)
    bench.add_argument("--include-length", action=argparse.BooleanOptionalAction, default=True)
    bench.add_argument("--include-batched-series", action="store_true")
    bench.set_defaults(func=benchmark_wandb)

    instant = sub.add_parser("benchmark-instantml", help="Run the read-only InstantML hosted Cloud Run benchmark.")
    instant.add_argument("--output", default=str(BENCHMARK_DIR / "instantml-cloud-run-result.json"))
    instant.add_argument("--samples", type=int, default=0)
    instant.add_argument("--warmups", type=int, default=0)
    instant.add_argument("--direct", action="store_true", help="Skip the Node benchmark and use the direct read-only Python fallback.")
    instant.add_argument("--fallback-direct", action=argparse.BooleanOptionalAction, default=True)
    instant.set_defaults(func=benchmark_instantml)

    render = sub.add_parser("render-results", help="Render RESULTS.md from sanitized JSON outputs.")
    render.add_argument("--instantml-json", default=str(BENCHMARK_DIR / "instantml-cloud-run-result.json"))
    render.add_argument("--wandb-json", default=str(BENCHMARK_DIR / "wandb-hosted-result.json"))
    render.add_argument("--output", default=str(BENCHMARK_DIR / "RESULTS.md"))
    render.set_defaults(func=render_results)
    return parser


def env_optional_int(name: str) -> int | None:
    raw = os.environ.get(name)
    if not raw:
        return None
    return int(raw)


def main(argv: list[str] | None = None) -> None:
    load_dotenv(REPO_ROOT / ".env")
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "benchmark-wandb":
        wandb = require_wandb()
        args._api = wandb.Api(timeout=args.timeout)
        entity = default_entity(wandb, args.entity or os.environ.get("WANDB_ENTITY"))
        args._api_path = f"{entity}/{args.project}"
    args.func(args)


if __name__ == "__main__":
    main()
