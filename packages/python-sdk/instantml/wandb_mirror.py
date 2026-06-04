"""W&B-primary mirroring into InstantML.

Use this module as a one-line import swap when W&B must remain the source of
truth during a pilot:

    import instantml.wandb_mirror as wandb

The official ``wandb`` package still receives ``init`` / ``log`` / ``finish``.
InstantML receives a best-effort mirror of scalar metrics and config updates.
InstantML failures affect only the mirror path; they never interrupt the W&B
logging path.
"""

from __future__ import annotations

import importlib
import math
import warnings
from numbers import Real
from typing import Any, Iterator

from instantml import init as instantml_init


run: "Run | None" = None
_real_wandb: Any | None = None
_warned: set[str] = set()


def _wandb() -> Any:
    global _real_wandb
    if _real_wandb is None:
        _real_wandb = importlib.import_module("wandb")
    return _real_wandb


def _warn_once(key: str, message: str) -> None:
    if key in _warned:
        return
    _warned.add(key)
    warnings.warn(message, RuntimeWarning, stacklevel=2)


def _safe_config(data: Any) -> dict[str, Any] | None:
    if data is None:
        return None
    if isinstance(data, dict):
        return dict(data)
    try:
        return dict(data)
    except Exception:
        _warn_once(
            "config",
            "instantml.wandb_mirror could not mirror a non-mapping W&B config",
        )
        return None


def _scalar_metrics(data: dict[str, Any]) -> dict[str, float | int]:
    metrics: dict[str, float | int] = {}
    for key, value in data.items():
        if isinstance(value, bool) or not isinstance(value, Real):
            continue
        number = float(value)
        if math.isfinite(number):
            metrics[str(key)] = int(value) if isinstance(value, int) else number
    return metrics


class ConfigProxy:
    def __init__(self, wandb_config: Any | None = None, instantml_run: Any | None = None) -> None:
        self._wandb_config = wandb_config
        self._instantml_run = instantml_run

    def attach(self, wandb_config: Any | None, instantml_run: Any | None) -> None:
        self._wandb_config = wandb_config
        self._instantml_run = instantml_run

    def update(self, *args: Any, **kwargs: Any) -> Any:
        result = None
        if self._wandb_config is not None and hasattr(self._wandb_config, "update"):
            result = self._wandb_config.update(*args, **kwargs)
        mirrored = _safe_config(args[0] if args else kwargs)
        if mirrored and self._instantml_run is not None and hasattr(self._instantml_run, "log_config"):
            try:
                self._instantml_run.log_config(mirrored)
            except Exception as exc:  # noqa: BLE001
                _warn_once("config_update", f"instantml.wandb_mirror config mirror failed: {exc}")
        return result

    def __getitem__(self, key: str) -> Any:
        return self._wandb_config[key]

    def __setitem__(self, key: str, value: Any) -> None:
        if self._wandb_config is None:
            raise RuntimeError("wandb.config is not available before wandb.init")
        self._wandb_config[key] = value
        self.update({key: value})

    def __iter__(self) -> Iterator[Any]:
        return iter(self._wandb_config or {})

    def __len__(self) -> int:
        return len(self._wandb_config or {})

    def __getattr__(self, name: str) -> Any:
        if self._wandb_config is None:
            raise AttributeError(name)
        return getattr(self._wandb_config, name)


config = ConfigProxy()


class Run:
    def __init__(self, wandb_run: Any, instantml_run: Any | None) -> None:
        self._wandb_run = wandb_run
        self._instantml_run = instantml_run
        self.config = config

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.finish(exit_code=1 if exc_type else 0)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._wandb_run, name)

    def log(self, data: dict[str, Any], step: int | float | None = None, **kwargs: Any) -> Any:
        result = self._wandb_run.log(data, step=step, **kwargs)
        self._mirror_log(data, step=step, kwargs=kwargs)
        return result

    def _mirror_log(self, data: dict[str, Any], step: int | float | None, kwargs: dict[str, Any]) -> None:
        if self._instantml_run is None:
            return
        if kwargs:
            _warn_once(
                "log_kwargs",
                "instantml.wandb_mirror skipped mirroring W&B log calls with extra kwargs",
            )
            return
        metrics = _scalar_metrics(data)
        if not metrics:
            return
        try:
            self._instantml_run.log(metrics, step=step)
        except Exception as exc:  # noqa: BLE001
            _warn_once("log", f"instantml.wandb_mirror metric mirror failed: {exc}")

    def log_artifact(self, *args: Any, **kwargs: Any) -> Any:
        result = self._wandb_run.log_artifact(*args, **kwargs)
        _warn_once(
            "artifact",
            "instantml.wandb_mirror does not mirror W&B artifacts yet; W&B logged the artifact",
        )
        return result

    def finish(self, exit_code: int | None = None, **kwargs: Any) -> Any:
        result = self._wandb_run.finish(exit_code=exit_code, **kwargs)
        if self._instantml_run is not None:
            status = "failed" if exit_code not in (None, 0) else "finished"
            try:
                self._instantml_run.finish(status=status)
            except Exception as exc:  # noqa: BLE001
                _warn_once("finish", f"instantml.wandb_mirror finish mirror failed: {exc}")
        if globals().get("run") is self:
            globals()["run"] = None
        return result


def init(
    project: str | None = None,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    notes: str | None = None,
    id: str | None = None,
    group: str | None = None,
    job_type: str | None = None,
    **kwargs: Any,
) -> Run:
    instantml_project = kwargs.pop("instantml_project", project)
    instantml_api_key = kwargs.pop("instantml_api_key", None)
    instantml_base_url = kwargs.pop("instantml_base_url", None)
    instantml_disabled = bool(kwargs.pop("instantml_disabled", False))
    instantml_kwargs = kwargs.pop("instantml_kwargs", {}) or {}

    wb = _wandb()
    wandb_run = wb.init(
        project=project,
        name=name,
        config=config,
        tags=tags,
        notes=notes,
        id=id,
        group=group,
        job_type=job_type,
        **kwargs,
    )

    instant_run = None
    if not instantml_disabled:
        metadata = {
            "wandb_shadow": {
                "project": project,
                "entity": kwargs.get("entity"),
                "id": id,
                "group": group,
                "job_type": job_type,
            }
        }
        try:
            instant_run = instantml_init(
                project=instantml_project,
                name=name,
                config=_safe_config(config),
                tags=list(tags) if tags else None,
                notes=notes,
                metadata=metadata,
                api_key=instantml_api_key,
                base_url=instantml_base_url,
                **instantml_kwargs,
            )
        except Exception as exc:  # noqa: BLE001
            _warn_once("init", f"instantml.wandb_mirror InstantML init failed; mirror disabled: {exc}")

    globals()["config"].attach(getattr(wb, "config", None), instant_run)
    wrapped = Run(wandb_run, instant_run)
    globals()["run"] = wrapped
    return wrapped


def log(data: dict[str, Any], step: int | float | None = None, **kwargs: Any) -> Any:
    if run is not None:
        return run.log(data, step=step, **kwargs)
    return _wandb().log(data, step=step, **kwargs)


def finish(exit_code: int | None = None, **kwargs: Any) -> Any:
    if run is not None:
        return run.finish(exit_code=exit_code, **kwargs)
    return _wandb().finish(exit_code=exit_code, **kwargs)


def define_metric(*args: Any, **kwargs: Any) -> Any:
    return _wandb().define_metric(*args, **kwargs)


def watch(*args: Any, **kwargs: Any) -> Any:
    if run is not None:
        return run._wandb_run.watch(*args, **kwargs)
    return _wandb().watch(*args, **kwargs)


def __getattr__(name: str) -> Any:
    return getattr(_wandb(), name)


__all__ = [
    "ConfigProxy",
    "Run",
    "config",
    "define_metric",
    "finish",
    "init",
    "log",
    "run",
    "watch",
]
