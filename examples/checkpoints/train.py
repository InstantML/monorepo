"""Checkpoint dogfood example for InstantML.

The toy model is intentionally small and standard-library only. It exercises
the production checkpoint path: write checkpoint bytes, upload them as
InstantML checkpoint artifacts, and optionally resume a new run from a saved
checkpoint file.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import instantml as im


@dataclass(frozen=True)
class TrainConfig:
    project: str = "checkpoints"
    steps: int = 12
    checkpoint_every: int = 4
    learning_rate: float = 0.05
    momentum: float = 0.8
    target: float = 1.5
    seed: int = 7


def initial_state(config: TrainConfig) -> dict[str, Any]:
    return {
        "step": 0,
        "weight": 0.05 * config.seed,
        "bias": 0.0,
        "velocity": 0.0,
    }


def train_step(state: dict[str, Any], config: TrainConfig) -> dict[str, float]:
    step = int(state["step"]) + 1
    x_value = 0.75 + (step % 5) * 0.1
    prediction = float(state["weight"]) * x_value + float(state["bias"])
    error = prediction - config.target
    grad_weight = 2.0 * error * x_value
    grad_bias = 2.0 * error
    velocity = config.momentum * float(state["velocity"]) + grad_weight

    state["step"] = step
    state["velocity"] = velocity
    state["weight"] = float(state["weight"]) - config.learning_rate * velocity
    state["bias"] = float(state["bias"]) - config.learning_rate * grad_bias

    loss = error * error
    return {
        "train/loss": loss,
        "train/prediction": prediction,
        "model/weight": float(state["weight"]),
        "model/bias": float(state["bias"]),
    }


def save_checkpoint(path: Path, state: dict[str, Any], config: TrainConfig) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "state": state,
        "config": asdict(config),
        "format": "instantml-checkpoint-example-v1",
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return path


def load_checkpoint(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("format") != "instantml-checkpoint-example-v1":
        raise ValueError("unsupported checkpoint format")
    state = payload.get("state")
    if not isinstance(state, dict) or "step" not in state:
        raise ValueError("checkpoint is missing state")
    return state


def run_training(
    run: Any,
    config: TrainConfig,
    artifact_dir: Path,
    resume_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state = dict(resume_state or initial_state(config))
    start_step = int(state["step"])
    end_step = start_step + config.steps
    checkpoint_policy = im.CheckpointPolicy(every_steps=config.checkpoint_every)
    checkpoints: list[dict[str, Any]] = []

    while int(state["step"]) < end_step:
        metrics = train_step(state, config)
        step = int(state["step"])
        run.log(metrics, step=step)
        if checkpoint_policy.should_save(step):
            checkpoint_path = save_checkpoint(artifact_dir / f"checkpoint-step-{step}.json", state, config)
            artifact = run.log_checkpoint_file(
                str(checkpoint_path),
                step=step,
                metadata={
                    "framework": "json",
                    "loss": round(metrics["train/loss"], 8),
                    "checkpoint": {
                        "step": step,
                        "start_step": start_step,
                    },
                },
            )
            checkpoints.append({
                "step": step,
                "path": str(checkpoint_path),
                "artifact_id": artifact.get("id"),
                "size_bytes": checkpoint_path.stat().st_size,
            })

    return {
        "start_step": start_step,
        "end_step": int(state["step"]),
        "final_state": state,
        "checkpoints": checkpoints,
        "latest_checkpoint": checkpoints[-1] if checkpoints else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="InstantML checkpoint dogfood example")
    parser.add_argument("--server", default="http://127.0.0.1:8000")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--project", default="checkpoints")
    parser.add_argument("--name", default="")
    parser.add_argument("--steps", type=int, default=12)
    parser.add_argument("--checkpoint-every", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--momentum", type=float, default=0.8)
    parser.add_argument("--target", type=float, default=1.5)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--artifact-dir", type=Path, default=Path(".instantml/checkpoint-example"))
    parser.add_argument("--resume-from", type=Path, default=None)
    parser.add_argument("--summary-json", type=Path, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = TrainConfig(
        project=args.project,
        steps=args.steps,
        checkpoint_every=args.checkpoint_every,
        learning_rate=args.learning_rate,
        momentum=args.momentum,
        target=args.target,
        seed=args.seed,
    )
    resume_state = load_checkpoint(args.resume_from) if args.resume_from else None
    resume_metadata = None
    if resume_state is not None:
        resume_metadata = {
            "checkpoint_path": str(args.resume_from),
            "checkpoint_step": int(resume_state["step"]),
        }
    client = im.Client(base_url=args.server, api_key=args.api_key)
    run = client.init(
        project=config.project,
        name=args.name or ("resume-from-checkpoint" if resume_state else "checkpoint-source"),
        config={
            **asdict(config),
            "resume_from_checkpoint": resume_metadata,
        },
        tags=["checkpoint-demo", "resumed" if resume_state else "source"],
        metadata={"resumed_from_checkpoint": resume_metadata} if resume_metadata else {"example": "checkpoints"},
    )
    try:
        summary = run_training(run, config, args.artifact_dir, resume_state=resume_state)
        run.finish()
    except Exception:
        run.finish("failed")
        raise

    summary["run_id"] = run.run_id
    summary["project"] = config.project
    if args.summary_json:
        args.summary_json.parent.mkdir(parents=True, exist_ok=True)
        args.summary_json.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    else:
        print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
