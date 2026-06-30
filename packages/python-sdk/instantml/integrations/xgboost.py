from __future__ import annotations

from typing import Any

from ._common import (
    OwnedRunMixin,
    collect_scalar_metrics,
    framework_adapter_new,
    json_safe_config,
    optional_base,
    require_optional,
)


def _xgboost_callback_base() -> type | None:
    return optional_base("xgboost.callback", "TrainingCallback")


class InstantMLCallback(OwnedRunMixin):
    """XGBoost TrainingCallback that logs the latest evals_log values."""

    def __new__(cls, *args: Any, **kwargs: Any) -> Any:
        if cls is InstantMLCallback:
            return framework_adapter_new(cls, _xgboost_callback_base(), "InstantMLXGBoostCallback")
        return object.__new__(cls)

    def __init__(
        self,
        run: Any | None = None,
        *,
        project: str | None = None,
        params: dict[str, Any] | None = None,
        finish_run: bool = False,
        check_dependency: bool = True,
        **init_kwargs: Any,
    ) -> None:
        if check_dependency:
            require_optional("xgboost", "xgboost")
        self.params = params
        self._logged_config = False
        self._configure_run_owner(
            run=run,
            project=project,
            default_project="xgboost",
            finish_run=finish_run,
            init_kwargs=init_kwargs,
        )

    def after_iteration(self, model: Any, epoch: int, evals_log: dict[str, Any]) -> bool:
        run = self._ensure_run()
        if self.params is not None and not self._logged_config:
            config = json_safe_config(self.params)
            if config:
                run.log_config({"xgboost": config})
            self._logged_config = True
        metrics: dict[str, float] = {}
        for dataset, dataset_metrics in (evals_log or {}).items():
            if isinstance(dataset_metrics, dict):
                metrics.update(collect_scalar_metrics(dataset_metrics, prefix=str(dataset), warn_prefix="xgboost"))
        if metrics:
            run.log(metrics, step=epoch)
        return False

    def after_training(self, model: Any) -> Any:
        self.finish()
        return model


XGBoostCallback = InstantMLCallback

__all__ = ["InstantMLCallback", "XGBoostCallback"]
