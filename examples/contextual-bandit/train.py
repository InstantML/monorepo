"""Contextual bandit example that logs multiple seeded runs to Training Observability."""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

import rl_observability as ro


ARM_NAMES = ["email_coupon", "free_shipping", "bundle_discount", "loyalty_points"]
FEATURE_NAMES = ["bias", "budget_signal", "novelty_signal", "loyalty_signal", "hour_sin", "hour_cos"]
PROJECT = "contextual-bandit"


@dataclass(frozen=True)
class PolicyConfig:
    name: str
    learning_rate: float
    initial_epsilon: float
    min_epsilon: float
    exploration_decay: float
    optimism: float


@dataclass(frozen=True)
class TrainingConfig:
    seed: int
    steps: int
    log_every: int
    artifact_every: int
    policy: PolicyConfig
    arms: int = 4
    feature_dim: int = 6


@dataclass(frozen=True)
class RunSummary:
    name: str
    seed: int
    policy: str
    total_reward: float
    cumulative_regret: float
    eval_return_mean: float


class ObservableRun(Protocol):
    run_id: str

    def log(self, metrics: dict[str, float], step: int) -> None:
        ...

    def finish(self, status: str = "finished") -> None:
        ...

    def log_artifact(
        self,
        name: str,
        uri: str,
        artifact_type: str = "file",
        step: int | None = None,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ...

    def log_checkpoint(
        self,
        name: str,
        uri: str,
        step: int,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ...

    def log_rollout(
        self,
        name: str,
        uri: str,
        step: int,
        size_bytes: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ...


ArtifactSink = Callable[[str, str, dict[str, Any]], None]


POLICIES = {
    "epsilon-greedy": PolicyConfig(
        name="epsilon-greedy",
        learning_rate=0.045,
        initial_epsilon=0.35,
        min_epsilon=0.04,
        exploration_decay=0.985,
        optimism=0.0,
    ),
    "optimistic": PolicyConfig(
        name="optimistic",
        learning_rate=0.035,
        initial_epsilon=0.18,
        min_epsilon=0.02,
        exploration_decay=0.992,
        optimism=0.35,
    ),
}


def main() -> None:
    args = parse_args()
    seeds = parse_int_list(args.seeds)
    policies = parse_policy_list(args.policies)
    output_dir = Path(args.output_dir).expanduser().resolve()
    summaries = run_experiment(
        server=args.server,
        seeds=seeds,
        policies=policies,
        steps=args.steps,
        log_every=args.log_every,
        artifact_every=args.artifact_every,
        output_dir=output_dir,
        emit_artifacts=not args.no_artifacts,
    )
    print(json.dumps([summary.__dict__ for summary in summaries], indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Log contextual bandit training runs")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="Training Observability API URL")
    parser.add_argument("--seeds", default="11,23,37", help="Comma-separated deterministic seeds")
    parser.add_argument("--policies", default="epsilon-greedy,optimistic", help="Comma-separated policy names")
    parser.add_argument("--steps", default=240, type=int, help="Training decisions per run")
    parser.add_argument("--log-every", default=10, type=int, help="Metric logging interval")
    parser.add_argument("--artifact-every", default=120, type=int, help="Checkpoint metadata interval")
    parser.add_argument("--output-dir", default=".rlobs/contextual-bandit-artifacts", help="Local artifact output directory")
    parser.add_argument("--no-artifacts", action="store_true", help="Skip artifact metadata logging")
    return parser.parse_args()


def run_experiment(
    *,
    server: str,
    seeds: list[int],
    policies: list[str],
    steps: int,
    log_every: int,
    artifact_every: int,
    output_dir: Path,
    emit_artifacts: bool,
    init_run: Callable[..., ObservableRun] = ro.init,
    artifact_sink: ArtifactSink | None = None,
) -> list[RunSummary]:
    validate_positive("steps", steps)
    validate_positive("log_every", log_every)
    validate_positive("artifact_every", artifact_every)
    summaries = []
    for policy_name in policies:
        policy = POLICIES[policy_name]
        for seed in seeds:
            config = TrainingConfig(seed=seed, steps=steps, log_every=log_every, artifact_every=artifact_every, policy=policy)
            run_name = f"{policy_name}-seed-{seed}"
            run = init_run(
                project=PROJECT,
                name=run_name,
                config={
                    "environment": "synthetic-newsletter-bandit",
                    "policy": policy.name,
                    "seed": seed,
                    "arms": ARM_NAMES,
                    "features": FEATURE_NAMES,
                    "learning_rate": policy.learning_rate,
                    "initial_epsilon": policy.initial_epsilon,
                    "min_epsilon": policy.min_epsilon,
                    "exploration_decay": policy.exploration_decay,
                    "optimism": policy.optimism,
                    "steps": steps,
                },
                tags=["example", "contextual-bandit", policy.name],
                notes=f"Contextual bandit {policy.name}: compare regret, reward, and exploration behavior.",
                metadata={"source": "examples/contextual-bandit/train.py", "artifact_note": "artifacts are metadata-only in this example"},
                base_url=server,
            )
            summaries.append(
                train_one_run(
                    run=run,
                    server=server,
                    config=config,
                    output_dir=output_dir / run_name,
                    emit_artifacts=emit_artifacts,
                    artifact_sink=artifact_sink,
                ),
            )
    return summaries


def train_one_run(
    *,
    run: ObservableRun,
    server: str,
    config: TrainingConfig,
    output_dir: Path,
    emit_artifacts: bool,
    artifact_sink: ArtifactSink | None,
) -> RunSummary:
    rng = random.Random(config.seed)
    true_weights = make_true_weights(config.seed, config.arms, config.feature_dim)
    model_weights = [[0.0 for _ in range(config.feature_dim)] for _ in range(config.arms)]
    arm_counts = [0 for _ in range(config.arms)]
    recent_rewards: list[float] = []
    total_reward = 0.0
    cumulative_regret = 0.0
    final_eval = 0.0
    rollout_rows: list[dict[str, Any]] = []
    status = "finished"

    try:
        for step in range(1, config.steps + 1):
            context = sample_context(rng, step)
            epsilon = current_epsilon(config.policy, step)
            expected = expected_rewards(context, true_weights)
            action = choose_action(context, model_weights, arm_counts, epsilon, config.policy.optimism, rng)
            reward_probability = expected[action]
            reward = 1.0 if rng.random() < reward_probability else 0.0
            best_expected = max(expected)
            cumulative_regret += best_expected - reward_probability
            total_reward += reward
            recent_rewards.append(reward)
            if len(recent_rewards) > 50:
                recent_rewards.pop(0)
            arm_counts[action] += 1
            update_model(model_weights[action], context, reward, config.policy.learning_rate)

            if step % config.log_every == 0 or step == 1 or step == config.steps:
                final_eval = evaluate_policy(model_weights, true_weights, seed=config.seed + step)
                run.log(
                    {
                        "train/reward": reward,
                        "train/click_rate_50": mean(recent_rewards),
                        "train/regret": best_expected - reward_probability,
                        "train/cumulative_regret": cumulative_regret,
                        "train/epsilon": epsilon,
                        "train/chosen_arm": float(action),
                        "eval/return_mean": final_eval * 100.0,
                        "eval/optimality_gap": max(0.0, evaluate_oracle(true_weights, config.seed + step) - final_eval) * 100.0,
                        "policy/arm_entropy": arm_entropy(arm_counts),
                        "policy/active_arms": float(sum(1 for count in arm_counts if count > 0)),
                    },
                    step=step,
                )

            if step % max(1, config.steps // 24) == 0:
                rollout_rows.append(
                    {
                        "step": step,
                        "chosen_arm": ARM_NAMES[action],
                        "reward": reward,
                        "reward_probability": round(reward_probability, 6),
                        "best_arm": ARM_NAMES[expected.index(best_expected)],
                        "best_expected_reward": round(best_expected, 6),
                    },
                )

            if emit_artifacts and step % config.artifact_every == 0:
                checkpoint_path = write_checkpoint(output_dir, config, step, model_weights, arm_counts, cumulative_regret)
                safe_artifact_log(
                    run,
                    artifact_sink,
                    server,
                    run.run_id,
                    {
                        "type": "checkpoint",
                        "name": checkpoint_path.name,
                        "uri": checkpoint_path.as_uri(),
                        "step": step,
                        "size_bytes": checkpoint_path.stat().st_size,
                        "metadata": {"policy": config.policy.name, "seed": config.seed, "cumulative_regret": round(cumulative_regret, 6)},
                    },
                )
    except Exception:
        status = "failed"
        raise
    finally:
        run.finish(status)

    if emit_artifacts:
        rollout_path = write_jsonl(output_dir / "rollout-summary.jsonl", rollout_rows)
        report_path = write_report(output_dir, config, total_reward, cumulative_regret, final_eval, arm_counts)
        safe_artifact_log(
            run,
            artifact_sink,
            server,
            run.run_id,
            {
                "type": "rollout",
                "name": rollout_path.name,
                "uri": rollout_path.as_uri(),
                "step": config.steps,
                "size_bytes": rollout_path.stat().st_size,
                "metadata": {"rows": len(rollout_rows), "return": round(total_reward, 4), "policy": config.policy.name},
            },
        )
        safe_artifact_log(
            run,
            artifact_sink,
            server,
            run.run_id,
            {
                "type": "file",
                "name": report_path.name,
                "uri": report_path.as_uri(),
                "step": config.steps,
                "size_bytes": report_path.stat().st_size,
                "metadata": {"kind": "training_report", "seed": config.seed, "policy": config.policy.name},
            },
        )

    return RunSummary(
        name=f"{config.policy.name}-seed-{config.seed}",
        seed=config.seed,
        policy=config.policy.name,
        total_reward=round(total_reward, 4),
        cumulative_regret=round(cumulative_regret, 4),
        eval_return_mean=round(final_eval * 100.0, 4),
    )


def make_true_weights(seed: int, arms: int, feature_dim: int) -> list[list[float]]:
    rng = random.Random(seed * 7919 + 17)
    weights = []
    for arm_index in range(arms):
        arm_bias = -0.65 + arm_index * 0.12
        weights.append([arm_bias] + [rng.uniform(-0.95, 0.95) for _ in range(feature_dim - 1)])
    return weights


def sample_context(rng: random.Random, step: int) -> list[float]:
    budget_signal = rng.betavariate(2.4, 3.0)
    novelty_signal = rng.random()
    loyalty_signal = min(1.0, max(0.0, rng.gauss(0.48, 0.22)))
    hour = (step % 24) / 24.0
    return [1.0, budget_signal, novelty_signal, loyalty_signal, math.sin(2 * math.pi * hour), math.cos(2 * math.pi * hour)]


def expected_rewards(context: list[float], true_weights: list[list[float]]) -> list[float]:
    return [sigmoid(dot(context, weights)) for weights in true_weights]


def choose_action(
    context: list[float],
    weights: list[list[float]],
    arm_counts: list[int],
    epsilon: float,
    optimism: float,
    rng: random.Random,
) -> int:
    if rng.random() < epsilon:
        return rng.randrange(len(weights))
    scores = []
    for arm, arm_weights in enumerate(weights):
        bonus = optimism / math.sqrt(arm_counts[arm] + 1)
        scores.append(dot(context, arm_weights) + bonus)
    return max(range(len(scores)), key=lambda index: (scores[index], -index))


def update_model(weights: list[float], context: list[float], reward: float, learning_rate: float) -> None:
    prediction = sigmoid(dot(context, weights))
    error = reward - prediction
    for index, value in enumerate(context):
        weights[index] += learning_rate * error * value


def current_epsilon(policy: PolicyConfig, step: int) -> float:
    return max(policy.min_epsilon, policy.initial_epsilon * (policy.exploration_decay ** max(0, step - 1)))


def evaluate_policy(weights: list[list[float]], true_weights: list[list[float]], seed: int, contexts: int = 200) -> float:
    rng = random.Random(seed * 104729 + 31)
    rewards = []
    arm_counts = [1 for _ in weights]
    for step in range(1, contexts + 1):
        context = sample_context(rng, step)
        action = choose_action(context, weights, arm_counts, epsilon=0.0, optimism=0.0, rng=rng)
        rewards.append(expected_rewards(context, true_weights)[action])
        arm_counts[action] += 1
    return mean(rewards)


def evaluate_oracle(true_weights: list[list[float]], seed: int, contexts: int = 200) -> float:
    rng = random.Random(seed * 104729 + 31)
    rewards = []
    for step in range(1, contexts + 1):
        context = sample_context(rng, step)
        rewards.append(max(expected_rewards(context, true_weights)))
    return mean(rewards)


def write_checkpoint(
    output_dir: Path,
    config: TrainingConfig,
    step: int,
    model_weights: list[list[float]],
    arm_counts: list[int],
    cumulative_regret: float,
) -> Path:
    path = output_dir / f"checkpoint-step-{step}.json"
    write_json(
        path,
        {
            "policy": config.policy.name,
            "seed": config.seed,
            "step": step,
            "arms": ARM_NAMES,
            "feature_names": FEATURE_NAMES,
            "weights": model_weights,
            "arm_counts": arm_counts,
            "cumulative_regret": cumulative_regret,
        },
    )
    return path


def write_report(
    output_dir: Path,
    config: TrainingConfig,
    total_reward: float,
    cumulative_regret: float,
    eval_return: float,
    arm_counts: list[int],
) -> Path:
    path = output_dir / "training-report.json"
    write_json(
        path,
        {
            "policy": config.policy.name,
            "seed": config.seed,
            "steps": config.steps,
            "total_reward": total_reward,
            "cumulative_regret": cumulative_regret,
            "eval_return_mean": eval_return,
            "arm_counts": dict(zip(ARM_NAMES, arm_counts, strict=False)),
        },
    )
    return path


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n", encoding="utf-8")
    return path


def safe_artifact_log(run: ObservableRun, artifact_sink: ArtifactSink | None, server: str, run_id: str, artifact: dict[str, Any]) -> None:
    try:
        if artifact_sink is not None:
            artifact_sink(server, run_id, artifact)
            return
        if artifact["type"] == "checkpoint":
            run.log_checkpoint(
                name=artifact["name"],
                uri=artifact["uri"],
                step=artifact["step"],
                size_bytes=artifact["size_bytes"],
                metadata=artifact["metadata"],
            )
        elif artifact["type"] == "rollout":
            run.log_rollout(
                name=artifact["name"],
                uri=artifact["uri"],
                step=artifact["step"],
                size_bytes=artifact["size_bytes"],
                metadata=artifact["metadata"],
            )
        else:
            run.log_artifact(
                name=artifact["name"],
                uri=artifact["uri"],
                step=artifact["step"],
                size_bytes=artifact["size_bytes"],
                metadata=artifact["metadata"],
            )
    except Exception as exc:  # pragma: no cover - defensive for older bootstrap APIs
        print(f"warning: artifact metadata was not logged: {exc}")


def parse_int_list(value: str) -> list[int]:
    parsed = [int(item.strip()) for item in value.split(",") if item.strip()]
    if not parsed:
        raise ValueError("at least one seed is required")
    return parsed


def parse_policy_list(value: str) -> list[str]:
    policies = [item.strip() for item in value.split(",") if item.strip()]
    unknown = [policy for policy in policies if policy not in POLICIES]
    if unknown:
        raise ValueError(f"unknown policy names: {', '.join(unknown)}")
    if not policies:
        raise ValueError("at least one policy is required")
    return policies


def validate_positive(name: str, value: int) -> None:
    if value <= 0:
        raise ValueError(f"{name} must be positive")


def arm_entropy(counts: list[int]) -> float:
    total = sum(counts)
    if total == 0:
        return 0.0
    entropy = 0.0
    for count in counts:
        if count:
            probability = count / total
            entropy -= probability * math.log(probability)
    return entropy


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-40.0, min(40.0, value))))


if __name__ == "__main__":  # pragma: no cover
    main()
