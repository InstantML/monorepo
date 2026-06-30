import importlib.util
import random
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "train.py"
SPEC = importlib.util.spec_from_file_location("q_learning_gridworld_train", MODULE_PATH)
train = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = train
SPEC.loader.exec_module(train)


def test_move_respects_boundaries_goal_and_trap():
    env = train.Gridworld()
    assert train.move((0, 0), 2, env)[0] == (0, 0)
    assert train.move((4, 3), 0, env) == ((4, 4), 10.0, True)
    assert train.move((2, 1), 0, env) == ((2, 2), -10.0, True)


def test_choose_action_exploits_best_value():
    q = {((0, 0), 0): 1.0, ((0, 0), 1): 2.0}
    assert train.choose_action(q, (0, 0), epsilon=0.0, rng=random.Random(1)) == 1


def test_run_episode_and_evaluate_policy_are_deterministic():
    env = train.Gridworld(max_steps=10)
    q = {}
    episode_return, success, path, td_error_mean = train.run_episode(q, env, epsilon=1.0, alpha=0.2, gamma=0.95, rng=random.Random(4))
    assert isinstance(episode_return, float)
    assert isinstance(success, bool)
    assert path[0] == (0, 0)
    assert td_error_mean >= 0
    eval_return, eval_success = train.evaluate_policy(q, env, episodes=3)
    assert isinstance(eval_return, float)
    assert 0 <= eval_success <= 1


def test_run_episode_can_finish_at_goal():
    env = train.Gridworld(max_steps=5)
    q = {((0, 0), 0): 1, ((0, 1), 0): 1, ((0, 2), 0): 1, ((0, 3), 0): 1}
    total, success, path, td_error_mean = train.run_episode(q, env, epsilon=0.0, alpha=0.0, gamma=0.95, rng=random.Random(1))
    assert isinstance(total, float)
    assert isinstance(success, bool)
    assert path[0] == (0, 0)
    assert td_error_mean >= 0


def test_train_seed_logs_metrics_and_artifacts(monkeypatch):
    calls = []

    class FakeRun:
        def log(self, metrics, step):
            calls.append(("log", step, metrics))

        def log_checkpoint(self, **kwargs):
            calls.append(("checkpoint", kwargs))

        def log_rollout(self, **kwargs):
            calls.append(("rollout", kwargs))

        def log_artifact(self, **kwargs):
            calls.append(("artifact", kwargs))

        def finish(self, status="finished"):
            calls.append(("finish", status))

    def fake_init(**kwargs):
        calls.append(("init", kwargs))
        return FakeRun()

    monkeypatch.setattr(train.im, "init", fake_init)
    train.train_seed("http://server", seed=5, episodes=4)

    assert calls[0][0] == "init"
    assert calls[0][1]["project"] == "q-learning-gridworld"
    assert "reward stability" in calls[0][1]["notes"]
    assert len([call for call in calls if call[0] == "log"]) == 4
    assert len([call for call in calls if call[0] == "checkpoint"]) == 2
    assert calls[-1] == ("finish", "finished")


def test_train_seed_marks_run_failed_on_exception(monkeypatch):
    calls = []

    class BrokenRun:
        def log(self, metrics, step):
            raise RuntimeError("boom")

        def finish(self, status="finished"):
            calls.append(("finish", status))

    monkeypatch.setattr(train.im, "init", lambda **kwargs: BrokenRun())

    try:
        train.train_seed("http://server", seed=5, episodes=1)
    except RuntimeError:
        pass

    assert calls == [("finish", "failed")]


def test_main_parses_seeds(monkeypatch):
    calls = []
    monkeypatch.setattr("sys.argv", ["train.py", "--server", "http://server", "--episodes", "2", "--seeds", "1, 2"])
    monkeypatch.setattr(train, "train_seed", lambda server, seed, episodes: calls.append((server, seed, episodes)))

    train.main()

    assert calls == [("http://server", 1, 2), ("http://server", 2, 2)]
