import importlib.util
import json
import sys
from pathlib import Path

TRAIN_PATH = Path(__file__).resolve().parents[1] / "train.py"
SPEC = importlib.util.spec_from_file_location("checkpoint_example_train", TRAIN_PATH)
train = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = train
SPEC.loader.exec_module(train)


class FakeRun:
    def __init__(self):
        self.metrics = []
        self.checkpoints = []

    def log(self, data, step):
        self.metrics.append((step, data))

    def log_checkpoint_file(self, path, step, metadata=None):
        artifact = {
            "id": f"artifact-{step}",
            "path": path,
            "step": step,
            "metadata": metadata or {},
        }
        self.checkpoints.append(artifact)
        return artifact


def test_save_and_load_checkpoint_round_trip(tmp_path):
    config = train.TrainConfig(steps=4, checkpoint_every=2)
    state = train.initial_state(config)
    train.train_step(state, config)

    path = train.save_checkpoint(tmp_path / "checkpoint.json", state, config)
    loaded = train.load_checkpoint(path)

    assert loaded == state
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["format"] == "instantml-checkpoint-example-v1"
    assert payload["config"]["checkpoint_every"] == 2


def test_run_training_logs_checkpoint_artifacts_at_interval(tmp_path):
    config = train.TrainConfig(steps=7, checkpoint_every=3)
    fake = FakeRun()

    summary = train.run_training(fake, config, tmp_path)

    assert [step for step, _metrics in fake.metrics] == list(range(1, 8))
    assert [item["step"] for item in fake.checkpoints] == [3, 6]
    assert [item["step"] for item in summary["checkpoints"]] == [3, 6]
    assert summary["latest_checkpoint"]["artifact_id"] == "artifact-6"
    assert (tmp_path / "checkpoint-step-3.json").exists()
    assert fake.checkpoints[0]["metadata"]["checkpoint"]["step"] == 3
    assert fake.checkpoints[0]["metadata"]["framework"] == "json"


def test_run_training_resumes_from_checkpoint_state(tmp_path):
    config = train.TrainConfig(steps=4, checkpoint_every=2)
    source = FakeRun()
    first = train.run_training(source, config, tmp_path / "source")
    checkpoint_state = train.load_checkpoint(Path(first["latest_checkpoint"]["path"]))

    resumed = FakeRun()
    resume_config = train.TrainConfig(steps=3, checkpoint_every=3)
    summary = train.run_training(resumed, resume_config, tmp_path / "resume", resume_state=checkpoint_state)

    assert summary["start_step"] == 4
    assert summary["end_step"] == 7
    assert [step for step, _metrics in resumed.metrics] == [5, 6, 7]
    assert [item["step"] for item in resumed.checkpoints] == [6]
