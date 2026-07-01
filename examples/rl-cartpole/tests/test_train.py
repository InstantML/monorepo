import train
from train import generate_metrics


def test_generate_metrics_is_deterministic_and_rl_shaped():
    first = generate_metrics(step=3, seed=42)
    second = generate_metrics(step=3, seed=42)

    assert first == second
    assert set(first) == {"train/reward", "train/loss", "eval/return_mean"}
    assert first["train/reward"] > 0
    assert first["train/loss"] > 0


def test_main_logs_expected_steps(monkeypatch):
    calls = []

    class FakeRun:
        def log(self, metrics, step):
            calls.append(("log", step, metrics))

        def finish(self):
            calls.append(("finish",))

    def fake_init(**kwargs):
        calls.append(("init", kwargs))
        return FakeRun()

    monkeypatch.setattr(
        "sys.argv",
        [
            "train.py",
            "--server",
            "http://local",
            "--seed",
            "7",
            "--steps",
            "2",
            "--upload-mode",
            "spool",
            "--spool-dir",
            ".tmp/spool",
        ],
    )
    monkeypatch.setattr(train.im, "init", fake_init)

    train.main()

    assert calls[0][0] == "init"
    assert calls[0][1]["base_url"] == "http://local"
    assert calls[0][1]["upload_mode"] == "spool"
    assert calls[0][1]["spool_dir"] == ".tmp/spool"
    assert [call[1] for call in calls[1:3]] == [0, 1]
    assert calls[-1] == ("finish",)
