import importlib.util
import json
import sys
from contextlib import contextmanager
from pathlib import Path

TRAIN_PATH = Path(__file__).resolve().parents[1] / "train.py"
SPEC = importlib.util.spec_from_file_location("agent_rl_tracing_train", TRAIN_PATH)
train = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = train
SPEC.loader.exec_module(train)


class FakeSpan:
    def __init__(self, run, name, **kwargs):
        self.run = run
        self.name = name
        self.kwargs = kwargs
        self.output = None
        self.metrics = []

    def span(self, name, **kwargs):
        return self.run._span(name, **kwargs)

    def set_output(self, output):
        self.output = output

    def log_metric(self, data):
        self.metrics.append(data)


class FakeRun:
    def __init__(self):
        self.run_id = "run-fake"
        self.spans = []
        self.metrics = []
        self.rank_metrics = []
        self.console = []
        self.checkpoints = []
        self.uploads = []

    @contextmanager
    def _span(self, name, **kwargs):
        span = FakeSpan(self, name, **kwargs)
        self.spans.append(span)
        yield span

    def trace(self, name, **kwargs):
        return self._span(name, **kwargs)

    def log(self, data, step=None):
        self.metrics.append((step, data))

    def log_rank_metrics(self, data, step, rank, world_size, **kwargs):
        self.rank_metrics.append((step, rank, world_size, data))

    def log_console(self, lines, stream="stdout"):
        self.console.append((stream, lines))

    def log_checkpoint_file(self, path, step, metadata=None):
        self.checkpoints.append((path, step, metadata or {}))
        return {"id": f"ckpt-{step}"}

    def upload_file(self, path, name=None, step=None):
        self.uploads.append((path, name, step))
        return {"id": "artifact-eval-report"}


def test_run_training_covers_every_surface(tmp_path):
    config = train.TrainConfig(steps=24, outage_start=10, outage_end=14, checkpoint_every=8)
    run = FakeRun()

    summary = train.run_training(run, config, tmp_path)

    # Metrics: one step-metric record per step, three keys each.
    assert len(run.metrics) == config.steps
    assert all(set(data) == {"reward/mean", "kl", "loss"} for _, data in run.metrics)

    # Distributed: world_size rank records per step.
    assert len(run.rank_metrics) == config.steps * config.world_size
    assert {rank for _, rank, _, _ in run.rank_metrics} == set(range(config.world_size))

    # Traces: rollout roots with nested model/tool spans plus one stepless eval.
    rollout_roots = [s for s in run.spans if s.kwargs.get("kind") == "rollout"]
    assert rollout_roots and all(s.kwargs["step"] is not None for s in rollout_roots)
    eval_roots = [s for s in run.spans if s.kwargs.get("kind") == "eval"]
    assert len(eval_roots) == 1 and "step" not in eval_roots[0].kwargs
    assert any(s.kwargs.get("kind") == "model" for s in run.spans)
    assert any(s.kwargs.get("kind") == "reward" for s in run.spans)

    # The outage window produced failed rollouts and stderr console lines.
    assert summary["failed_rollouts"] > 0
    assert any(stream == "stderr" for stream, _ in run.console)
    assert len(run.console) >= config.steps

    # Checkpoints at the cadence, plus the uploaded eval report artifact.
    assert [step for _, step, _ in run.checkpoints] == [8, 16, 24]
    assert summary["checkpoints"] == [{"step": s, "artifact_id": f"ckpt-{s}"} for s in (8, 16, 24)]
    assert summary["eval_report_artifact_id"] == "artifact-eval-report"
    report = json.loads((tmp_path / "eval-report.json").read_text(encoding="utf-8"))
    assert report["steps"] == config.steps


def test_tool_outage_rollouts_score_floor_reward(tmp_path):
    config = train.TrainConfig()
    run = FakeRun()
    rng = train.random.Random(0)

    reward = train.run_rollout(run, config, rng, step=5, group=0, fail_tool=False)
    assert 0 < reward < 1

    try:
        train.run_rollout(run, config, rng, step=20, group=0, fail_tool=True)
    except train.ToolOutageError:
        pass
    else:
        raise AssertionError("expected ToolOutageError")


def test_outage_window_depresses_reward():
    config = train.TrainConfig()
    rng = train.random.Random(1)
    healthy = train.rubric_score(25, config, rng, degraded=False)
    degraded = train.rubric_score(25, config, rng, degraded=True)
    assert degraded < healthy
