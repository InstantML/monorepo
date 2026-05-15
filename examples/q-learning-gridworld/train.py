"""Tabular Q-learning gridworld dogfood example."""

from __future__ import annotations

import argparse
import random
from dataclasses import dataclass

import instantml as ro


ACTIONS = {
    0: (0, 1),
    1: (1, 0),
    2: (0, -1),
    3: (-1, 0),
}


@dataclass(frozen=True)
class Gridworld:
    size: int = 5
    goal: tuple[int, int] = (4, 4)
    trap: tuple[int, int] = (2, 2)
    max_steps: int = 40


def move(state: tuple[int, int], action: int, env: Gridworld) -> tuple[tuple[int, int], float, bool]:
    dx, dy = ACTIONS[action]
    next_state = (min(env.size - 1, max(0, state[0] + dx)), min(env.size - 1, max(0, state[1] + dy)))
    if next_state == env.goal:
        return next_state, 10.0, True
    if next_state == env.trap:
        return next_state, -10.0, True
    return next_state, -0.1, False


def choose_action(q: dict[tuple[tuple[int, int], int], float], state: tuple[int, int], epsilon: float, rng: random.Random) -> int:
    if rng.random() < epsilon:
        return rng.choice(list(ACTIONS))
    values = [(q.get((state, action), 0.0), action) for action in ACTIONS]
    return max(values)[1]


def evaluate_policy(q: dict[tuple[tuple[int, int], int], float], env: Gridworld, episodes: int = 20) -> tuple[float, float]:
    returns = []
    successes = 0
    for index in range(episodes):
        rng = random.Random(10_000 + index)
        episode_return, success, _path, _td_error = run_episode(q, env, epsilon=0.0, alpha=0.0, gamma=0.95, rng=rng)
        returns.append(episode_return)
        successes += int(success)
    return sum(returns) / len(returns), successes / episodes


def run_episode(
    q: dict[tuple[tuple[int, int], int], float],
    env: Gridworld,
    epsilon: float,
    alpha: float,
    gamma: float,
    rng: random.Random,
) -> tuple[float, bool, list[tuple[int, int]], float]:
    state = (0, 0)
    total = 0.0
    td_errors = []
    path = [state]
    for _ in range(env.max_steps):
        action = choose_action(q, state, epsilon, rng)
        next_state, reward, done = move(state, action, env)
        old_value = q.get((state, action), 0.0)
        next_best = max(q.get((next_state, next_action), 0.0) for next_action in ACTIONS)
        target = reward + gamma * next_best * (0 if done else 1)
        td_error = target - old_value
        if alpha > 0:
            q[(state, action)] = old_value + alpha * td_error
        td_errors.append(abs(td_error))
        total += reward
        state = next_state
        path.append(state)
        if done:
            return total, next_state == env.goal, path, sum(td_errors) / len(td_errors)
    return total, False, path, sum(td_errors) / len(td_errors)


def train_seed(server: str, seed: int, episodes: int) -> None:
    env = Gridworld()
    rng = random.Random(seed)
    q: dict[tuple[tuple[int, int], int], float] = {}
    alpha = 0.25
    gamma = 0.95
    run = ro.init(
        project="q-learning-gridworld",
        name=f"q-learning-seed-{seed}",
        config={"seed": seed, "alpha": alpha, "gamma": gamma, "env_size": env.size, "max_steps": env.max_steps},
        tags=["q-learning", "gridworld", "dogfood"],
        notes="Gridworld Q-learning baseline used to inspect reward stability and path efficiency.",
        metadata={"example": "q-learning-gridworld"},
        base_url=server,
    )
    rolling_successes = []
    last_path: list[tuple[int, int]] = []
    try:
        for episode in range(episodes):
            epsilon = max(0.05, 0.9 * (0.97**episode))
            episode_return, success, path, td_error_mean = run_episode(q, env, epsilon, alpha, gamma, rng)
            last_path = path
            rolling_successes.append(int(success))
            rolling_successes = rolling_successes[-25:]
            eval_return, eval_success = evaluate_policy(q, env)
            run.log(
                {
                    "train/episode_return": episode_return,
                    "train/success_rate": sum(rolling_successes) / len(rolling_successes),
                    "train/epsilon": epsilon,
                    "train/td_error": td_error_mean,
                    "eval/return_mean": eval_return,
                    "eval/success_rate": eval_success,
                },
                step=episode,
            )
            if episode in {episodes // 2, episodes - 1}:
                run.log_checkpoint(
                    name=f"q-table-seed-{seed}-episode-{episode}.json",
                    uri=f"demo://q-learning-gridworld/q-table-seed-{seed}-episode-{episode}.json",
                    step=episode,
                    metadata={"states": len({state for state, _action in q}), "actions": len(q)},
                )
        run.log_rollout(
            name=f"greedy-rollout-seed-{seed}",
            uri=f"demo://q-learning-gridworld/rollout-seed-{seed}.json",
            step=episodes - 1,
            metadata={"path": last_path, "path_length": len(last_path), "goal": env.goal},
        )
        run.log_artifact(
            name=f"config-seed-{seed}.json",
            uri=f"demo://q-learning-gridworld/config-seed-{seed}.json",
            metadata={"seed": seed, "episodes": episodes},
        )
        run.finish()
    except Exception:
        run.finish("failed")
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Q-learning gridworld dogfood example")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    parser.add_argument("--episodes", type=int, default=80)
    parser.add_argument("--seeds", default="3,7,13")
    args = parser.parse_args()
    for seed in [int(value.strip()) for value in args.seeds.split(",") if value.strip()]:
        train_seed(args.server, seed, args.episodes)


if __name__ == "__main__":  # pragma: no cover
    main()
