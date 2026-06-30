from __future__ import annotations

from typing import Any

from ._common import (
    OwnedRunMixin,
    collect_scalar_metrics,
    json_safe_config,
    require_optional,
    sanitize_metric_key,
)


class InstantMLCallback(OwnedRunMixin):
    """Optuna callback that logs completed trial metrics and parameters."""

    def __init__(
        self,
        run: Any | None = None,
        *,
        project: str | None = None,
        metric_name: str = "optuna/value",
        step_attr: str | None = None,
        intermediate_metric_prefix: str = "optuna/intermediate",
        user_attr_metric_prefix: str | None = "metric/",
        config_prefix: str = "optuna/params",
        finish_on_complete: bool = False,
        finish_run: bool = False,
        check_dependency: bool = True,
        **init_kwargs: Any,
    ) -> None:
        if check_dependency:
            require_optional("optuna", "optuna")
        self.metric_name = metric_name
        self.step_attr = step_attr
        self.intermediate_metric_prefix = intermediate_metric_prefix
        self.user_attr_metric_prefix = user_attr_metric_prefix
        self.config_prefix = config_prefix
        self.finish_on_complete = finish_on_complete
        self._configure_run_owner(
            run=run,
            project=project,
            default_project="optuna",
            finish_run=finish_run,
            init_kwargs=init_kwargs,
        )

    def __call__(self, study: Any, trial: Any) -> None:
        if self._skip_trial(trial):
            return
        run = self._ensure_run()
        step = self._trial_step(trial)
        metrics: dict[str, float] = {}
        value = getattr(trial, "value", None)
        if value is not None:
            key = sanitize_metric_key(self.metric_name)
            if key is not None:
                metrics.update(collect_scalar_metrics({key: value}, warn_prefix="optuna"))
        intermediate = getattr(trial, "intermediate_values", None)
        if isinstance(intermediate, dict):
            metrics.update(
                collect_scalar_metrics(
                    {self._intermediate_name(name): value for name, value in intermediate.items()},
                    warn_prefix="optuna intermediate",
                )
            )
        user_attrs = getattr(trial, "user_attrs", None)
        if isinstance(user_attrs, dict) and self.user_attr_metric_prefix:
            prefixed = {
                f"optuna/user_attrs/{str(key)[len(self.user_attr_metric_prefix):]}": value
                for key, value in user_attrs.items()
                if str(key).startswith(self.user_attr_metric_prefix)
            }
            metrics.update(collect_scalar_metrics(prefixed, warn_prefix="optuna user_attr"))
        if metrics:
            run.log(metrics, step=step)
        config = self._trial_config(study, trial)
        if config:
            run.log_config(config)
        if self.finish_on_complete and self._owns_run and self._study_is_complete(study):
            self.finish()

    def study_complete(self, study: Any | None = None) -> None:
        run = self._ensure_run()
        if study is not None:
            best = getattr(study, "best_value", None)
            if best is not None:
                run.log({"optuna/best_value": best})
        if self.finish_on_complete:
            self.finish()

    def _trial_step(self, trial: Any) -> int | float | None:
        if self.step_attr:
            value = getattr(trial, self.step_attr, None)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value
        value = getattr(trial, "number", None)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    def _intermediate_name(self, name: Any) -> str:
        if isinstance(name, (int, float)) and not isinstance(name, bool):
            return f"{self.intermediate_metric_prefix}/step_{name:g}"
        return f"{self.intermediate_metric_prefix}/{name}"

    def _trial_config(self, study: Any, trial: Any) -> dict[str, Any]:
        config: dict[str, Any] = {}
        params = json_safe_config(getattr(trial, "params", None))
        if params:
            current: dict[str, Any] = params
            for part in reversed([part for part in self.config_prefix.strip("/").split("/") if part]):
                current = {part: current}
            config.update(current)
        study_config = {
            "study_name": getattr(study, "study_name", None),
            "direction": str(getattr(study, "direction", "")) or None,
        }
        clean_study_config = {key: value for key, value in study_config.items() if value not in (None, "")}
        if clean_study_config:
            config.setdefault("optuna", {}).update(clean_study_config)
        return config

    def _skip_trial(self, trial: Any) -> bool:
        state = getattr(trial, "state", None)
        name = str(getattr(state, "name", state)).lower()
        return "fail" in name or "prun" in name

    def _study_is_complete(self, study: Any) -> bool:
        trials = getattr(study, "trials", None)
        if not trials:
            return False
        for trial in trials:
            if not self._skip_trial(trial) and getattr(trial, "value", None) is None:
                return False
        return True


OptunaCallback = InstantMLCallback

__all__ = ["InstantMLCallback", "OptunaCallback"]
