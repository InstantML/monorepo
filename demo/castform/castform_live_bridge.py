#!/usr/bin/env python3
"""Small live Castform SDK bridge for the hosted InstantML demo.

This helper is intentionally thin. It does not replace Castform's own CLI
workflow; it gives the demo an explicit SDK launch path for environments that
have already been validated and uploaded through Castform/Benchmax.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / "run-output" / "castform-launch.json"
DEFAULT_CASTFORM_APP_BASE = "https://app.castform.com"


def parse_launcher_arg(raw: str) -> tuple[str, Any]:
    if "=" not in raw:
        raise SystemExit(f"--launcher-arg must be key=value, got {raw!r}")
    key, value = raw.split("=", 1)
    key = key.strip()
    if not key:
        raise SystemExit("--launcher-arg key must not be empty")
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        decoded = value
    return key, decoded


def launch_from_uploaded_assets(
    *,
    training_run_type: str,
    env_cls_path: str,
    env_metadata_path: str,
    train_dataset_path: str,
    eval_dataset_path: str,
    name: str | None,
    launcher_args: dict[str, Any],
    castform_api_key: str | None,
    castform_base_url: str | None,
    castform_app_base: str,
) -> dict[str, Any]:
    try:
        from benchmax.platform.client import TrainerClient
    except ImportError as exc:
        raise SystemExit(
            "benchmax/castform SDK is not installed. Install with `uv pip install castform` "
            "or run `uv tool install -U castform` before using live launch mode."
        ) from exc

    trainer_kwargs: dict[str, Any] = {}
    if castform_api_key:
        trainer_kwargs["api_key"] = castform_api_key
    if castform_base_url:
        trainer_kwargs["base_url"] = castform_base_url

    with TrainerClient(**trainer_kwargs) as trainer:
        run_id = trainer.launch_training_run(
            training_run_type=training_run_type,
            env_cls_path=env_cls_path,
            env_metadata_path=env_metadata_path,
            train_dataset_path=train_dataset_path,
            eval_dataset_path=eval_dataset_path,
            name=name,
            launcher_args=launcher_args or None,
        )
    return {
        "castform_run_id": run_id,
        "castform_url": f"{castform_app_base.rstrip('/')}/train/{run_id}",
        "training_run_type": training_run_type,
        "name": name,
        "launcher_args": launcher_args,
        "uploaded_assets": {
            "env_cls_path": env_cls_path,
            "env_metadata_path": env_metadata_path,
            "train_dataset_path": train_dataset_path,
            "eval_dataset_path": eval_dataset_path,
        },
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Launch a Castform training run through the Benchmax SDK")
    parser.add_argument("--training-run-type", default="simple", help="Castform training type, for example simple or simple-cpu")
    parser.add_argument("--env-cls-path", required=True, help="Uploaded env-cls.pkl blob path")
    parser.add_argument("--env-metadata-path", required=True, help="Uploaded env-metadata.json blob path")
    parser.add_argument("--train-dataset-path", required=True, help="Uploaded train dataset blob path")
    parser.add_argument("--eval-dataset-path", required=True, help="Uploaded eval dataset blob path")
    parser.add_argument("--name", help="Castform run name")
    parser.add_argument("--launcher-arg", action="append", default=[], metavar="KEY=JSON_VALUE")
    parser.add_argument("--castform-base-url", default=os.environ.get("CASTFORM_BASE_URL"))
    parser.add_argument("--castform-app-base", default=os.environ.get("CASTFORM_APP_URL", DEFAULT_CASTFORM_APP_BASE))
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    launcher_args = dict(parse_launcher_arg(item) for item in args.launcher_arg)
    payload = launch_from_uploaded_assets(
        training_run_type=args.training_run_type,
        env_cls_path=args.env_cls_path,
        env_metadata_path=args.env_metadata_path,
        train_dataset_path=args.train_dataset_path,
        eval_dataset_path=args.eval_dataset_path,
        name=args.name,
        launcher_args=launcher_args,
        castform_api_key=os.environ.get("CASTFORM_API_KEY") or os.environ.get("PLATFORM_API_KEY"),
        castform_base_url=args.castform_base_url,
        castform_app_base=args.castform_app_base,
    )
    write_json(args.output, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
