#!/usr/bin/env python3
"""Log the benchmark dataset to W&B cloud (same data as the InstantML seed).

Reads dataset.json; relies on ~/.netrc for the W&B API key.
"""
import json
import os
import sys

import wandb

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "dataset.json")) as f:
    dataset = json.load(f)

os.environ.setdefault("WANDB_SILENT", "true")
os.environ.setdefault("WANDB_CONSOLE", "off")

runs = dataset["runs"]
only = sys.argv[1] if len(sys.argv) > 1 else None

for i, spec in enumerate(runs):
    if only and spec["name"] != only:
        continue
    run = wandb.init(
        project=spec["project"],
        name=spec["name"],
        config=spec["config"],
        tags=spec["tags"],
        notes=spec.get("notes", ""),
        reinit=True,
    )
    by_step = {}
    for metric, points in (spec.get("series") or {}).items():
        for step, value in points:
            by_step.setdefault(step, {})[metric] = value
    for step in sorted(by_step):
        run.log(by_step[step], step=step)
    run.finish(exit_code=1 if spec["status"] == "failed" else 0)
    print(f"[{i + 1}/{len(runs)}] {spec['name']} ({spec['status']})", flush=True)

print("wandb seed complete")
