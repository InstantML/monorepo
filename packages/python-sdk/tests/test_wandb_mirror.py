from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

import instantml.wandb_mirror as wandb


@pytest.fixture(autouse=True)
def _reset_wandb_mirror(monkeypatch):
    monkeypatch.setattr(wandb, "_real_wandb", None)
    monkeypatch.setattr(wandb, "_warned", set())
    monkeypatch.setattr(wandb, "run", None)
    wandb.config.attach(None, None)
    sys.modules.pop("wandb", None)


class FakeWandbRun:
    def __init__(self):
        self.logged = []
        self.finished = []
        self.artifacts = []
        self.watched = []

    def log(self, data, step=None, **kwargs):
        self.logged.append((data, step, kwargs))
        return "wandb-log"

    def finish(self, exit_code=None, **kwargs):
        self.finished.append((exit_code, kwargs))
        return "wandb-finish"

    def log_artifact(self, *args, **kwargs):
        self.artifacts.append((args, kwargs))
        return "wandb-artifact"

    def watch(self, *args, **kwargs):
        self.watched.append((args, kwargs))
        return "wandb-watch"


class FakeInstantRun:
    def __init__(self):
        self.logged = []
        self.finished = []
        self.configs = []

    def log(self, data, step=None):
        self.logged.append((data, step))

    def finish(self, status="finished"):
        self.finished.append(status)

    def log_config(self, data):
        self.configs.append(data)


def _install_fake_wandb(monkeypatch, fake_wandb):
    monkeypatch.setitem(sys.modules, "wandb", fake_wandb)


def test_wandb_mirror_keeps_wandb_primary_and_mirrors_scalars(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FakeInstantRun()
    wandb_init_calls = []
    instant_init_calls = []

    fake_wandb = SimpleNamespace(
        config={},
        init=lambda **kwargs: (wandb_init_calls.append(kwargs) or fake_wandb_run),
        define_metric=lambda *args, **kwargs: ("metric", args, kwargs),
    )
    _install_fake_wandb(monkeypatch, fake_wandb)

    def fake_instantml_init(**kwargs):
        instant_init_calls.append(kwargs)
        return fake_instant_run

    monkeypatch.setattr(wandb, "instantml_init", fake_instantml_init)

    wrapped = wandb.init(
        project="train",
        entity="team",
        name="run-a",
        config={"lr": 0.1},
        tags=["pilot"],
        notes="hello",
        id="wb-1",
        instantml_project="mirrored-train",
        instantml_api_key="instantml_test",
    )

    assert wrapped is wandb.run
    assert wandb_init_calls[0]["project"] == "train"
    assert wandb_init_calls[0]["entity"] == "team"
    assert instant_init_calls[0]["project"] == "mirrored-train"
    assert instant_init_calls[0]["api_key"] == "instantml_test"
    assert instant_init_calls[0]["metadata"]["wandb_shadow"] == {
        "project": "train",
        "entity": "team",
        "id": "wb-1",
        "group": None,
        "job_type": None,
    }

    assert (
        wandb.log({"loss": 1.0, "epoch": 2, "text": "ignored", "flag": True}, step=3)
        == "wandb-log"
    )
    assert fake_wandb_run.logged == [
        ({"loss": 1.0, "epoch": 2, "text": "ignored", "flag": True}, 3, {})
    ]
    assert fake_instant_run.logged == [({"loss": 1.0, "epoch": 2}, 3)]

    wandb.config.update({"epochs": 10})
    assert fake_wandb.config == {"epochs": 10}
    assert fake_instant_run.configs == [{"epochs": 10}]

    assert wrapped.watch("model") == "wandb-watch"
    assert fake_wandb_run.watched == [(("model",), {})]

    assert wandb.finish(exit_code=1) == "wandb-finish"
    assert fake_wandb_run.finished == [(1, {})]
    assert fake_instant_run.finished == ["failed"]
    assert wandb.run is None


def test_wandb_mirror_instantml_init_failure_does_not_break_wandb(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)

    def fail_instantml_init(**kwargs):
        raise RuntimeError("no InstantML credentials")

    monkeypatch.setattr(wandb, "instantml_init", fail_instantml_init)

    with pytest.warns(RuntimeWarning, match="mirror disabled"):
        wrapped = wandb.init(project="train")

    wrapped.log({"loss": 0.5}, step=1)
    assert fake_wandb_run.logged == [({"loss": 0.5}, 1, {})]
    assert wrapped.finish() == "wandb-finish"


def test_wandb_mirror_skips_instantml_mirror_for_extra_log_kwargs(monkeypatch):
    fake_wandb_run = FakeWandbRun()
    fake_instant_run = FakeInstantRun()
    fake_wandb = SimpleNamespace(config={}, init=lambda **kwargs: fake_wandb_run)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: fake_instant_run)

    wandb.init(project="train")
    with pytest.warns(RuntimeWarning, match="extra kwargs"):
        wandb.log({"loss": 0.5}, step=1, commit=False)

    assert fake_wandb_run.logged == [({"loss": 0.5}, 1, {"commit": False})]
    assert fake_instant_run.logged == []


def test_wandb_mirror_real_wandb_failure_still_raises(monkeypatch):
    def fail_wandb_init(**kwargs):
        raise RuntimeError("wandb login failed")

    fake_wandb = SimpleNamespace(config={}, init=fail_wandb_init)
    _install_fake_wandb(monkeypatch, fake_wandb)
    monkeypatch.setattr(wandb, "instantml_init", lambda **kwargs: FakeInstantRun())

    with pytest.raises(RuntimeError, match="wandb login failed"):
        wandb.init(project="train")


def test_wandb_mirror_unknown_attributes_delegate_to_real_wandb(monkeypatch):
    fake_wandb = SimpleNamespace(config={}, Artifact=lambda name: ("artifact", name))
    _install_fake_wandb(monkeypatch, fake_wandb)

    assert wandb.Artifact("model") == ("artifact", "model")
