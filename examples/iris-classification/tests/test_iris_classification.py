import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

TRAIN_PATH = Path(__file__).resolve().parents[1] / "train.py"
SPEC = importlib.util.spec_from_file_location("iris_classification_train", TRAIN_PATH)
train = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = train
SPEC.loader.exec_module(train)


IRIS_SAMPLE = """\
5.1,3.5,1.4,0.2,Iris-setosa
4.9,3.0,1.4,0.2,Iris-setosa
4.7,3.2,1.3,0.2,Iris-setosa
4.6,3.1,1.5,0.2,Iris-setosa
5.0,3.6,1.4,0.2,Iris-setosa
7.0,3.2,4.7,1.4,Iris-versicolor
6.4,3.2,4.5,1.5,Iris-versicolor
6.9,3.1,4.9,1.5,Iris-versicolor
5.5,2.3,4.0,1.3,Iris-versicolor
6.5,2.8,4.6,1.5,Iris-versicolor
6.3,3.3,6.0,2.5,Iris-virginica
5.8,2.7,5.1,1.9,Iris-virginica
7.1,3.0,5.9,2.1,Iris-virginica
6.3,2.9,5.6,1.8,Iris-virginica
6.5,3.0,5.8,2.2,Iris-virginica

"""


def write_sample(path: Path) -> Path:
    path.write_text(IRIS_SAMPLE, encoding="utf-8")
    return path


def sample_dataset(tmp_path):
    return train.load_dataset(write_sample(tmp_path / "iris.data"))


def test_resolve_dataset_path_existing_and_no_download(tmp_path):
    existing = write_sample(tmp_path / "existing.data")

    assert train.resolve_dataset_path(existing, tmp_path / "cache", allow_download=False) == existing

    with pytest.raises(FileNotFoundError):
        train.resolve_dataset_path(tmp_path / "missing.data", tmp_path / "cache", allow_download=False)


def test_resolve_dataset_path_downloads_to_cache(monkeypatch, tmp_path):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return IRIS_SAMPLE.encode("utf-8")

    monkeypatch.setattr(train.urllib.request, "urlopen", lambda url, timeout: FakeResponse())

    path = train.resolve_dataset_path(None, tmp_path / "cache", allow_download=True)

    assert path.name == "iris.data"
    assert "Iris-setosa" in path.read_text(encoding="utf-8")


def test_resolve_dataset_path_reports_download_failure(monkeypatch, tmp_path):
    def fail(_url, timeout):
        raise OSError("offline")

    monkeypatch.setattr(train.urllib.request, "urlopen", fail)

    with pytest.raises(RuntimeError, match="could not download"):
        train.resolve_dataset_path(None, tmp_path / "cache", allow_download=True)


def test_load_dataset_profile_and_validation_errors(tmp_path):
    dataset = sample_dataset(tmp_path)
    profile = train.dataset_profile(dataset)

    assert dataset.features.shape == (15, 4)
    assert dataset.class_names == train.DEFAULT_CLASSES
    assert profile["classes"]["Iris-setosa"] == 5
    assert profile["feature_mean"]["petal_length_cm"] > 3

    bad = tmp_path / "bad.data"
    bad.write_text("1,2,3,Iris-setosa\n", encoding="utf-8")
    with pytest.raises(ValueError, match="expected 5 columns"):
        train.load_dataset(bad)

    empty = tmp_path / "empty.data"
    empty.write_text("\n", encoding="utf-8")
    with pytest.raises(ValueError, match="dataset is empty"):
        train.load_dataset(empty)


def test_stratified_split_and_standardization_are_deterministic(tmp_path):
    dataset = sample_dataset(tmp_path)
    split = train.stratified_split(dataset.labels, seed=42)
    split_again = train.stratified_split(dataset.labels, seed=42)
    standardized, mean, std = train.standardize(dataset.features[split.train], dataset.features)

    assert split.train.tolist() == split_again.train.tolist()
    assert len(split.train) == 9
    assert len(split.validation) == 3
    assert len(split.test) == 3
    assert np.allclose(standardized[split.train].mean(axis=0), np.zeros(4))
    assert np.all(std > 0)
    assert mean.shape == (4,)

    tiny = np.array([0, 0, 0, 1, 1, 1])
    tiny_split = train.stratified_split(tiny, seed=1)
    assert len(tiny_split.test) == 2

    with pytest.raises(ValueError, match="at least 3 examples"):
        train.stratified_split(np.array([0, 0, 1, 1]), seed=1)


def test_training_evaluation_and_metrics_are_model_shaped(tmp_path):
    dataset = sample_dataset(tmp_path)
    split = train.stratified_split(dataset.labels, seed=7)
    config = train.ExperimentConfig(name="test", learning_rate=0.18, l2=0.001, epochs=18)
    state, history = train.train_model(dataset, split, config, seed=7)
    evaluation = train.evaluate_model(dataset, split, state)
    payload = train.metric_payload(history[-1], evaluation)
    histogram = train.histogram_payload(state.weights.ravel(), bins=4)

    assert len(history) == 18
    assert history[-1]["val/accuracy"] >= history[0]["val/accuracy"]
    assert evaluation["test/accuracy"] >= 2 / 3
    assert 0 <= evaluation["test/ece"] <= 1
    assert payload["test/macro_f1"] >= 0
    assert len(histogram["counts"]) == 4
    assert len(histogram["bins"]) == 5


def test_confusion_matrix_per_class_and_calibration_edge_cases():
    matrix = train.confusion_matrix(np.array([0, 1, 1, 2]), np.array([0, 1, 2, 2]), 3)
    per_class = train.per_class_metrics(matrix, ("a", "b", "c"))
    probabilities = np.array([[0.9, 0.05, 0.05], [0.1, 0.8, 0.1], [0.2, 0.7, 0.1]])

    assert matrix.tolist() == [[1, 0, 0], [0, 1, 1], [0, 0, 1]]
    assert per_class["b"]["recall"] == 0.5
    assert train.macro_f1(per_class) > 0
    assert train.expected_calibration_error(probabilities, np.array([0, 1, 2]), bins=5) >= 0
    assert train.per_class_metrics(np.zeros((2, 2), dtype=int), ("empty-a", "empty-b"))["empty-a"]["f1"] == 0


def test_write_artifacts_and_log_artifacts(tmp_path):
    dataset = sample_dataset(tmp_path)
    split = train.stratified_split(dataset.labels, seed=5)
    state, _history = train.train_model(dataset, split, train.ExperimentConfig("artifact", 0.1, 0.0, epochs=5), seed=5)
    evaluation = train.evaluate_model(dataset, split, state)
    paths = train.write_artifacts(tmp_path / "artifacts", "run-name", dataset, split, state, evaluation)
    calls = []

    class FakeRun:
        def upload_file(self, path, **kwargs):
            calls.append(("upload", Path(path).name, kwargs))

        def log_table(self, name, uri, **kwargs):
            calls.append(("table", name, uri, kwargs))

    train.log_artifacts(FakeRun(), paths, final_epoch=5, evaluation=evaluation)

    assert json.loads(paths["confusion"].read_text(encoding="utf-8"))["matrix"]
    assert "true_class" in paths["predictions"].read_text(encoding="utf-8")
    assert [call[0] for call in calls].count("upload") == 4
    assert calls[-1][0] == "table"


def test_run_experiment_logs_sdk_workflow(monkeypatch, tmp_path):
    dataset = sample_dataset(tmp_path)
    calls = []

    class FakeRun:
        run_id = "run-123"

        def log_metrics(self, metrics, step):
            calls.append(("metrics", step, metrics))

        def log_histogram(self, path, histogram, step):
            calls.append(("histogram", path, histogram, step))

        def upload_file(self, path, **kwargs):
            calls.append(("upload", Path(path).name, kwargs))
            return {"id": Path(path).stem}

        def log_table(self, name, uri, **kwargs):
            calls.append(("table", name, uri, kwargs))

        def finish(self, status="finished"):
            calls.append(("finish", status))

    def fake_init(**kwargs):
        calls.append(("init", kwargs))
        return FakeRun()

    monkeypatch.setattr(train.im, "init", fake_init)

    result = train.run_experiment(
        dataset,
        train.ExperimentConfig("tiny", 0.16, 0.001, epochs=6),
        seed=9,
        server="http://local",
        artifact_dir=tmp_path / "artifacts",
        log_every=3,
        upload_artifacts=True,
    )

    assert calls[0][0] == "init"
    assert calls[0][1]["project"] == "iris-classification"
    assert calls[0][1]["base_url"] == "http://local"
    assert [call[1] for call in calls if call[0] == "metrics"] == [1, 3, 6]
    assert any(call[0] == "histogram" for call in calls)
    assert [call[1] for call in calls if call[0] == "finish"] == ["finished"]
    assert result["run_id"] == "run-123"
    assert result["test_accuracy"] >= 0


def test_run_experiment_marks_failed_on_exception(monkeypatch, tmp_path):
    dataset = sample_dataset(tmp_path)
    calls = []

    class FakeRun:
        run_id = "run-err"

        def finish(self, status="finished"):
            calls.append(("finish", status))

    monkeypatch.setattr(train.im, "init", lambda **kwargs: FakeRun())
    monkeypatch.setattr(train, "train_model", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))

    with pytest.raises(RuntimeError, match="boom"):
        train.run_experiment(
            dataset,
            train.ExperimentConfig("bad", 0.1, 0.0, epochs=2),
            seed=1,
            server="http://local",
            artifact_dir=tmp_path,
            log_every=1,
            upload_artifacts=False,
        )

    assert calls == [("finish", "failed")]


def test_parse_select_summary_and_main(monkeypatch, tmp_path, capsys):
    assert train.parse_seeds("1, 2") == [1, 2]
    with pytest.raises(argparse.ArgumentTypeError):
        train.parse_seeds(",")

    assert [config.name for config in train.select_configs("")] == [config.name for config in train.CONFIGS]
    assert [config.name for config in train.select_configs("baseline")] == ["baseline"]
    with pytest.raises(argparse.ArgumentTypeError):
        train.select_configs("unknown")

    summary_path = tmp_path / "summary.json"
    train.write_summary(summary_path, [{"name": "run"}])
    train.write_summary(None, [{"name": "ignored"}])
    assert json.loads(summary_path.read_text(encoding="utf-8")) == {"runs": [{"name": "run"}]}

    data_path = write_sample(tmp_path / "main-iris.data")
    calls = []

    def fake_run_experiment(**kwargs):
        calls.append(kwargs)
        return {"name": kwargs["config"].name, "run_id": "run-main", "test_accuracy": 1.0, "test_macro_f1": 1.0, "test_ece": 0.01}

    monkeypatch.setattr(train, "run_experiment", fake_run_experiment)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "train.py",
            "--server",
            "http://local",
            "--data-path",
            str(data_path),
            "--seeds",
            "3",
            "--configs",
            "baseline",
            "--epochs",
            "4",
            "--log-every",
            "2",
            "--no-download",
            "--no-upload-artifacts",
            "--summary-json",
            str(tmp_path / "main-summary.json"),
        ],
    )

    train.main()

    assert len(calls) == 1
    assert calls[0]["server"] == "http://local"
    assert calls[0]["config"].epochs == 4
    assert calls[0]["upload_artifacts"] is False
    assert "test/accuracy=1.000" in capsys.readouterr().out
