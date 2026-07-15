"""Public tracing context managers for SDK users."""

from __future__ import annotations

import contextvars
import functools
import inspect
import secrets
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from .trace_payload import (
    MAX_TRACE_ATTRIBUTES_BYTES,
    MAX_TRACE_METRICS_BYTES,
    build_trace_event,
    json_object,
    normalize_capture,
    normalize_kind,
    normalize_optional_label,
    normalize_rank,
    normalize_span_id,
    normalize_trace_id,
    preview_payload,
    preview_text,
    utc_timestamp,
)


@dataclass(frozen=True)
class TraceContext:
    run_id: str
    trace_id: str
    span_id: str
    thread_id: str | None = None
    rank: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "thread_id": self.thread_id,
            "rank": self.rank,
        }


_CURRENT_TRACE_CONTEXT: contextvars.ContextVar[TraceContext | None] = contextvars.ContextVar(
    "instantml_current_trace_context",
    default=None,
)


class AttachedTraceContext:
    def __init__(self, context: TraceContext):
        self.context = context
        self._token: contextvars.Token[TraceContext | None] | None = _CURRENT_TRACE_CONTEXT.set(context)

    def __enter__(self) -> "AttachedTraceContext":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.detach()

    def detach(self) -> None:
        if self._token is not None:
            _CURRENT_TRACE_CONTEXT.reset(self._token)
            self._token = None


class TraceSpan:
    """A run-linked trace span.

    Instances are normal context managers. Root spans are created with
    ``run.trace(...)`` and child spans with ``trace.span(...)``.
    """

    def __init__(
        self,
        run: Any,
        name: str,
        *,
        kind: str = "custom",
        trace_id: str | None = None,
        parent_span_id: str | None = None,
        span_id: str | None = None,
        step: int | float | None = None,
        rank: int | None = None,
        thread_id: str | None = None,
        rollout_id: str | None = None,
        attributes: dict[str, Any] | None = None,
        metrics: dict[str, Any] | None = None,
        links: Any = None,
        capture: str = "off",
        inputs: Any = None,
        root: bool = False,
    ) -> None:
        current = _CURRENT_TRACE_CONTEXT.get()
        if root or getattr(current, "run_id", None) != getattr(run, "run_id", None):
            current = None
        explicit_trace_id = trace_id is not None
        inherited_trace_id = getattr(current, "trace_id", None)
        inherited_parent_span_id = None if explicit_trace_id else getattr(current, "span_id", None)
        inherited_thread_id = getattr(current, "thread_id", None)
        inherited_rank = getattr(current, "rank", None)
        self.run = run
        self.name = name
        self.kind = normalize_kind(kind)
        self.trace_id = normalize_trace_id(trace_id) if trace_id else (inherited_trace_id or uuid.uuid4().hex)
        self.span_id = normalize_span_id(span_id) if span_id else secrets.token_hex(8)
        self.parent_span_id = normalize_span_id(parent_span_id) if parent_span_id else inherited_parent_span_id
        self.step = step
        self.rank = normalize_rank(rank if rank is not None else inherited_rank)
        self.thread_id = normalize_optional_label(thread_id, "thread_id") or inherited_thread_id or self.trace_id
        self.rollout_id = normalize_optional_label(rollout_id, "rollout_id")
        self.attributes = self._normalize_payload_dict(attributes, "attributes", MAX_TRACE_ATTRIBUTES_BYTES)
        self.metrics = self._normalize_payload_dict(metrics, "metrics", MAX_TRACE_METRICS_BYTES)
        self.links = links
        self.capture = normalize_capture(capture)
        self.inputs = inputs
        self._started = False
        self._finished = False
        self._started_at: str | None = None
        self._started_monotonic: float | None = None
        self._sequence = 0
        self._lock = threading.RLock()
        self._context_token: contextvars.Token[TraceContext | None] | None = None
        self._output: Any = None
        self._input_preview = ""
        self._input_truncated = False

    def __enter__(self) -> "TraceSpan":
        self.start()
        self._context_token = _CURRENT_TRACE_CONTEXT.set(self._context())
        return self

    def __exit__(self, exc_type: object, exc: BaseException | None, tb: object) -> None:
        try:
            if exc is not None:
                self.finish(status="error", error=exc)
            else:
                self.finish(status="ok")
        finally:
            if self._context_token is not None:
                _CURRENT_TRACE_CONTEXT.reset(self._context_token)
                self._context_token = None

    def start(self) -> "TraceSpan":
        with self._lock:
            if self._started:
                return self
            self._started = True
            self._started_at = utc_timestamp()
            self._started_monotonic = time.monotonic()
            try:
                input_preview, input_truncated = preview_payload(self.inputs, self.capture, "inputs")
                self._input_preview = input_preview
                self._input_truncated = input_truncated
                self._emit(
                    event_kind="started",
                    status="running",
                    input_preview=input_preview,
                    truncated=input_truncated,
                )
            except (TypeError, ValueError) as exc:
                if not self._drop_invalid_payload(exc):
                    raise
        return self

    def finish(
        self,
        status: str = "ok",
        *,
        output: Any = None,
        error: BaseException | str | None = None,
        flush: bool | None = None,
    ) -> None:
        with self._lock:
            if self._finished:
                return
            if not self._started:
                self.start()
            self._finished = True
            if output is not None:
                self._output = output
            ended_at = utc_timestamp()
            duration_ms = self._duration_ms()
            event_kind = "finished"
            final_status = status
            error_type = None
            error_preview = ""
            error_truncated = False
            if error is not None or status == "error":
                event_kind = "exception"
                final_status = "error"
                error_type, error_preview, error_truncated = _error_preview(error, self.capture)
            elif status in {"cancelled", "interrupted"}:
                event_kind = "interrupted"
            try:
                output_preview, output_truncated = preview_payload(self._output, self.capture, "output")
                self._emit(
                    event_kind=event_kind,
                    status=final_status,
                    ended_at=ended_at,
                    duration_ms=duration_ms,
                    input_preview=self._input_preview,
                    output_preview=output_preview,
                    error_type=error_type,
                    error_preview=error_preview,
                    truncated=self._input_truncated or output_truncated or error_truncated,
                )
            except (TypeError, ValueError) as exc:
                if not self._drop_invalid_payload(exc):
                    raise
        should_flush = flush if flush is not None else self.parent_span_id is None
        if should_flush:
            self.flush()

    def span(self, name: str, **kwargs: Any) -> "TraceSpan":
        kwargs.setdefault("trace_id", self.trace_id)
        kwargs.setdefault("parent_span_id", self.span_id)
        kwargs.setdefault("thread_id", self.thread_id)
        kwargs.setdefault("rank", self.rank)
        return TraceSpan(self.run, name, **kwargs)

    def start_span(self, name: str, **kwargs: Any) -> "TraceSpan":
        span = self.span(name, **kwargs)
        span.start()
        return span

    def set_output(self, value: Any) -> None:
        self._output = value

    def add_attributes(self, values: dict[str, Any]) -> None:
        with self._lock:
            if self._finished:
                return
            try:
                self.attributes.update(json_object(values, "attributes", MAX_TRACE_ATTRIBUTES_BYTES))
                self._emit(event_kind="updated", status="running", attributes=self.attributes)
            except (TypeError, ValueError) as exc:
                if not self._drop_invalid_payload(exc):
                    raise

    def log_metric(self, key: str | dict[str, Any], value: Any | None = None) -> None:
        metrics = key if isinstance(key, dict) else {str(key): value}
        with self._lock:
            if self._finished:
                return
            try:
                normalized = json_object(metrics, "metrics", MAX_TRACE_METRICS_BYTES)
                self.metrics.update(normalized)
                self._emit(event_kind="updated", status="running", metrics=self.metrics)
            except (TypeError, ValueError) as exc:
                if not self._drop_invalid_payload(exc):
                    raise

    def context(self) -> dict[str, Any]:
        return self._context().as_dict()

    def flush(self) -> None:
        self.run._flush_trace_events()

    def wrap(self, fn: Callable[..., Any]) -> Callable[..., Any]:
        span_context = self._context()

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            token = _CURRENT_TRACE_CONTEXT.set(span_context)
            try:
                return fn(*args, **kwargs)
            finally:
                _CURRENT_TRACE_CONTEXT.reset(token)

        return wrapper

    def _context(self) -> TraceContext:
        return TraceContext(
            run_id=self.run.run_id,
            trace_id=self.trace_id,
            span_id=self.span_id,
            thread_id=self.thread_id,
            rank=self.rank,
        )

    def _duration_ms(self) -> float | None:
        if self._started_monotonic is None:
            return None
        return max(0.0, (time.monotonic() - self._started_monotonic) * 1000.0)

    def _emit(
        self,
        *,
        event_kind: str,
        status: str,
        ended_at: str | None = None,
        duration_ms: float | None = None,
        input_preview: str | None = None,
        output_preview: str = "",
        error_type: str | None = None,
        error_preview: str = "",
        attributes: dict[str, Any] | None = None,
        metrics: dict[str, Any] | None = None,
        truncated: bool = False,
    ) -> None:
        self._sequence += 1
        effective_input_preview = self._input_preview if input_preview is None else input_preview
        effective_truncated = truncated or (input_preview is None and self._input_truncated)
        content_available = bool(effective_input_preview or output_preview or error_preview)
        try:
            event = build_trace_event(
                trace_id=self.trace_id,
                span_id=self.span_id,
                parent_span_id=self.parent_span_id,
                event_id=str(uuid.uuid4()),
                sequence=self._sequence,
                event_kind=event_kind,
                name=self.name,
                kind=self.kind,
                status=status,
                step=self.step,
                rank=self.rank,
                thread_id=self.thread_id,
                rollout_id=self.rollout_id,
                started_at=self._started_at or utc_timestamp(),
                ended_at=ended_at,
                duration_ms=duration_ms,
                input_preview=effective_input_preview,
                output_preview=output_preview,
                error_type=error_type,
                error_preview=error_preview,
                attributes=attributes if attributes is not None else self.attributes,
                metrics=metrics if metrics is not None else self.metrics,
                links=self.links,
                content_policy="preview" if self.capture == "preview" else "off",
                redaction_state=_redaction_state(self.capture, content_available, effective_truncated),
                truncated=effective_truncated,
            )
        except (TypeError, ValueError) as exc:
            if self._drop_invalid_payload(exc):
                return
            raise
        self.run._record_trace_event(event)

    def _normalize_payload_dict(self, value: dict[str, Any] | None, field: str, max_bytes: int) -> dict[str, Any]:
        try:
            return json_object(value, field, max_bytes)
        except (TypeError, ValueError) as exc:
            if self._drop_invalid_payload(exc):
                return {}
            raise

    def _drop_invalid_payload(self, exc: TypeError | ValueError) -> bool:
        if getattr(self.run, "upload_mode", None) == "async":
            self.run._warn_async_drop(
                f"trace span dropped an invalid payload on the async path: {exc}",
                count_local=True,
            )
            return True
        return False


def attach_trace_context(run: Any, carrier: dict[str, Any]) -> AttachedTraceContext:
    if not isinstance(carrier, dict):
        raise TypeError("trace context must be a dictionary")
    trace_id = normalize_trace_id(str(carrier.get("trace_id") or ""))
    span_id = normalize_span_id(str(carrier.get("span_id") or carrier.get("parent_span_id") or ""))
    thread_id = normalize_optional_label(carrier.get("thread_id"), "thread_id")
    rank = normalize_rank(carrier.get("rank"))
    run_id = str(carrier.get("run_id") or run.run_id)
    if run_id != str(run.run_id):
        raise ValueError("trace context run_id does not match this run")
    return AttachedTraceContext(
        TraceContext(
            run_id=run_id,
            trace_id=trace_id,
            span_id=span_id,
            thread_id=thread_id,
            rank=rank,
        )
    )


def trace_op_decorator(
    run: Any,
    *,
    name: str | None = None,
    kind: str = "custom",
    step: int | float | None = None,
    rank: int | None = None,
    thread_id: str | None = None,
    rollout_id: str | None = None,
    attributes: dict[str, Any] | None = None,
    metrics: dict[str, Any] | None = None,
    links: Any = None,
    capture: str = "off",
    trace_id: str | None = None,
    parent_span_id: str | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    capture_policy = normalize_capture(capture)

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        if not callable(fn):
            raise TypeError("trace_op can only decorate callable objects")
        operation_name = name or getattr(fn, "__qualname__", None) or getattr(fn, "__name__", "operation")
        try:
            signature = inspect.signature(fn)
        except (TypeError, ValueError):
            signature = None

        if inspect.isasyncgenfunction(fn):

            @functools.wraps(fn)
            async def async_generator_wrapper(*args: Any, **kwargs: Any):
                span = _decorator_span(run, operation_name, signature, args, kwargs)
                token = _CURRENT_TRACE_CONTEXT.set(span._context())
                try:
                    async for item in fn(*args, **kwargs):
                        yield item
                except GeneratorExit:
                    _finish_decorator_span(span, status="interrupted")
                    raise
                except BaseException as exc:
                    _finish_decorator_span(span, status="error", error=exc)
                    raise
                else:
                    _finish_decorator_span(span, status="ok")
                finally:
                    _CURRENT_TRACE_CONTEXT.reset(token)

            return async_generator_wrapper

        if inspect.isgeneratorfunction(fn):

            @functools.wraps(fn)
            def generator_wrapper(*args: Any, **kwargs: Any):
                span = _decorator_span(run, operation_name, signature, args, kwargs)
                token = _CURRENT_TRACE_CONTEXT.set(span._context())
                try:
                    for item in fn(*args, **kwargs):
                        yield item
                except GeneratorExit:
                    _finish_decorator_span(span, status="interrupted")
                    raise
                except BaseException as exc:
                    _finish_decorator_span(span, status="error", error=exc)
                    raise
                else:
                    _finish_decorator_span(span, status="ok")
                finally:
                    _CURRENT_TRACE_CONTEXT.reset(token)

            return generator_wrapper

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                span = _decorator_span(run, operation_name, signature, args, kwargs)
                token = _CURRENT_TRACE_CONTEXT.set(span._context())
                try:
                    result = await fn(*args, **kwargs)
                except BaseException as exc:
                    _finish_decorator_span(span, status="error", error=exc)
                    raise
                else:
                    span.set_output(result)
                    _finish_decorator_span(span, status="ok")
                    return result
                finally:
                    _CURRENT_TRACE_CONTEXT.reset(token)

            return async_wrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            span = _decorator_span(run, operation_name, signature, args, kwargs)
            token = _CURRENT_TRACE_CONTEXT.set(span._context())
            try:
                result = fn(*args, **kwargs)
            except BaseException as exc:
                _finish_decorator_span(span, status="error", error=exc)
                raise
            else:
                span.set_output(result)
                _finish_decorator_span(span, status="ok")
                return result
            finally:
                _CURRENT_TRACE_CONTEXT.reset(token)

        return wrapper

    def _decorator_span(
        run: Any,
        operation_name: str,
        signature: inspect.Signature | None,
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> TraceSpan:
        span = TraceSpan(
            run,
            operation_name,
            kind=kind,
            trace_id=trace_id,
            parent_span_id=parent_span_id,
            step=step,
            rank=rank,
            thread_id=thread_id,
            rollout_id=rollout_id,
            attributes=attributes,
            metrics=metrics,
            links=links,
            capture=capture_policy,
            inputs=_decorator_inputs(signature, args, kwargs) if capture_policy == "preview" else None,
        )
        span.start()
        return span

    return decorate


def _decorator_inputs(
    signature: inspect.Signature | None,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    if signature is not None:
        try:
            bound = signature.bind_partial(*args, **kwargs)
            return {key: value for key, value in bound.arguments.items() if key not in {"self", "cls"}}
        except TypeError:
            pass
    return {"args": args, "kwargs": kwargs}


def _finish_decorator_span(span: TraceSpan, *, status: str, error: BaseException | str | None = None) -> None:
    span.finish(status=status, error=error)


def _redaction_state(capture: str, content_available: bool, truncated: bool) -> str:
    if capture != "preview":
        return "not_captured"
    if truncated:
        return "truncated"
    if content_available:
        return "captured"
    return "redacted"


def _error_preview(error: BaseException | str | None, capture: str) -> tuple[str | None, str, bool]:
    if error is None:
        return None, "", False
    if isinstance(error, BaseException):
        lines = traceback.format_exception_only(type(error), error)
        preview, truncated = preview_text("".join(lines).strip(), capture)
        return type(error).__name__, preview, truncated
    preview, truncated = preview_text(str(error), capture)
    return "Error", preview, truncated
