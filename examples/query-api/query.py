#!/usr/bin/env python3
"""Seed and query a small InstantML project through the public SDK."""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Any

import instantml as im


def _api_key(value: str | None) -> str | None:
    return value or os.environ.get("INSTANTML_API_KEY")


def seed_project(server: str, api_key: str | None, project: str, runs: int) -> None:
    for index in range(runs):
        run = im.init(
            project=project,
            name=f"query-api-demo-{index:02d}",
            config={"seed": index, "lr": 0.001 + index * 0.0001},
            tags=["query-api", "baseline" if index % 2 == 0 else "candidate"],
            notes=f"query api demo run {index}",
            base_url=server,
            api_key=api_key,
            upload_mode="sync",
            async_init=False,
            system_metrics=False,
            source_tracking=False,
        )
        run.log_snapshot(
            {
                "metrics": {
                    "train/loss": 1.0 / 6.0 + index * 0.01,
                    "eval/score": math.tanh(5 / 3.0) + index * 0.001,
                },
                "metadata": {"phase": "eval"},
            },
            step=5,
        )
        run.log_table_object(
            "eval/samples",
            ["sample", "score", "accepted"],
            [
                [f"sample-{index}-a", round(0.65 + index * 0.01, 4), index % 2 == 0],
                [f"sample-{index}-b", round(0.55 + index * 0.01, 4), index % 3 == 0],
            ],
            step=5,
        )
        run.finish("finished")


def summarize(api: im.Api, project: str) -> dict[str, Any]:
    runs = api.query_runs(
        project=project,
        q="tag:query-api status:finished",
        sort_by="metric-best",
        metric_key="eval/score",
        limit=10,
    )
    iterated = list(api.iter_runs(project=project, q="tag:query-api", page_size=7, max_pages=2))
    run_ids = [str(run["id"]) for run in runs.items if "id" in run]
    series = (
        api.query_metrics(run_ids[:5], ["eval/score", "train/loss"], point_limit=25, buckets=10)
        if run_ids
        else im.MetricSeriesPage([], {}, 25)
    )
    objects = (
        api.query_objects(run_id=run_ids[0], kind="table", key="eval/samples", limit=5)
        if run_ids
        else im.Page([], None, {}, 5)
    )
    rows = (
        api.object_rows(objects.items[0]["id"], limit=10)
        if objects.items
        else im.Page([], None, {}, 10)
    )
    return {
        "project": project,
        "run_count_page": len(runs.items),
        "next_cursor": runs.next_cursor,
        "iterated_run_count": len(iterated),
        "metric_series": [
            {
                "run_id": item.get("run_id"),
                "key": item.get("key"),
                "points": len(item.get("metrics", [])),
            }
            for item in series.series
        ],
        "object_count": len(objects.items),
        "row_count": len(rows.items),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default=os.environ.get("INSTANTML_API_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--project", default="query-api-demo")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--skip-seed", action="store_true")
    args = parser.parse_args()

    api_key = _api_key(args.api_key)
    if not api_key:
        raise SystemExit("set INSTANTML_API_KEY or pass --api-key")
    if args.runs < 1:
        raise SystemExit("--runs must be at least 1")
    if not args.skip_seed:
        seed_project(args.server, api_key, args.project, args.runs)

    api = im.Api(base_url=args.server, api_key=api_key)
    print(json.dumps(summarize(api, args.project), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
