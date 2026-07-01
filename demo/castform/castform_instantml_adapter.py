#!/usr/bin/env python3
"""Mirror one Castform run into InstantML.

This is a demo/planning artifact, not a packaged integration. It uses the public
Benchmax client methods observed in the Castform SDK repo and the InstantML
Python SDK surface documented in this repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from typing import Any

from demo_env import load_demo_env


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _castform_url(run_id: str) -> str:
    base = os.environ.get("CASTFORM_APP_URL", "https://app.castform.com").rstrip("/")
    return f"{base}/train/{run_id}"


def _safe_metric_part(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip().lower())
    return cleaned.strip("_") or "metric"


def _normalize_metric_key(mode: str, source_name: str) -> str:
    name = source_name.strip()
    aliases = {
        "average reward": "reward_mean",
        "avg reward": "reward_mean",
        "mean reward": "reward_mean",
        "max reward": "reward_max",
        "solve rate": "solve_rate",
        "pass@k": "solve_rate",
        "response lengths": "response_tokens_mean",
        "response length": "response_tokens_mean",
    }
    normalized = aliases.get(name.lower(), _safe_metric_part(name))
    return f"{_safe_metric_part(mode)}/{normalized}"


def _latest_step_from_scalars(scalars_by_mode: dict[str, dict[str, list[dict[str, Any]]]]) -> int:
    latest = 0
    for scalars in scalars_by_mode.values():
        for series in scalars.values():
            for point in series:
                step = point.get("step")
                if isinstance(step, (int, float)):
                    latest = max(latest, int(step))
    return latest


def _final_metrics_from_scalars(scalars_by_mode: dict[str, dict[str, list[dict[str, Any]]]]) -> dict[str, float]:
    final: dict[str, float] = {}
    for mode, scalars in scalars_by_mode.items():
        for source_name, series in scalars.items():
            key = _normalize_metric_key(mode, source_name)
            points = [
                point for point in series
                if isinstance(point.get("value"), (int, float)) and isinstance(point.get("step"), (int, float))
            ]
            if not points:
                continue
            latest = max(points, key=lambda point: (int(point.get("step", 0)), str(point.get("createdAt") or point.get("created_at") or "")))
            final[key] = float(latest["value"])
    return final


def _flatten_launcher_args(run: dict[str, Any]) -> dict[str, Any]:
    launcher_args = run.get("launcherArgs") or run.get("launcher_args") or {}
    if isinstance(launcher_args, dict):
        return launcher_args
    return {"raw_launcher_args": launcher_args}


def mirror_castform_run(
    *,
    castform_run_id: str,
    instantml_project: str,
    castform_api_key: str,
    instantml_api_key: str,
    castform_base_url: str | None,
    instantml_base_url: str | None,
    include_logs: bool,
    dry_run: bool,
) -> dict[str, Any]:
    from benchmax.platform.client import TrainerClient
    import instantml as im

    trainer_kwargs: dict[str, Any] = {"api_key": castform_api_key}
    if castform_base_url:
        trainer_kwargs["base_url"] = castform_base_url

    with TrainerClient(**trainer_kwargs) as castform:
        source_run = castform.get_run(castform_run_id, include_config=True)
        details = castform.get_run_details(castform_run_id)
        modes = details.get("modes") or ["train"]
        scalars_by_mode = {
            str(mode): castform.get_run_scalars(castform_run_id, str(mode))
            for mode in modes
        }
        events = castform.get_run_events(castform_run_id)
        logs = castform.get_environment_logs(castform_run_id) if include_logs else []

    summary = {
        "castform_run_id": castform_run_id,
        "castform_url": _castform_url(castform_run_id),
        "name": source_run.get("name") or f"castform-{castform_run_id}",
        "source_status": source_run.get("status"),
        "modes": list(scalars_by_mode),
        "metric_count": sum(len(scalars) for scalars in scalars_by_mode.values()),
        "event_count": len(events),
        "log_count": len(logs),
        "final_metrics": _final_metrics_from_scalars(scalars_by_mode),
        "launcher_args": _flatten_launcher_args(source_run),
    }

    if dry_run:
        print(json.dumps(summary, indent=2, sort_keys=True))
        return summary

    launcher_args = _flatten_launcher_args(source_run)
    run_name = source_run.get("name") or f"castform-{castform_run_id}"
    notes = (
        f"Mirrored from Castform on {datetime.now(timezone.utc).isoformat()}\n"
        f"Castform run: {_castform_url(castform_run_id)}"
    )
    config = {
        "castform": {
            "run_id": castform_run_id,
            "url": _castform_url(castform_run_id),
            "status": source_run.get("status"),
            "created_at": source_run.get("createdAt") or source_run.get("created_at"),
            "updated_at": source_run.get("updatedAt") or source_run.get("updated_at"),
            "launcher_args": launcher_args,
            "details": details,
        },
        "launcher_args": launcher_args,
    }

    init_kwargs: dict[str, Any] = {
        "project": instantml_project,
        "name": run_name,
        "config": config,
        "tags": ["castform", "mirrored", str(source_run.get("status") or "unknown")],
        "notes": notes,
        "api_key": instantml_api_key,
        "upload_mode": "sync",
    }
    if instantml_base_url:
        init_kwargs["base_url"] = instantml_base_url

    run = im.init(**init_kwargs)
    try:
        for mode, scalars in scalars_by_mode.items():
            for source_name, series in scalars.items():
                key = _normalize_metric_key(mode, source_name)
                for point in series:
                    value = point.get("value")
                    step = point.get("step")
                    if isinstance(value, (int, float)) and isinstance(step, (int, float)):
                        run.log({key: float(value)}, step=int(step))

        latest_step = _latest_step_from_scalars(scalars_by_mode)
        if events:
            run.log_text(
                {"castform/events": json.dumps(events, indent=2, sort_keys=True)},
                step=latest_step,
            )
        if logs:
            rendered_logs = []
            for entry in logs:
                rendered_logs.append(
                    "{created_at} [{level}] {content}".format(
                        created_at=entry.get("createdAt") or entry.get("created_at") or "",
                        level=entry.get("level") or "info",
                        content=entry.get("content") or entry.get("message") or "",
                    )
                )
            run.log_stdout(rendered_logs)
            run.log_text({"castform/environment_logs": "\n".join(rendered_logs)}, step=latest_step)
    finally:
        status = str(source_run.get("status") or "").lower()
        final_status = "failed" if "fail" in status or "error" in status else "finished"
        run.finish(status=final_status)

    summary["instantml_run_id"] = run.run_id
    print(json.dumps(summary, indent=2, sort_keys=True))
    return summary


def main() -> int:
    load_demo_env()
    parser = argparse.ArgumentParser(description="Mirror one Castform run into InstantML")
    parser.add_argument("--castform-run-id", required=True)
    parser.add_argument("--instantml-project", default="castform-demo")
    parser.add_argument("--castform-base-url")
    parser.add_argument("--instantml-base-url")
    parser.add_argument("--no-logs", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    mirror_castform_run(
        castform_run_id=args.castform_run_id,
        instantml_project=args.instantml_project,
        castform_api_key=_require_env("CASTFORM_API_KEY"),
        instantml_api_key=_require_env("INSTANTML_API_KEY"),
        castform_base_url=args.castform_base_url,
        instantml_base_url=args.instantml_base_url,
        include_logs=not args.no_logs,
        dry_run=args.dry_run,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
