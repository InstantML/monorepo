from __future__ import annotations

from typing import Any

from ._common import OwnedRunMixin, collect_scalar_metrics, json_safe_config, require_optional


class InstantMLCallback(OwnedRunMixin):
    """CatBoost callback that logs train/validation metrics after iteration.

    Real CatBoost calls ``after_iteration(info)`` with an ``info`` object that
    exposes only ``iteration`` (1-based) and ``metrics`` — it never reports the
    total number of boosting rounds. For an adapter-owned run to auto-finish,
    pass ``total_iterations`` (the same value given to CatBoost's ``iterations``
    parameter). When neither ``total_iterations`` nor a best-effort total
    attribute is available, call :meth:`close` / :meth:`finish` yourself once
    training completes.
    """

    def __init__(
        self,
        run: Any | None = None,
        *,
        project: str | None = None,
        config: dict[str, Any] | None = None,
        total_iterations: int | None = None,
        finish_run: bool = False,
        check_dependency: bool = True,
        **init_kwargs: Any,
    ) -> None:
        if check_dependency:
            require_optional("catboost", "catboost")
        self.config = config
        self.total_iterations = total_iterations
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
        if self._is_last_iteration(info):
            self.finish()
        return True

    def after_train(self, info: Any | None = None) -> None:
        self.finish()

    def _is_last_iteration(self, info: Any) -> bool:
        for name in ("is_last_iteration", "is_last", "last_iteration"):
            value = getattr(info, name, None)
            if isinstance(value, bool):
                return value
        iteration = getattr(info, "iteration", None)
        if isinstance(iteration, bool) or not isinstance(iteration, (int, float)):
            return False
        # Reliable path: the caller told us how many rounds to expect. Real
        # CatBoost's `after_iteration` info is 1-based, so the last round is
        # reached when `iteration` equals `total_iterations`.
        if self.total_iterations is not None and not isinstance(self.total_iterations, bool):
            return int(iteration) >= int(self.total_iterations)
        # Best-effort fallback for frameworks that expose the total on `info`.
        for name in ("total_iterations", "iteration_count", "iterations_count", "num_iterations"):
            total = getattr(info, name, None)
            if isinstance(total, bool) or not isinstance(total, (int, float)):
                continue
            return int(iteration) >= int(total)
        return False


CatBoostCallback = InstantMLCallback

__all__ = ["InstantMLCallback", "CatBoostCallback"]
