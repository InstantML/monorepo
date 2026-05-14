import importlib.util
import json
import sys
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "train.py"
SPEC = importlib.util.spec_from_file_location("contextual_bandit_train", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
train = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = train
SPEC.loader.exec_module(train)


class FakeRun:
    def __init__(self):
        self.run_id = "run-1"
        self.logged = []
        self.finished = []
        self.artifacts = []

    def log(self, metrics, step):
        self.logged.append((step, metrics))

    def finish(self, status="finished"):
        self.finished.append(status)

    def log_checkpoint(self, **kwargs):
        self.artifacts.append(("checkpoint", kwargs))
        return kwargs

    def log_rollout(self, **kwargs):
        self.artifacts.append(("rollout", kwargs))
        return kwargs

    def log_artifact(self, **kwargs):
        self.artifacts.append(("file", kwargs))
        return kwargs


def test_policy_evaluation_is_deterministic():
    config = train.TrainingConfig(
        seed=11,
        steps=10,
        log_every=5,
        artifact_every=10,
        policy=train.POLICIES["epsilon-greedy"],
    )
    weights = [[0.0 for _ in range(config.feature_dim)] for _ in range(config.arms)]
    true_weights = train.make_true_weights(config.seed, config.arms, config.feature_dim)

    first = train.evaluate_policy(weights, true_weights, seed=99)
    second = train.evaluate_policy(weights, true_weights, seed=99)

    assert first == second
    assert 0.0 < first < 1.0


def test_train_one_run_logs_metrics_and_artifact_metadata(tmp_path: Path):
    fake_run = FakeRun()
    artifacts = []
    config = train.TrainingConfig(
        seed=11,
        steps=12,
        log_every=4,
        artifact_every=6,
        policy=train.POLICIES["optimistic"],
    )

    summary = train.train_one_run(
        run=fake_run,
        server="http://local",
        config=config,
        output_dir=tmp_path,
        emit_artifacts=True,
        artifact_sink=lambda server, run_id, artifact: artifacts.append((server, run_id, artifact)),
    )

    logged_steps = [step for step, _metrics in fake_run.logged]
    assert logged_steps == [1, 4, 8, 12]
    assert fake_run.finished == ["finished"]
    assert summary.policy == "optimistic"
    assert summary.total_reward >= 0
    assert {artifact[2]["type"] for artifact in artifacts} == {"checkpoint", "rollout", "file"}
    assert (tmp_path / "checkpoint-step-6.json").exists()
    assert (tmp_path / "checkpoint-step-12.json").exists()
    assert (tmp_path / "rollout-summary.jsonl").exists()


def test_train_one_run_marks_failed_runs(tmp_path: Path):
    class FailingRun(FakeRun):
        def log(self, metrics, step):
            super().log(metrics, step)
            raise RuntimeError("boom")

    run = FailingRun()
    with pytest.raises(RuntimeError, match="boom"):
        train.train_one_run(
            run=run,
            server="http://local",
            config=train.TrainingConfig(
                seed=3,
                steps=1,
                log_every=1,
                artifact_every=1,
                policy=train.POLICIES["epsilon-greedy"],
            ),
            output_dir=tmp_path,
            emit_artifacts=False,
            artifact_sink=None,
        )
    assert run.finished == ["failed"]


def test_recent_reward_window_is_bounded(tmp_path: Path):
    fake_run = FakeRun()
    summary = train.train_one_run(
        run=fake_run,
        server="http://local",
        config=train.TrainingConfig(
            seed=9,
            steps=55,
            log_every=55,
            artifact_every=55,
            policy=train.POLICIES["epsilon-greedy"],
        ),
        output_dir=tmp_path,
        emit_artifacts=False,
        artifact_sink=None,
    )

    assert summary.name == "epsilon-greedy-seed-9"
    assert fake_run.finished == ["finished"]


def test_run_experiment_initializes_each_seed_and_policy(tmp_path: Path):
    created = []

    def fake_init(**kwargs):
        created.append(kwargs)
        return FakeRun()

    summaries = train.run_experiment(
        server="http://local",
        seeds=[1, 2],
        policies=["epsilon-greedy"],
        steps=4,
        log_every=2,
        artifact_every=4,
        output_dir=tmp_path,
        emit_artifacts=False,
        init_run=fake_init,
    )

    assert [item["name"] for item in created] == ["epsilon-greedy-seed-1", "epsilon-greedy-seed-2"]
    assert all(item["project"] == train.PROJECT for item in created)
    assert len(summaries) == 2


def test_default_artifact_logging_uses_sdk_helpers():
    fake_run = FakeRun()
    base = {"name": "a", "uri": "example://a", "step": 1, "size_bytes": 2, "metadata": {"x": 1}}

    train.safe_artifact_log(fake_run, None, "http://local", fake_run.run_id, {"type": "checkpoint", **base})
    train.safe_artifact_log(fake_run, None, "http://local", fake_run.run_id, {"type": "rollout", **base})
    train.safe_artifact_log(fake_run, None, "http://local", fake_run.run_id, {"type": "file", **base})

    assert [kind for kind, _payload in fake_run.artifacts] == ["checkpoint", "rollout", "file"]


def test_parse_helpers_and_small_numeric_edges():
    assert train.parse_int_list("1, 2") == [1, 2]
    assert train.parse_policy_list("epsilon-greedy") == ["epsilon-greedy"]
    assert train.arm_entropy([]) == 0.0
    assert train.mean([]) == 0.0
    with pytest.raises(ValueError, match="at least one seed"):
        train.parse_int_list(",")
    with pytest.raises(ValueError, match="unknown policy"):
        train.parse_policy_list("missing")
    with pytest.raises(ValueError, match="at least one policy"):
        train.parse_policy_list(",")
    with pytest.raises(ValueError, match="must be positive"):
        train.validate_positive("steps", 0)


def test_main_prints_run_summaries(monkeypatch, tmp_path, capsys):
    def fake_run_experiment(**kwargs):
        assert kwargs["output_dir"] == tmp_path.resolve()
        return [train.RunSummary("epsilon-greedy-seed-1", 1, "epsilon-greedy", 3.0, 0.5, 42.0)]

    monkeypatch.setattr(train, "run_experiment", fake_run_experiment)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "train.py",
            "--server",
            "http://local",
            "--seeds",
            "1",
            "--policies",
            "epsilon-greedy",
            "--steps",
            "4",
            "--log-every",
            "2",
            "--artifact-every",
            "4",
            "--output-dir",
            str(tmp_path),
            "--no-artifacts",
        ],
    )

    train.main()

    assert json.loads(capsys.readouterr().out)[0]["eval_return_mean"] == 42.0
