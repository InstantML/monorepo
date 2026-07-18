"""Seed rich object examples for the cross-run Objects dashboard."""

from __future__ import annotations

import argparse
import math
import random
from typing import Any

import instantml as im


VARIANTS = ("baseline", "candidate", "regularized")


def make_image(seed: int, step: int) -> list[list[list[int]]]:
    rng = random.Random(seed * 10_000 + step)
    pixels: list[list[list[int]]] = []
    for y in range(18):
        row: list[list[int]] = []
        for x in range(18):
            wave = int((math.sin((x + step) / 3.0) + 1.0) * 64)
            row.append([
                (seed * 37 + x * 7 + wave) % 256,
                (step * 29 + y * 11 + rng.randrange(24)) % 256,
                (x * y + seed * 17 + step * 13) % 256,
            ])
        pixels.append(row)
    return pixels


def sample_rows(seed: int, step: int, variant: str) -> list[dict[str, Any]]:
    rng = random.Random(seed * 1_000 + step)
    return [
        {
            "sample": f"{variant}-{step}-{index}",
            "score": round(0.58 + rng.random() * 0.38, 4),
            "label": "pass" if rng.random() > 0.28 else "review",
        }
        for index in range(5)
    ]


def histogram_for(seed: int, step: int) -> im.Histogram:
    rng = random.Random(seed * 2_000 + step)
    values = [rng.gauss(0.2 * seed, 0.35 + step * 0.02) for _ in range(80)]
    return im.Histogram.from_values(values, bins=[-1.5, -0.75, 0.0, 0.75, 1.5, 2.25])


def classification_eval(seed: int, step: int, variant: str) -> dict[str, Any]:
    rng = random.Random(seed * 3_000 + step)
    y_true = [index % 2 for index in range(24)]
    scores = [
        min(0.99, max(0.01, 0.33 + 0.34 * label + rng.uniform(-0.18, 0.18) + step * 0.012))
        for label in y_true
    ]
    predictions = [
        {
            "id": f"{variant}-{step}-{index}",
            "true_label": "positive" if label else "negative",
            "predicted_label": "positive" if score >= 0.5 else "negative",
            "score": round(score, 4),
        }
        for index, (label, score) in enumerate(zip(y_true, scores))
    ]
    return {
        "y_true": y_true,
        "y_score": scores,
        "class_names": ["negative", "positive"],
        "positive_label": "positive",
        "split": "validation",
        "predictions": predictions[:8],
    }


def run_variant(variant: str, seed: int, server: str, steps: int, skip_media: bool) -> str:
    run = None
    try:
        run = im.init(
            project="object-explorer-demo",
            name=f"{variant}-objects-seed-{seed}",
            config={"variant": variant, "seed": seed, "steps": steps},
            tags=["example", "objects", variant],
            notes="Rich-object seed run for the cross-run Objects dashboard.",
            metadata={"example": "examples/object-explorer"},
            base_url=server,
            upload_mode="sync",
        )
        for step in range(1, steps + 1):
            loss = max(0.05, 1.2 / (step + seed * 0.35))
            accuracy = min(0.99, 0.62 + step * 0.035 + seed * 0.012)
            run.log({"train/loss": loss, "eval/accuracy": accuracy}, step=step)
            run.log_text(
                {
                    "eval/summary": (
                        f"{variant} seed {seed} step {step}: "
                        f"accuracy={accuracy:.3f}, loss={loss:.3f}"
                    )
                },
                step=step,
            )
            objects: dict[str, Any] = {
                "eval/samples": im.Table.from_data(sample_rows(seed, step, variant)),
                "eval/score_histogram": histogram_for(seed, step),
            }
            if not skip_media:
                objects["eval/frame"] = im.Image.from_data(
                    make_image(seed, step),
                    caption=f"{variant} generated frame at step {step}",
                    metadata={"variant": variant},
                )
            run.log_objects(objects, step=step)
            eval_payload = classification_eval(seed, step, variant)
            run.log_classification_eval(
                "eval/classifier",
                y_true=eval_payload["y_true"],
                y_score=eval_payload["y_score"],
                class_names=eval_payload["class_names"],
                positive_label=eval_payload["positive_label"],
                split=eval_payload["split"],
                predictions=eval_payload["predictions"],
                step=step,
                metadata={"variant": variant},
            )
        run.finish()
        return run.run_id
    except Exception:
        if run is not None:
            run.finish("failed")
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="InstantML API base URL")
    parser.add_argument("--steps", type=int, default=4, help="steps per seeded run")
    parser.add_argument("--skip-media", action="store_true", help="skip generated image upload objects")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.steps <= 0:
        raise SystemExit("--steps must be positive")
    run_ids = [
        run_variant(variant, index + 1, args.server, args.steps, args.skip_media)
        for index, variant in enumerate(VARIANTS)
    ]
    print("Seeded object-explorer-demo runs:")
    for run_id in run_ids:
        print(f"- {run_id}")


if __name__ == "__main__":
    main()
