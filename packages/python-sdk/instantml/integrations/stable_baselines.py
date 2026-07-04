from __future__ import annotations

from pathlib import Path
from typing import Any

from ._common import (
    OwnedRunMixin,
    collect_scalar_metrics,
    framework_adapter_new,
    optional_base,
    require_optional,
    scalar_number,
)


def _stable_baselines_callback_base() -> type | None:
    return optional_base("stable_baselines3.common.callbacks", "BaseCallback")


class InstantMLCallback(OwnedRunMixin):
    """Stable Baselines-style callback for episode and logger metrics."""

    def __new__(cls, *args: Any, **kwargs: Any) -> Any:
        if cls is InstantMLCallback:
            return framework_adapter_new(cls, _stable_baselines_callback_base(), "InstantMLStableBaselinesCallback")
        return object.__new__(cls)

    def __init__(
        self,
        run: Any | None = None,
        *,
        project: str | None = None,
        finish_run: bool = False,
        verbose: int = 0,
        check_dependency: bool = True,
        **init_kwargs: Any,
    ) -> None:
        if check_dependency:
            require_optional("stable_baselines3", "rl", package="stable-baselines3")
        try:
            super().__init__(verbose=verbose)
        except TypeError:
            pass
        self._configure_run_owner(
            run=run,
            project=project,
            default_project="stable-baselines",
            finish_run=finish_run,
            init_kwargs=init_kwargs,
        )
        self._last_logger_step: int | float | None = None

    def _on_step(self) -> bool:
        metrics = self._episode_metrics()
        if metrics:
            self._ensure_run().log(metrics, step=getattr(self, "num_timesteps", None))
        return True

    def _on_rollout_end(self) -> None:
        step = getattr(self, "num_timesteps", None)
        if step == self._last_logger_step:
            return
        metrics = self._logger_metrics()
        if metrics:
            self._ensure_run().log(metrics, step=step)
            self._last_logger_step = step

    def _on_training_end(self) -> None:
        self.finish()

    def log_rollout(self, path: str | Path, *, step: int | float | None = None, name: str = "rl/rollout") -> None:
        rollout_path = Path(path)
        self._ensure_run().log_artifact(
            name,
            f"file://{rollout_path}",
            artifact_type="rollout",
            step=step if step is not None else getattr(self, "num_timesteps", None),
        )

    def _episode_metrics(self) -> dict[str, float]:
        rewards: list[float] = []
        lengths: list[float] = []
        for info in (getattr(self, "locals", {}) or {}).get("infos", []) or []:
            episode = info.get("episode") if isinstance(info, dict) else None
            if not isinstance(episode, dict):
                continue
            reward = scalar_number(episode.get("r"))
            length = scalar_number(episode.get("l"))
            if reward is not None:
                rewards.append(reward)
            if length is not None:
                lengths.append(length)
        metrics: dict[str, float] = {}
        if rewards:
            metrics["rl/episode_reward"] = sum(rewards) / len(rewards)
            metrics["rl/episodes"] = float(len(rewards))
            if len(rewards) > 1:
                metrics["rl/episode_reward_min"] = min(rewards)
                metrics["rl/episode_reward_max"] = max(rewards)
        if lengths:
            metrics["rl/episode_length"] = sum(lengths) / len(lengths)
            if len(lengths) > 1:
                metrics["rl/episode_length_min"] = min(lengths)
                metrics["rl/episode_length_max"] = max(lengths)
        return metrics

    def _logger_metrics(self) -> dict[str, float]:
        logger = getattr(self, "logger", None)
        values = getattr(logger, "name_to_value", None)
        if not isinstance(values, dict):
            return {}
        return collect_scalar_metrics(values, prefix="rl", warn_prefix="rl logger")


StableBaselinesCallback = InstantMLCallback

__all__ = ["InstantMLCallback", "StableBaselinesCallback"]
