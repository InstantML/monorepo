from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import instantml as im
from instantml.integrations.catboost import InstantMLCallback as CatBoostCallback
from instantml.integrations.datasets import log_dvc_metadata, log_hf_dataset
from instantml.integrations.lightgbm import InstantMLCallback as LightGBMCallback
from instantml.integrations.optuna import InstantMLCallback as OptunaCallback
from instantml.integrations.stable_baselines import InstantMLCallback as StableBaselinesCallback
from instantml.integrations.xgboost import InstantMLCallback as XGBoostCallback


class TinySelectedDataset:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def to_list(self) -> list[dict[str, Any]]:
        return self._rows


class TinyDataset:
    num_rows = 2
    num_columns = 2
    column_names = ["text", "label"]
    split = "train"
    _fingerprint = "tiny-v1"
    features = {"text": "string", "label": "int64"}

    def select(self, rows: range) -> TinySelectedDataset:
        data = [{"text": "hello", "label": 1}, {"text": "world", "label": 0}]
        return TinySelectedDataset(data[: len(list(rows))])


def run_smoke(args: argparse.Namespace) -> dict[str, Any]:
    run = im.init(
        project=args.project,
        name="integrations-smoke",
        config={"example": "integrations-smoke"},
        base_url=args.server,
        api_key=args.api_key,
        tags=["example", "integrations"],
    )
    try:
        OptunaCallback(run=run, check_dependency=False)(
            SimpleNamespace(study_name="smoke-study", direction="MINIMIZE"),
            SimpleNamespace(
                number=1,
                state=SimpleNamespace(name="COMPLETE"),
                value=0.25,
                params={"lr": 0.01, "max_depth": 3},
                intermediate_values={0: 0.4, "validation": 0.25},
                user_attrs={"metric/duration_seconds": 12.0},
            ),
        )
        XGBoostCallback(run=run, params={"eta": 0.1}, check_dependency=False).after_iteration(
            None,
            2,
            {"train": {"rmse": [1.0, 0.8]}, "valid": {"rmse": [1.1, 0.9]}},
        )
        LightGBMCallback(run=run, check_dependency=False)(
            SimpleNamespace(
                iteration=3,
                params={"learning_rate": 0.05},
                evaluation_result_list=[("train", "loss", 0.7, False), ("cv", "auc", 0.8, True, 0.02)],
            )
        )
        CatBoostCallback(run=run, config={"depth": 4}, check_dependency=False).after_iteration(
            SimpleNamespace(
                iteration=4,
                metrics={"learn": {"Logloss": [0.9, 0.6]}, "validation": {"AUC": [0.75, 0.88]}},
            )
        )
        rl = StableBaselinesCallback(run=run, check_dependency=False)
        rl.locals = {"infos": [{"episode": {"r": 18.0, "l": 64}}]}
        rl.logger = SimpleNamespace(name_to_value={"train/fps": 500})
        rl.num_timesteps = 128
        rl._on_step()

        log_hf_dataset(run, TinyDataset(), key="data/train", include_preview=True)
        with tempfile.TemporaryDirectory() as tmp_dir:
            repo = Path(tmp_dir)
            (repo / "dvc.lock").write_text(
                """
schema: '2.0'
stages:
  prepare:
    outs:
    - path: data/train.jsonl
      md5: abc123
      size: 128
""",
                encoding="utf-8",
            )
            log_dvc_metadata(run, repo_path=repo, key="data/dvc")
        run.finish()
    except Exception:
        run.finish("failed")
        raise
    return {"project": args.project, "run_id": run.run_id}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Log representative InstantML integration events.")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="InstantML API base URL")
    parser.add_argument("--project", default="integrations-smoke", help="InstantML project name")
    parser.add_argument("--api-key", default=None, help="API key; defaults to INSTANTML_API_KEY or stored login")
    return parser.parse_args()


def main() -> None:
    summary = run_smoke(parse_args())
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
