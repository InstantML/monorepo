"""W&B-compatible subset for logging directly to InstantML.

This module is intentionally opt-in: use ``import instantml.compat.wandb as
wandb``. It does not replace the official ``wandb`` package and unsupported
features raise clear errors.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from instantml import File, Image, Table, Video, init as instantml_init


run: "Run | None" = None


class Config(dict):
    def __init__(self, data: dict[str, Any] | None = None, inner: Any | None = None) -> None:
        super().__init__(data or {})
        self._inner = inner

    def attach(self, inner: Any | None) -> None:
        self._inner = inner

    def update(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        kwargs.pop("allow_val_change", None)
        super().update(*args, **kwargs)
        if self._inner is not None and hasattr(self._inner, "log_config"):
            self._inner.log_config(dict(self))


config: Config = Config()


class UnsupportedWandbFeature(NotImplementedError):
    pass


def _normalized_mode(mode: str | None) -> str | None:
    selected = mode if mode is not None else os.environ.get("WANDB_MODE")
    if selected is None and os.environ.get("WANDB_DISABLED", "").strip().lower() in {"1", "true", "yes"}:
        selected = "disabled"
    return selected.strip().lower() if isinstance(selected, str) else selected


def _reject_log_kwargs(kwargs: dict[str, Any]) -> None:
    if kwargs:
        names = ", ".join(sorted(kwargs))
        raise UnsupportedWandbFeature(
            f"wandb.log keyword argument(s) are not implemented by instantml.compat.wandb: {names}"
        )


class Artifact:
    def __init__(self, name: str, type: str = "file", **metadata: Any) -> None:
        self.name = name
        self.type = type
        self.metadata = metadata
        self._files: list[tuple[str, str | None]] = []
        self._references: list[tuple[str, str | None]] = []

    def add_file(self, local_path: str, name: str | None = None, **_: Any) -> None:
        self._files.append((local_path, name))

    def add_dir(self, local_path: str, name: str | None = None, **_: Any) -> None:
        path = Path(local_path)
        if not path.is_dir():
            raise ValueError("Artifact.add_dir expects a directory")
        for child in path.rglob("*"):
            if child.is_file():
                rel = str(Path(name or path.name) / child.relative_to(path))
                self.add_file(str(child), rel)

    def add_reference(self, uri: str, name: str | None = None, **_: Any) -> None:
        self._references.append((uri, name))


class Run:
    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.config = config

    def __enter__(self) -> "Run":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.finish(exit_code=1 if exc_type else 0)

    def log(self, data: dict[str, Any], step: int | float | None = None, **kwargs: Any) -> None:
        _reject_log_kwargs(kwargs)
        self._inner.log(data, step=step)

    def finish(self, exit_code: int | None = None, **_: Any) -> None:
        status = "failed" if exit_code not in (None, 0) else "finished"
        self._inner.finish(status=status)
        if globals().get("run") is self:
            globals()["run"] = None

    def define_metric(self, *_: Any, **__: Any) -> None:
        return None

    def watch(self, model: Any, **kwargs: Any) -> Any:
        return self._inner.watch(model, **kwargs)

    def log_artifact(self, artifact: Artifact, **_: Any) -> None:
        for path, name in artifact._files:
            self._inner.log({"artifact": File(path, name=name or Path(path).name, artifact_type=artifact.type)})
        for index, (uri, name) in enumerate(artifact._references):
            self._inner.log_artifact(name or f"{artifact.name}-{index}", uri, artifact_type=artifact.type)


def init(
    project: str | None = None,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    notes: str | None = None,
    id: str | None = None,
    group: str | None = None,
    job_type: str | None = None,
    resume: str | bool | None = None,
    mode: str | None = None,
    reinit: bool | None = None,
    dir: str | None = None,
    settings: Any | None = None,
    **kwargs: Any,
) -> Run:
    del resume, reinit, dir, settings
    selected_mode = _normalized_mode(mode)
    if selected_mode == "disabled":
        raise UnsupportedWandbFeature("wandb disabled mode is not implemented by instantml.compat.wandb")
    if selected_mode in {"offline", "dryrun"}:
        raise UnsupportedWandbFeature("wandb offline/dryrun modes are not implemented because they would otherwise silently drop logs")
    metadata = {"wandb_compat": {"id": id, "group": group, "job_type": job_type, "extra": kwargs}}
    globals()["config"] = Config(config or {})
    inner = instantml_init(project=project, name=name, config=config, tags=tags, notes=notes, metadata=metadata)
    globals()["config"].attach(inner)
    wrapped = Run(inner)
    globals()["run"] = wrapped
    return wrapped


def log(data: dict[str, Any], step: int | float | None = None, **kwargs: Any) -> None:
    if run is None:
        raise RuntimeError("wandb.log called before wandb.init")
    run.log(data, step=step, **kwargs)


def finish(exit_code: int | None = None, **kwargs: Any) -> None:
    if run is not None:
        run.finish(exit_code=exit_code, **kwargs)


def define_metric(*args: Any, **kwargs: Any) -> None:
    if run is not None:
        return run.define_metric(*args, **kwargs)
    return None


def watch(model: Any, **kwargs: Any) -> Any:
    if run is None:
        raise RuntimeError("wandb.watch called before wandb.init")
    return run.watch(model, **kwargs)


def sweep(*_: Any, **__: Any) -> None:
    raise UnsupportedWandbFeature("W&B sweeps are not supported by instantml.compat.wandb")


__all__ = [
    "Artifact",
    "Config",
    "Image",
    "Run",
    "Table",
    "UnsupportedWandbFeature",
    "Video",
    "config",
    "define_metric",
    "finish",
    "init",
    "log",
    "run",
    "sweep",
    "watch",
]
