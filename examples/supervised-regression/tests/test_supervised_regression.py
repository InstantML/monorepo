import argparse
import importlib.util
import json
import sys
from pathlib import Path

import pytest

TRAIN_PATH = Path(__file__).resolve().parents[1] / "train.py"
SPEC = importlib.util.spec_from_file_location("supervised_regression_train", TRAIN_PATH)
train = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = train
SPEC.loader.exec_module(train)

CONFIGS = train.CONFIGS
ExperimentConfig = train.ExperimentConfig


def test_dataset_generation_is_deterministic_and_regression_shaped():
    rows, targets = train.build_dataset(seed=3, examples=5, features=4)
    rows_again, targets_again = train.build_dataset(seed=3, examples=5, features=4)

    assert rows == rows_again
    assert targets == targets_again
    assert len(rows) == 5
    assert len(rows[0]) == 4
    assert all(isinstance(value, float) for value in targets)


def test_training_reduces_validation_loss():
    config = ExperimentConfig(name="test", learning_rate=0.045, l2=0.0005, epochs=8, features=5)
    train_rows, train_targets, val_rows, val_targets = train.make_split(seed=17, config=config)
    weights, bias = train.initial_parameters(seed=17, features=config.features)
    starting = train.evaluate(weights, bias, val_rows, val_targets)["loss"]

    for _ in range(config.epochs):
        weights, bias, _ = train.train_one_epoch(
            weights,
            bias,
            train_rows,
            train_targets,
            config.learning_rate,
            config.l2,
        )

    ending = train.evaluate(weights, bias, val_rows, val_targets)["loss"]
    assert ending < starting


def test_run_experiment_logs_metrics_and_artifacts(monkeypatch):
    calls = []

    class FakeRun:
        run_id = "run-123"

        def log(self, metrics, step):
            calls.append(("log", step, metrics))

        def log_checkpoint(self, **kwargs):
            calls.append(("checkpoint", kwargs))

        def log_artifact(self, **kwargs):
            calls.append(("artifact", kwargs))

        def log_rollout(self, **kwargs):
            calls.append(("rollout", kwargs))

        def finish(self, status="finished"):
            calls.append(("finish", status))

    def fake_init(**kwargs):
        calls.append(("init", kwargs))
        return FakeRun()

    monkeypatch.setattr(train.im, "init", fake_init)

    result = train.run_experiment(
        ExperimentConfig(name="tiny", learning_rate=0.04, l2=0.001, epochs=4, features=3),
        seed=5,
        server="http://local",
        artifact_metadata=True,
    )

    assert calls[0][0] == "init"
    assert calls[0][1]["project"] == "supervised-regression"
    assert calls[0][1]["base_url"] == "http://local"
    assert calls[0][1]["tags"] == ["example", "supervised", "tiny"]
    assert "validation loss" in calls[0][1]["notes"]
    assert [call[1] for call in calls if call[0] == "log"] == [1, 2, 3, 4]
    assert sum(1 for call in calls if call[0] == "checkpoint") == 2
    assert sum(1 for call in calls if call[0] == "artifact") == 1
    assert sum(1 for call in calls if call[0] == "rollout") == 1
    assert calls[-1] == ("finish", "finished")
    assert result["name"] == "tiny-seed-5"
    assert result["final_val_loss"] > 0


def test_run_experiment_can_skip_artifact_metadata(monkeypatch):
    class FakeRun:
        run_id = "run-456"

        def log(self, metrics, step):
            pass

        def finish(self):
            pass

    monkeypatch.setattr(train.im, "init", lambda **kwargs: FakeRun())

    result = train.run_experiment(
        ExperimentConfig(name="tiny", learning_rate=0.04, l2=0.001, epochs=2, features=3),
        seed=6,
        server="http://local",
        artifact_metadata=False,
    )

    assert result["run_id"] == "run-456"


def test_run_experiment_marks_failed_on_exception(monkeypatch):
    calls = []

    class FakeRun:
        run_id = "run-error"

        def finish(self, status="finished"):
            calls.append(("finish", status))

    monkeypatch.setattr(train.im, "init", lambda **kwargs: FakeRun())
    monkeypatch.setattr(train, "train_one_epoch", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))

    with pytest.raises(RuntimeError, match="boom"):
        train.run_experiment(
            ExperimentConfig(name="tiny", learning_rate=0.04, l2=0.001, epochs=2, features=3),
            seed=7,
            server="http://local",
            artifact_metadata=False,
        )

    assert calls == [("finish", "failed")]


def test_parse_seeds_rejects_empty_values():
    assert train.parse_seeds("1, 2,3") == [1, 2, 3]
    with pytest.raises(argparse.ArgumentTypeError):
        train.parse_seeds(",")


def test_write_summary(tmp_path):
    path = tmp_path / "nested" / "summary.json"
    train.write_summary(path, [{"name": "run"}])

    assert json.loads(path.read_text(encoding="utf-8")) == {"runs": [{"name": "run"}]}
    train.write_summary(None, [{"name": "ignored"}])


def test_configs_are_distinct_for_ui_comparison():
    assert len({config.name for config in CONFIGS}) == len(CONFIGS)
    assert len({config.learning_rate for config in CONFIGS}) > 1


def test_make_split_standard_library_path(monkeypatch):
    monkeypatch.setattr(train, "np", None)
    config = ExperimentConfig(name="stdlib", learning_rate=0.01, l2=0.0, features=3, train_examples=4, validation_examples=2)

    train_rows, train_targets, val_rows, val_targets = train.make_split(seed=4, config=config)

    assert len(train_rows) == 4
    assert len(train_targets) == 4
    assert len(val_rows) == 2
    assert len(val_targets) == 2


def test_main_runs_config_sweep(monkeypatch, tmp_path, capsys):
    calls = []

    def fake_run_experiment(config, seed, server, artifact_metadata):
        calls.append((config.name, seed, server, artifact_metadata, config.epochs))
        return {"name": f"{config.name}-{seed}", "run_id": "run", "final_val_loss": 1.25, "final_val_r2": 0.5}

    monkeypatch.setattr(train, "run_experiment", fake_run_experiment)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "train.py",
            "--server",
            "http://local",
            "--seeds",
            "3",
            "--epochs",
            "2",
            "--no-artifact-metadata",
            "--summary-json",
            str(tmp_path / "summary.json"),
        ],
    )

    train.main()

    assert len(calls) == len(CONFIGS)
    assert all(call[2:] == ("http://local", False, 2) for call in calls)
    assert "val/loss=1.2500" in capsys.readouterr().out
    assert json.loads((tmp_path / "summary.json").read_text(encoding="utf-8"))["runs"][0]["run_id"] == "run"
