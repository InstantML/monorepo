"""Optional dual-logging to Weights & Biases for shadow-then-graduate pilots.

Enabled per-run via ``init(shadow_wandb=...)``. Three accepted values:

- ``True``: we call ``wandb.init(...)`` ourselves with args mirrored from the
  InstantML ``init`` call. wandb reads its own env vars (``WANDB_API_KEY``,
  ``WANDB_ENTITY``) for auth — no extra config needed.
- ``dict``: passed through as ``wandb.init(**dict)``, letting callers override
  the project / entity / name on the W&B side independently of ours.
- An already-constructed ``wandb.Run``: we attach to it and just fan log calls.

``wandb.init()`` can take seconds; it runs on a worker thread so InstantML's
init stays sub-millisecond. Log calls that arrive before W&B init resolves are
queued in order and drained as soon as it does. Any failure on the W&B side
disables shadow and warns — it never raises from the InstantML log path.
"""

from __future__ import annotations

import threading
import warnings
from typing import Any


class ShadowWandb:
    def __init__(
        self,
        *,
        project: str,
        name: str | None,
        config: dict[str, Any] | None,
        tags: list[str] | None,
        notes: str | None,
        wandb_kwargs: dict[str, Any] | None = None,
        existing_run: Any | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._wandb_run: Any | None = existing_run
        self._queue: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self._disabled = False
        self._init_done = threading.Event()
        if existing_run is not None:
            self._init_done.set()
            return

        init_kwargs: dict[str, Any] = {
            "project": project,
            "name": name,
            "config": config or {},
            "tags": tags or [],
            "notes": notes,
        }
        if wandb_kwargs:
            init_kwargs.update(wandb_kwargs)
        init_kwargs = {k: v for k, v in init_kwargs.items() if v is not None}

        def _resolve() -> None:
            try:
                import wandb  # type: ignore[import-not-found]
            except ImportError as exc:
                self._disable_with_warning(
                    f"shadow_wandb requested but the `wandb` package is not installed: {exc}"
                )
                return
            try:
                wandb_run = wandb.init(**init_kwargs)
            except Exception as exc:  # noqa: BLE001 — wandb surface is broad
                self._disable_with_warning(f"shadow_wandb wandb.init() failed: {exc}")
                return
            with self._lock:
                self._wandb_run = wandb_run
                pending = list(self._queue)
                self._queue.clear()
            for op, args, kwargs in pending:
                self._dispatch(op, *args, **kwargs)
            self._init_done.set()

        threading.Thread(
            target=_resolve,
            name="instantml-shadow-wandb-init",
            daemon=True,
        ).start()

    def _disable_with_warning(self, message: str) -> None:
        warnings.warn(f"{message}; shadow disabled", RuntimeWarning, stacklevel=2)
        with self._lock:
            self._disabled = True
            self._queue.clear()
        self._init_done.set()

    def _dispatch(self, op: str, *args: Any, **kwargs: Any) -> None:
        with self._lock:
            if self._disabled:
                return
            run = self._wandb_run
            if run is None:
                self._queue.append((op, args, kwargs))
                return
        try:
            if op == "log":
                run.log(*args, **kwargs)
            elif op == "finish":
                run.finish(*args, **kwargs)
            elif op == "config_update":
                cfg = args[0] if args else kwargs.get("data") or {}
                run.config.update(cfg, allow_val_change=True)
            elif op == "log_artifact":
                run.log_artifact(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            warnings.warn(f"shadow_wandb {op} failed: {exc}", RuntimeWarning, stacklevel=2)

    def log(self, data: dict[str, Any], step: int | float | None = None) -> None:
        if step is None:
            self._dispatch("log", data)
        else:
            wandb_step = int(step) if float(step).is_integer() else step
            self._dispatch("log", data, step=wandb_step)

    def update_config(self, data: dict[str, Any]) -> None:
        self._dispatch("config_update", data)

    def log_artifact_file(self, path: str, name: str, artifact_type: str = "model") -> None:
        with self._lock:
            if self._disabled:
                return
        import wandb  # type: ignore[import-not-found]  # safe: shadow is disabled if wandb is missing
        try:
            artifact = wandb.Artifact(name=name, type=artifact_type)
            artifact.add_file(path)
        except Exception as exc:  # noqa: BLE001
            warnings.warn(f"shadow_wandb building Artifact failed: {exc}", RuntimeWarning, stacklevel=2)
            return
        self._dispatch("log_artifact", artifact)

    def finish(self, status: str = "finished") -> None:
        exit_code = 0 if status == "finished" else 1
        self._dispatch("finish", exit_code=exit_code)
        self._init_done.set()

    def wait_for_init(self, timeout: float | None = None) -> bool:
        return self._init_done.wait(timeout=timeout)

    @property
    def disabled(self) -> bool:
        with self._lock:
            return self._disabled


def build_shadow(
    shadow_wandb: Any,
    *,
    project: str | None,
    name: str | None,
    config: dict[str, Any] | None,
    tags: list[str] | None,
    notes: str | None,
) -> ShadowWandb | None:
    if not shadow_wandb:
        return None
    # W&B's own default when project is omitted is to use "uncategorized" —
    # mirror that on the shadow side so the InstantML and W&B sides land in
    # the same project name.
    project_name = project or "uncategorized"
    if shadow_wandb is True:
        return ShadowWandb(
            project=project_name, name=name, config=config, tags=tags, notes=notes
        )
    if isinstance(shadow_wandb, dict):
        return ShadowWandb(
            project=project_name,
            name=name,
            config=config,
            tags=tags,
            notes=notes,
            wandb_kwargs=shadow_wandb,
        )
    return ShadowWandb(
        project=project_name,
        name=name,
        config=config,
        tags=tags,
        notes=notes,
        existing_run=shadow_wandb,
    )
