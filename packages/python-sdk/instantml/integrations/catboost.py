from __future__ import annotations

from typing import Any

from ._common import OwnedRunMixin, collect_scalar_metrics, json_safe_config, require_optional


class InstantMLCallback(OwnedRunMixin):
    """CatBoost callback that logs train/validation metrics after iteration."""

    def __init__(
        self,
        run: Any | None = None,
        *,
        project: str | None = None,
        config: dict[str, Any] | None = None,
        finish_run: bool = False,
        check_dependency: bool = True,
        **init_kwargs: Any,
    ) -> None:
        if check_dependency:
            require_optional("catboost", "catboost")
        self.config = config
        self._logged_config = False
        self._configure_run_owner(
            run=run,
            project=project,
            default_project="catboost",
            finish_run=finish_run,
            init_kwargs=init_kwargs,
        )

    def after_iteration(self, info: Any) -> bool:
        run = self._ensure_run()
        config = json_safe_config(self.config)
        if config and not self._logged_config:
            run.log_config({"catboost": config})
            self._logged_config = True
        metrics: dict[str, float] = {}
        raw_metrics = getattr(info, "metrics", None)
        if isinstance(raw_metrics, dict):
            for dataset, dataset_metrics in raw_metrics.items():
                if isinstance(dataset_metrics, dict):
                    metrics.update(collect_scalar_metrics(dataset_metrics, prefix=str(dataset), warn_prefix="catboost"))
        if metrics:
            run.log(metrics, step=getattr(info, "iteration", None))
        return True

    def after_train(self, info: Any | None = None) -> None:
        self.finish()


CatBoostCallback = InstantMLCallback

__all__ = ["InstantMLCallback", "CatBoostCallback"]
