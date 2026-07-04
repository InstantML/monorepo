from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

import instantml as im
from instantml.errors import InstantMLError
from instantml.integrations import _common
from instantml.integrations import catboost as catboost_module
from instantml.integrations import lightgbm as lightgbm_module
from instantml.integrations import optuna as optuna_module
from instantml.integrations import stable_baselines as stable_baselines_module
from instantml.integrations import xgboost as xgboost_module
from instantml.integrations.datasets import log_dvc_metadata, log_hf_dataset


class FakeRun:
    def __init__(self) -> None:
        self.logs: list[tuple[dict[str, Any], int | float | None]] = []
        self.configs: list[dict[str, Any]] = []
        self.artifacts: list[dict[str, Any]] = []
        self.finished: list[str] = []
        self._is_finished = False

    def log(self, data: dict[str, Any], step: int | float | None = None) -> None:
        self.logs.append((data, step))

    def log_config(self, data: dict[str, Any], flatten: bool = True) -> None:
        self.configs.append(data)

    def log_artifact(
        self,
        name: str,
        uri: str,
        artifact_type: str = "file",
        step: int | float | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        payload = {"name": name, "uri": uri, "type": artifact_type, "step": step, **kwargs}
        self.artifacts.append(payload)
        return payload

    def finish(self, status: str = "finished") -> None:
        if self._is_finished:
            return
        self._is_finished = True
        self.finished.append(status)


def _install_module(monkeypatch: pytest.MonkeyPatch, name: str, module: ModuleType | None = None) -> ModuleType:
    module = module or ModuleType(name)
    monkeypatch.setitem(sys.modules, name, module)
    return module


def test_imports_and_top_level_exports_stay_lazy() -> None:
    sdk_root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{sdk_root}{os.pathsep}{env.get('PYTHONPATH', '')}"
    script = """
import sys
import instantml
import instantml.integrations

assert instantml.OptunaCallback
optional = {
    'optuna',
    'xgboost',
    'lightgbm',
    'catboost',
    'stable_baselines3',
    'datasets',
    'dvc',
}
loaded = optional.intersection(sys.modules)
assert not loaded, sorted(loaded)
"""
    subprocess.run([sys.executable, "-c", script], env=env, check=True)


def test_missing_dependency_error_has_install_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing_import(name: str) -> Any:
        raise ImportError(name)

    monkeypatch.setattr(_common.importlib, "import_module", missing_import)

    with pytest.raises(InstantMLError, match=r'instantml\[optuna\]'):
        optuna_module.InstantMLCallback()


def test_common_helpers_cover_redaction_bounds_and_optional_base(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert _common.optional_base("missing.framework", "Callback") is None
    module = _install_module(monkeypatch, "framework_without_callback")
    assert _common.optional_base(module.__name__, "Callback") is None
    assert _common.sanitize_metric_key() is None
    assert _common.sanitize_metric_key("x" * 600) is None
    assert _common.latest_scalar([]) is None
    assert _common.latest_scalar(object()) is None
    assert _common.latest_scalar([(0.7, 0.03)]) == 0.7
    assert _common.latest_scalar(SimpleNamespace(item=lambda: 2.5)) == 2.5
    assert _common.json_safe_config(None) == {}
    assert _common.json_safe_config(
        {
            "nested": {"lr": 0.1, "bad": object(), "password": "secret"},
            "items": [1, object(), "ok"],
            "nan": float("nan"),
        }
    ) == {"nested": {"lr": 0.1, "password": "[redacted]"}, "items": [1, "ok"]}
    assert _common.redact_metadata(float("nan")) is None
    assert _common.safe_path_string("") == ""
    assert _common.safe_path_string("relative/path.txt") == "relative/path.txt"
    assert _common.safe_path_string(str(tmp_path / "data.jsonl"), cwd=tmp_path) == "./data.jsonl"
    assert _common.safe_path_string("Bearer abcdefghijklmnopqrstuvwxyz") == "[redacted]"
    with pytest.raises(TypeError, match="preview_rows"):
        _common.clamp_preview_rows(True)
    with pytest.raises(ValueError, match="positive"):
        _common.clamp_preview_rows(0)
    bounded = _common.bounded_metadata({"kind": "huge", "items": ["x" * 2000 for _ in range(100)]})
    assert bounded["truncated"] is True
    assert bounded["kind"] == "huge"


def test_common_scalar_collection_accepts_numpy_numbers_when_available() -> None:
    np = pytest.importorskip("numpy")

    metrics = _common.collect_scalar_metrics(
        {"float32": np.float32(2.5), "int64": np.int64(7), "float64": np.float64(9.0)}
    )

    assert metrics == {"float32": 2.5, "int64": 7.0, "float64": 9.0}


def test_optuna_callback_logs_completed_trial_metrics_and_config(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "optuna")
    run = FakeRun()
    callback = optuna_module.InstantMLCallback(run=run)
    study = SimpleNamespace(study_name="cartpole-hpo", direction="MINIMIZE")
    trial = SimpleNamespace(
        number=7,
        state=SimpleNamespace(name="COMPLETE"),
        value=0.42,
        params={"lr": 0.01, "token": "secret-value"},
        intermediate_values={0: 0.9, "validation": 0.5},
        user_attrs={"metric/wall_time": 12.0, "note": "kept out"},
    )

    callback(study, trial)

    assert run.logs == [
        (
            {
                "optuna/value": 0.42,
                "optuna/intermediate/step_0": 0.9,
                "optuna/intermediate/validation": 0.5,
                "optuna/user_attrs/wall_time": 12.0,
            },
            7,
        )
    ]
    assert run.configs == [
        {
            "optuna": {
                "params": {"lr": 0.01, "token": "[redacted]"},
                "study_name": "cartpole-hpo",
                "direction": "MINIMIZE",
            }
        }
    ]


def test_optuna_callback_skips_failed_or_pruned_trials(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "optuna")
    run = FakeRun()
    callback = optuna_module.InstantMLCallback(run=run)

    callback(SimpleNamespace(), SimpleNamespace(state=SimpleNamespace(name="PRUNED"), value=1.0))
    callback(SimpleNamespace(), SimpleNamespace(state=SimpleNamespace(name="FAIL"), value=2.0))

    assert run.logs == []
    assert run.configs == []


def test_optuna_callback_owned_run_and_study_completion(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "optuna")
    run = FakeRun()
    monkeypatch.setattr(_common, "init", lambda **kwargs: run)
    callback = optuna_module.InstantMLCallback(
        project="owned-optuna",
        step_attr="custom_step",
        finish_on_complete=True,
    )
    study = SimpleNamespace(study_name="study", direction="", best_value=0.1)
    trial = SimpleNamespace(
        custom_step=12,
        state=SimpleNamespace(name="COMPLETE"),
        value=0.2,
        params={},
        intermediate_values={},
        user_attrs={},
    )
    study.trials = [trial]

    callback(study, trial)
    callback.study_complete(study)

    assert run.logs == [({"optuna/value": 0.2}, 12), ({"optuna/best_value": 0.1}, None)]
    assert run.finished == ["finished"]


def test_optuna_study_incomplete_does_not_auto_finish(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "optuna")
    run = FakeRun()
    callback = optuna_module.InstantMLCallback(run=run, finish_on_complete=True)
    study = SimpleNamespace(trials=[SimpleNamespace(state=SimpleNamespace(name="COMPLETE"), value=None)])

    callback(study, SimpleNamespace(number="bad", state=None, value=None, params={}, intermediate_values={}, user_attrs={}))

    assert run.finished == []


def test_optuna_multi_objective_properties_do_not_abort_callback(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "optuna")
    run = FakeRun()
    callback = optuna_module.InstantMLCallback(run=run)

    class MultiObjectiveTrial:
        number = 1
        state = SimpleNamespace(name="COMPLETE")
        params = {"lr": 0.1}
        intermediate_values: dict[int, float] = {}
        user_attrs: dict[str, float] = {}

        @property
        def value(self) -> float:
            raise RuntimeError("multi-objective")

    class MultiObjectiveStudy:
        study_name = "multi"
        trials = [MultiObjectiveTrial()]

        @property
        def direction(self) -> str:
            raise RuntimeError("multi-objective")

        @property
        def best_value(self) -> float:
            raise RuntimeError("multi-objective")

    study = MultiObjectiveStudy()

    callback(study, study.trials[0])
    callback.study_complete(study)

    assert run.logs == []
    assert run.configs == [{"optuna": {"params": {"lr": 0.1}, "direction": "multi-objective", "study_name": "multi"}}]


def test_xgboost_callback_subclasses_base_and_logs_latest_values(monkeypatch: pytest.MonkeyPatch) -> None:
    class TrainingCallback:
        pass

    xgb = _install_module(monkeypatch, "xgboost")
    callback_module = _install_module(monkeypatch, "xgboost.callback")
    callback_module.TrainingCallback = TrainingCallback
    xgb.callback = callback_module
    run = FakeRun()

    callback = xgboost_module.InstantMLCallback(run=run, params={"eta": 0.1, "bad": object()})

    assert isinstance(callback, TrainingCallback)
    assert callback.after_iteration(None, 3, {"train": {"rmse": [2.0, 1.5]}, "valid": {"auc": 0.8}, "cv": {"rmse": [(1.2, 0.1), (1.0, 0.05)]}}) is False
    assert run.configs == [{"xgboost": {"eta": 0.1}}]
    assert run.logs == [({"train/rmse": 1.5, "valid/auc": 0.8, "cv/rmse": 1.0}, 3)]
    assert callback.after_training("model") == "model"
    assert run.finished == []


def test_xgboost_subclass_keeps_plain_new_path(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "xgboost")

    class ChildCallback(xgboost_module.InstantMLCallback):
        pass

    assert type(ChildCallback(run=FakeRun(), check_dependency=False)) is ChildCallback


def test_lightgbm_callback_logs_train_and_cv_tuple_shapes(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "lightgbm")
    run = FakeRun()
    callback = lightgbm_module.InstantMLCallback(run=run)
    env = SimpleNamespace(
        iteration=4,
        params={"learning_rate": 0.05, "api_key": "not-for-logs"},
        evaluation_result_list=[
            ("train", "loss", 0.7, False),
            ("cv", "auc", 0.8, True, 0.03),
        ],
    )

    callback(env)

    assert run.configs == [{"lightgbm": {"learning_rate": 0.05, "api_key": "[redacted]"}}]
    assert run.logs == [({"train/loss": 0.7, "cv/auc-mean": 0.8, "cv/auc-stdv": 0.03}, 4)]


def test_lightgbm_callback_ignores_malformed_tuples(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "lightgbm")
    run = FakeRun()
    callback = lightgbm_module.InstantMLCallback(run=run)

    callback(SimpleNamespace(iteration=1, params={}, evaluation_result_list=[("bad",), ("valid", "loss", object())]))

    assert run.logs == []


def test_catboost_callback_logs_metrics_and_respects_finish_run(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "catboost")
    run = FakeRun()
    callback = catboost_module.InstantMLCallback(run=run, config={"depth": 6}, finish_run=True)
    info = SimpleNamespace(
        iteration=5,
        total_iterations=5,
        metrics={"learn": {"Logloss": [0.8, 0.6]}, "validation": {"AUC": [0.7, 0.9], "ignored": "text"}},
    )

    assert callback.after_iteration(info) is True
    callback.after_train()

    assert run.configs == [{"catboost": {"depth": 6}}]
    assert run.logs == [({"learn/Logloss": 0.6, "validation/AUC": 0.9}, 5)]
    assert run.finished == ["finished"]


def test_catboost_adapter_created_run_finishes(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_module(monkeypatch, "catboost")
    run = FakeRun()
    monkeypatch.setattr(_common, "init", lambda **kwargs: run)
    callback = catboost_module.InstantMLCallback(project="cat-owned")

    callback.after_iteration(SimpleNamespace(iteration=1, total_iterations=1, metrics={"learn": {"loss": 1.0}}))

    assert run.logs == [({"learn/loss": 1.0}, 1)]
    assert run.finished == ["finished"]


def test_stable_baselines_callback_subclasses_base_and_logs_episode_values(monkeypatch: pytest.MonkeyPatch) -> None:
    class BaseCallback:
        def __init__(self, verbose: int = 0) -> None:
            self.verbose = verbose

    sb3 = _install_module(monkeypatch, "stable_baselines3")
    common = _install_module(monkeypatch, "stable_baselines3.common")
    callbacks = _install_module(monkeypatch, "stable_baselines3.common.callbacks")
    callbacks.BaseCallback = BaseCallback
    common.callbacks = callbacks
    sb3.common = common
    run = FakeRun()

    callback = stable_baselines_module.InstantMLCallback(run=run, finish_run=True, verbose=2)
    callback.locals = {"infos": [{"episode": {"r": 11.5, "l": 42}}, {"episode": {"r": 8.0, "l": 39}}]}
    callback.logger = SimpleNamespace(name_to_value={"train/fps": 300, "ignored": object()})
    callback.num_timesteps = 128

    assert isinstance(callback, BaseCallback)
    assert callback.verbose == 2
    assert callback._on_step() is True
    callback._on_rollout_end()
    callback._on_rollout_end()
    callback.log_rollout("rollouts/eval.mp4")
    callback._on_training_end()

    assert run.logs == [
        (
            {
                "rl/episode_reward": 9.75,
                "rl/episode_reward_max": 11.5,
                "rl/episode_reward_min": 8.0,
                "rl/episode_length": 40.5,
                "rl/episode_length_max": 42.0,
                "rl/episode_length_min": 39.0,
                "rl/episodes": 2.0,
            },
            128,
        ),
        ({"rl/train/fps": 300.0}, 128),
    ]
    assert run.artifacts == [
        {"name": "rl/rollout", "uri": "file://rollouts/eval.mp4", "type": "rollout", "step": 128}
    ]
    assert run.finished == ["finished"]


def test_stable_baselines_no_metric_and_subclass_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    run = FakeRun()

    class ChildCallback(stable_baselines_module.InstantMLCallback):
        pass

    child = ChildCallback(run=run, check_dependency=False)
    child.locals = {"infos": [object(), {"episode": "bad"}]}
    child.logger = SimpleNamespace(name_to_value=None)
    child.num_timesteps = 1

    assert type(child) is ChildCallback
    assert child._on_step() is True
    child._on_rollout_end()
    assert run.logs == []


class FakeSelectedDataset:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def to_list(self) -> list[dict[str, Any]]:
        return self._rows


class FakeHFDataset:
    num_rows = 2
    num_columns = 2
    column_names = ["text", "path"]
    split = "train"
    _fingerprint = "abc123"
    features = {"text": "string", "path": "string"}
    cache_files = [{"filename": f"{Path.home()}/.cache/huggingface/token=secret/data.arrow"}]
    info = SimpleNamespace(builder_name="fake", dataset_name="demo", version="1.0.0", description="x" * 1500)

    def select(self, rows: range) -> FakeSelectedDataset:
        return FakeSelectedDataset(
            [
                {"text": "hello", "path": f"{Path.home()}/private/train.jsonl", "api_token": "abc123"},
                {"text": "world", "path": "/tmp/instantml/data.jsonl"},
            ][: len(list(rows))]
        )


def test_log_hf_dataset_records_bounded_metadata_and_preview() -> None:
    run = FakeRun()

    metadata = log_hf_dataset(run, FakeHFDataset(), key="data/train", include_preview=True, preview_rows=200)

    assert metadata["kind"] == "huggingface_dataset"
    assert metadata["num_rows"] == 2
    assert metadata["cache_files"][0]["filename"] == "[redacted]"
    assert len(metadata["info"]["description"]) <= 1014
    assert run.configs[0]["datasets"]["data"]["train"] == metadata
    table = run.logs[0][0]["datasets/data/train/preview"]
    assert table.rows[0]["path"] == "train.jsonl"
    assert table.rows[0]["api_token"] == "[redacted]"


def test_log_hf_dataset_dict_logs_each_split_without_preview_scan() -> None:
    run = FakeRun()

    metadata = log_hf_dataset(run, {"train": FakeHFDataset(), "validation": FakeHFDataset()}, key="hf")

    assert metadata["kind"] == "huggingface_dataset_dict"
    assert set(metadata["splits"]) == {"train", "validation"}
    assert run.logs == []


class IndexableDataset:
    num_rows = 3
    column_names = ["value"]

    def __getitem__(self, index: int) -> dict[str, Any]:
        if index >= 2:
            raise IndexError(index)
        return {"value": index}


class BrokenSplitDict(dict):
    def __getitem__(self, key: str) -> Any:
        raise RuntimeError("split failed")


class SelectedByIndex:
    def __len__(self) -> int:
        return 2

    def __getitem__(self, index: int) -> str:
        return f"row-{index}"


class SelectNoToListDataset:
    num_rows = 2

    def select(self, rows: range) -> SelectedByIndex:
        return SelectedByIndex()


class EmptySelectDataset:
    num_rows = 0

    def select(self, rows: range) -> FakeSelectedDataset:
        raise IndexError("empty dataset should not be selected")


def test_dataset_preview_fallbacks_and_split_errors() -> None:
    run = FakeRun()
    metadata = log_hf_dataset(run, IndexableDataset(), key="indexed", include_preview=True)
    assert metadata["column_names"] == ["value"]
    assert run.logs[0][0]["datasets/indexed/preview"].rows == [{"value": 0}, {"value": 1}]

    selected_run = FakeRun()
    log_hf_dataset(selected_run, SelectNoToListDataset(), key="selected", include_preview=True)
    assert selected_run.logs[0][0]["datasets/selected/preview"].rows == [{"value": "row-0"}, {"value": "row-1"}]

    broken = log_hf_dataset(FakeRun(), BrokenSplitDict({"train": object()}), key="broken")
    assert broken["splits"]["train"] == {"error": "metadata unavailable"}

    empty_run = FakeRun()
    metadata = log_hf_dataset(empty_run, EmptySelectDataset(), key="empty", include_preview=True)
    assert metadata["num_rows"] == 0
    assert empty_run.logs == []


def test_log_dvc_metadata_reads_local_metadata_files(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    data_dir = repo / "data"
    data_dir.mkdir()
    (data_dir / "train.csv.dvc").write_text(
        """
outs:
- path: data/train.csv
  md5: nested123
  size: 10
""",
        encoding="utf-8",
    )
    (repo / "dvc.lock").write_text(
        """
schema: '2.0'
stages:
  prepare:
    outs:
    - path: /Users/example/private/raw.csv
      md5: abc123
      size: 42
""",
        encoding="utf-8",
    )
    run = FakeRun()

    metadata = log_dvc_metadata(run, repo_path=repo, key="data/dvc")

    assert metadata["kind"] == "dvc"
    assert metadata["repo"] == "repo"
    files = {item["path"]: item for item in metadata["files"]}
    assert files["dvc.lock"]["entries"][0]["path"] == "raw.csv"
    assert files["dvc.lock"]["entries"][0]["md5"] == "abc123"
    assert files["dvc.lock"]["entries"][0]["section"] == "outs"
    assert files["data/train.csv.dvc"]["entries"][0]["path"] == "data/train.csv"
    assert files["data/train.csv.dvc"]["entries"][0]["md5"] == "nested123"
    assert run.configs[0]["datasets"]["data"]["dvc"] == metadata


def test_log_dvc_metadata_reports_missing_repo(tmp_path: Path) -> None:
    with pytest.raises(InstantMLError, match="does not exist"):
        log_dvc_metadata(FakeRun(), repo_path=tmp_path / "missing")


def test_log_dvc_metadata_reports_repo_without_dvc_files(tmp_path: Path) -> None:
    with pytest.raises(InstantMLError, match="no DVC metadata"):
        log_dvc_metadata(FakeRun(), repo_path=tmp_path)
