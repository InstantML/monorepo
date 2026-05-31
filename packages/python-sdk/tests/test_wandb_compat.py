from __future__ import annotations

import pytest

import instantml.compat.wandb as wandb


@pytest.fixture(autouse=True)
def _clear_wandb_mode_env(monkeypatch):
    monkeypatch.delenv("WANDB_MODE", raising=False)
    monkeypatch.delenv("WANDB_DISABLED", raising=False)


def test_wandb_compat_init_log_artifact_and_finish(monkeypatch, tmp_path):
    class FakeRun:
        def __init__(self):
            self.logged = []
            self.artifacts = []
            self.finished = []
            self.watched = []
            self.configs = []

        def log(self, data, step=None):
            self.logged.append((data, step))

        def finish(self, status="finished"):
            self.finished.append(status)

        def watch(self, model, **kwargs):
            self.watched.append((model, kwargs))
            return "watch-handle"

        def log_artifact(self, name, uri, artifact_type="file", step=None, metadata=None):
            self.artifacts.append((name, uri, artifact_type, step, metadata))

        def log_config(self, data):
            self.configs.append(data)

    fake_run = FakeRun()
    init_calls = []

    def fake_init(**kwargs):
        init_calls.append(kwargs)
        return fake_run

    monkeypatch.setattr(wandb, "instantml_init", fake_init)
    monkeypatch.setattr(wandb, "run", None)
    monkeypatch.setattr(wandb, "config", {})

    wrapped = wandb.init(
        project="demo",
        name="candidate",
        config={"lr": 0.1},
        tags=["baseline"],
        notes="hello",
        id="wandb-run",
        group="group-a",
        job_type="train",
        extra_option=True,
    )
    assert wrapped is wandb.run
    assert wandb.config == {"lr": 0.1}
    assert init_calls[0]["metadata"]["wandb_compat"] == {
        "id": "wandb-run",
        "group": "group-a",
        "job_type": "train",
        "extra": {"extra_option": True},
    }
    wandb.config.update({"epochs": 3})
    assert fake_run.configs == [{"lr": 0.1, "epochs": 3}]

    wandb.log({"loss": 1.0, "ignored": "text"}, step=2)
    assert fake_run.logged == [({"loss": 1.0, "ignored": "text"}, 2)]
    assert wrapped.watch("model", log="all") == "watch-handle"
    assert wandb.watch("module-model", log="gradients") == "watch-handle"
    assert fake_run.watched[-1] == ("module-model", {"log": "gradients"})

    artifact_file = tmp_path / "model.pt"
    artifact_file.write_text("weights", encoding="utf-8")
    artifact = wandb.Artifact("model", type="model")
    artifact.add_file(str(artifact_file), name="weights.pt")
    artifact.add_reference("s3://bucket/model.pt", name="external-model")
    wrapped.log_artifact(artifact)

    logged_file, _ = fake_run.logged[-1]
    assert logged_file["artifact"].name == "weights.pt"
    assert fake_run.artifacts == [("external-model", "s3://bucket/model.pt", "model", None, None)]

    wandb.finish(exit_code=1)
    assert fake_run.finished == ["failed"]


def test_wandb_compat_artifact_add_dir_context_and_define_metric(monkeypatch, tmp_path):
    class FakeRun:
        def __init__(self):
            self.logged = []
            self.finished = []
            self.metrics = []

        def log(self, data, step=None):
            self.logged.append((data, step))

        def finish(self, status="finished"):
            self.finished.append(status)

        def define_metric(self, *args, **kwargs):
            self.metrics.append((args, kwargs))

    fake_run = FakeRun()
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_run)
    monkeypatch.setattr(wandb, "run", None)
    monkeypatch.setattr(wandb, "config", {})

    artifact_dir = tmp_path / "bundle"
    nested = artifact_dir / "nested"
    nested.mkdir(parents=True)
    (nested / "weights.pt").write_text("weights", encoding="utf-8")

    artifact = wandb.Artifact("model", type="checkpoint")
    artifact.add_dir(str(artifact_dir), name="renamed")
    assert artifact._files == [(str(nested / "weights.pt"), "renamed/nested/weights.pt")]
    with pytest.raises(ValueError, match="directory"):
        artifact.add_dir(str(tmp_path / "missing"))

    with wandb.init(project="demo") as wrapped:
        assert wrapped is wandb.run
        assert wrapped.__enter__() is wrapped
        assert wandb.define_metric("loss", summary="min") is None
        wrapped.log_artifact(artifact)

    assert fake_run.finished == ["finished"]
    logged_file, _ = fake_run.logged[0]
    assert logged_file["artifact"].name == "renamed/nested/weights.pt"


def test_wandb_compat_context_marks_failed_on_exception(monkeypatch):
    class FakeRun:
        def __init__(self):
            self.finished = []

        def finish(self, status="finished"):
            self.finished.append(status)

    fake_run = FakeRun()
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_run)
    monkeypatch.setattr(wandb, "run", None)
    with pytest.raises(RuntimeError, match="training failed"):
        with wandb.init(project="demo"):
            raise RuntimeError("training failed")
    assert fake_run.finished == ["failed"]


def test_wandb_compat_module_finish_and_define_metric_are_noops_without_run(monkeypatch):
    monkeypatch.setattr(wandb, "run", None)
    assert wandb.define_metric("loss") is None
    wandb.finish()


def test_wandb_compat_rejects_unsupported_modes_and_sweeps(monkeypatch):
    monkeypatch.setattr(wandb, "run", None)
    with pytest.raises(wandb.UnsupportedWandbFeature, match="disabled"):
        wandb.init(mode="disabled")
    with pytest.raises(wandb.UnsupportedWandbFeature, match="sweeps"):
        wandb.sweep({})
    with pytest.raises(RuntimeError, match="before wandb.init"):
        wandb.log({"loss": 1.0})


def test_wandb_compat_offline_mode_fails_explicitly(monkeypatch):
    def fail_init(**kwargs):
        raise AssertionError("offline mode must not initialize InstantML")

    monkeypatch.setattr(wandb, "instantml_init", fail_init)
    monkeypatch.setattr(wandb, "run", None)
    monkeypatch.setattr(wandb, "config", wandb.Config())

    with pytest.raises(wandb.UnsupportedWandbFeature, match="offline/dryrun"):
        wandb.init(project="demo", config={"lr": 0.1}, mode="offline")


def test_wandb_compat_env_offline_mode_fails_explicitly(monkeypatch):
    def fail_init(**kwargs):
        raise AssertionError("WANDB_MODE=offline must not initialize InstantML")

    monkeypatch.setenv("WANDB_MODE", "offline")
    monkeypatch.setattr(wandb, "instantml_init", fail_init)
    monkeypatch.setattr(wandb, "run", None)
    monkeypatch.setattr(wandb, "config", wandb.Config())

    with pytest.raises(wandb.UnsupportedWandbFeature, match="offline/dryrun"):
        wandb.init(project="demo")


def test_wandb_compat_env_disabled_mode_fails_explicitly(monkeypatch):
    def fail_init(**kwargs):
        raise AssertionError("WANDB_DISABLED=true must not initialize InstantML")

    monkeypatch.setenv("WANDB_DISABLED", "true")
    monkeypatch.setattr(wandb, "instantml_init", fail_init)
    monkeypatch.setattr(wandb, "run", None)
    monkeypatch.setattr(wandb, "config", wandb.Config())

    with pytest.raises(wandb.UnsupportedWandbFeature, match="disabled"):
        wandb.init(project="demo")


def test_wandb_compat_rejects_unsupported_log_kwargs(monkeypatch):
    class FakeRun:
        def log(self, data, step=None):
            raise AssertionError("unsupported commit kwarg must fail before logging")

    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: FakeRun())
    monkeypatch.setattr(wandb, "run", None)
    monkeypatch.setattr(wandb, "config", wandb.Config())
    wandb.init(project="demo")

    with pytest.raises(wandb.UnsupportedWandbFeature, match="commit"):
        wandb.log({"loss": 1.0}, commit=False)


def test_wandb_compat_module_watch_requires_init(monkeypatch):
    monkeypatch.setattr(wandb, "run", None)
    with pytest.raises(RuntimeError, match="before wandb.init"):
        wandb.watch("model")
