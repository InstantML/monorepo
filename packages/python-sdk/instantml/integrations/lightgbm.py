from __future__ import annotations

from typing import Any

from ._common import OwnedRunMixin, json_safe_config, require_optional, sanitize_metric_key
from ._common import latest_scalar


class InstantMLCallback(OwnedRunMixin):
    """LightGBM callback for train and CV evaluation result tuples."""

    order = 20
    before_iteration = False

    def __init__(
        self,
        run: Any | None = None,
        *,
        project: str | None = None,
        finish_run: bool = False,
        check_dependency: bool = True,
        **init_kwargs: Any,
    ) -> None:
        if check_dependency:
            require_optional("lightgbm", "lightgbm")
        self._logged_config = False
        self._configure_run_owner(
            run=run,
            project=project,
            default_project="lightgbm",
            finish_run=finish_run,
            init_kwargs=init_kwargs,
        )

    def __call__(self, env: Any) -> None:
        run = self._ensure_run()
        params = json_safe_config(getattr(env, "params", None))
        if params and not self._logged_config:
            run.log_config({"lightgbm": params})
            self._logged_config = True
        metrics: dict[str, float] = {}
        for item in getattr(env, "evaluation_result_list", None) or []:
            parsed = self._parse_evaluation_tuple(item)
            metrics.update(parsed)
        if metrics:
            run.log(metrics, step=getattr(env, "iteration", None))

    def _parse_evaluation_tuple(self, item: Any) -> dict[str, float]:
        if not isinstance(item, tuple) or len(item) < 3:
            return {}
        dataset, metric, value = item[0], item[1], item[2]
        if len(item) >= 5:
            mean_key = sanitize_metric_key(dataset, f"{metric}-mean")
            stdv_key = sanitize_metric_key(dataset, f"{metric}-stdv")
            parsed: dict[str, float] = {}
            mean = latest_scalar(value)
            stdv = latest_scalar(item[4])
            if mean_key is not None and mean is not None:
                parsed[mean_key] = mean
            if stdv_key is not None and stdv is not None:
                parsed[stdv_key] = stdv
            return parsed
        key = sanitize_metric_key(dataset, metric)
        scalar = latest_scalar(value)
        return {key: scalar} if key is not None and scalar is not None else {}


LightGBMCallback = InstantMLCallback

__all__ = ["InstantMLCallback", "LightGBMCallback"]
