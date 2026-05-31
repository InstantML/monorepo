"""Rich value wrappers used by the InstantML SDK."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from .validation import _coerce_numeric_values, _validate_numeric_list, _validate_step


class Table:
    """Inline table object for rich run logging."""

    def __init__(
        self,
        columns: list[str] | tuple[str, ...] | None = None,
        rows: list[dict[str, Any] | list[Any] | tuple[Any, ...]] | tuple[dict[str, Any] | list[Any] | tuple[Any, ...], ...] | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        dataframe: Any | None = None,
        data: Any | None = None,
    ) -> None:
        if dataframe is not None and data is not None:
            raise ValueError("table accepts either dataframe or data, not both")
        if dataframe is not None:
            columns = list(getattr(dataframe, "columns", []))
            rows = dataframe.to_dict(orient="records")
        elif data is not None:
            rows = data
            if columns is None and isinstance(rows, list) and rows and isinstance(rows[0], dict):
                columns = list(rows[0].keys())
        self.columns = list(columns) if columns is not None else []
        self.rows = list(rows) if isinstance(rows, tuple) else rows if rows is not None else []
        self.metadata = metadata

    @classmethod
    def from_dataframe(cls, dataframe: Any, metadata: dict[str, Any] | None = None) -> "Table":
        return cls(metadata=metadata, dataframe=dataframe)

    @classmethod
    def from_data(
        cls,
        data: Any,
        columns: list[str] | tuple[str, ...] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Table":
        return cls(columns=columns, data=data, metadata=metadata)


class Histogram:
    """Histogram rich object.

    The positional ``Histogram(bins, counts)`` form is intentionally preserved.
    Use ``Histogram.from_values(...)`` for NumPy/tensor/list values.
    """

    def __init__(self, bins: list[int | float], counts: list[int | float], metadata: dict[str, Any] | None = None) -> None:
        self.bins = list(bins) if isinstance(bins, tuple) else bins
        self.counts = list(counts) if isinstance(counts, tuple) else counts
        self.metadata = metadata

    @classmethod
    def from_values(
        cls,
        values: Any,
        bins: int | list[int | float] | tuple[int | float, ...] = 64,
        metadata: dict[str, Any] | None = None,
    ) -> "Histogram":
        numeric_values = _coerce_numeric_values(values, "histogram values")
        if isinstance(bins, bool):
            raise TypeError("histogram bin count must be an integer")
        if isinstance(bins, int):
            if bins <= 0:
                raise ValueError("histogram bin count must be positive")
            return cls(*_histogram_from_count(numeric_values, bins), metadata=metadata)
        edges = _validate_numeric_list(list(bins), "histogram bins", nonnegative=False)
        if len(edges) < 2:
            raise ValueError("histogram bins must contain at least two edges")
        return cls(edges, _histogram_counts_for_edges(numeric_values, edges), metadata=metadata)


@dataclass(frozen=True)
class File:
    path: str
    name: str | None = None
    artifact_type: str = "file"
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class Artifact(File):
    pass


class VersionedArtifact:
    """Versioned artifact manifest for W&B-style lineage workflows."""

    def __init__(
        self,
        name: str,
        type: str = "file",
        metadata: dict[str, Any] | None = None,
        description: str | None = None,
        aliases: list[str] | tuple[str, ...] | None = None,
        ttl_days: int | None = None,
        files: list[str | os.PathLike[str]] | tuple[str | os.PathLike[str], ...] | dict[str, str | os.PathLike[str]] | None = None,
    ) -> None:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("artifact name must be a non-empty string")
        if not isinstance(type, str) or not type.strip():
            raise ValueError("artifact type must be a non-empty string")
        self.name = name.strip()
        self.type = type.strip()
        self.metadata = metadata
        self.description = description
        self.aliases = list(aliases or [])
        self.ttl_days = ttl_days
        self.files: list[dict[str, str]] = []
        if isinstance(files, dict):
            for artifact_path, source_path in files.items():
                self.add_file(source_path, name=artifact_path)
        elif files is not None:
            for source_path in files:
                self.add_file(source_path)

    def add_file(self, path: str | os.PathLike[str], name: str | None = None) -> "VersionedArtifact":
        source = os.fspath(path)
        artifact_path = name or os.path.basename(source)
        if not artifact_path:
            raise ValueError("artifact file name must be non-empty")
        self.files.append({"path": source, "name": artifact_path})
        return self


@dataclass(frozen=True)
class CheckpointPolicy:
    """Simple step-interval helper for checkpointing training loops."""

    every_steps: int
    include_step_zero: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.every_steps, int) or isinstance(self.every_steps, bool):
            raise TypeError("every_steps must be an integer")
        if self.every_steps <= 0:
            raise ValueError("every_steps must be positive")

    def should_save(self, step: int | float | None) -> bool:
        normalized = _validate_step(step)
        if normalized is None:
            return False
        numeric = float(normalized)
        if numeric == 0:
            return self.include_step_zero
        if not numeric.is_integer():
            return False
        return int(numeric) % self.every_steps == 0


@dataclass(frozen=True)
class Text:
    data: str
    name: str | None = None
    metadata: dict[str, Any] | None = None


class Image:
    def __init__(
        self,
        path: str | os.PathLike[str] | Any | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        data: Any | None = None,
    ) -> None:
        if data is not None and path is not None:
            raise ValueError("image accepts either path or data, not both")
        if data is None and path is not None and not isinstance(path, (str, os.PathLike)):
            data = path
            path = None
        self.path = None if path is None else os.fspath(path)
        self.data = data
        self.caption = caption
        self.metadata = metadata

    @classmethod
    def from_data(
        cls,
        data: Any,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Image":
        return cls(caption=caption, metadata=metadata, data=data)


class Video:
    def __init__(
        self,
        path: str | os.PathLike[str] | Any | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        data: Any | None = None,
        fps: int | float = 30,
        format: str = "mp4",
    ) -> None:
        if data is not None and path is not None:
            raise ValueError("video accepts either path or data, not both")
        if data is None and path is not None and not isinstance(path, (str, os.PathLike)):
            data = path
            path = None
        self.path = None if path is None else os.fspath(path)
        self.data = data
        self.caption = caption
        self.metadata = metadata
        self.fps = fps
        self.format = format

    @classmethod
    def from_data(
        cls,
        data: Any,
        fps: int | float = 30,
        format: str = "mp4",
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Video":
        return cls(caption=caption, metadata=metadata, data=data, fps=fps, format=format)


class Audio:
    def __init__(
        self,
        path: str | os.PathLike[str] | Any | None = None,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        data: Any | None = None,
        sample_rate: int = 48000,
    ) -> None:
        if data is not None and path is not None:
            raise ValueError("audio accepts either path or data, not both")
        if data is None and path is not None and not isinstance(path, (str, os.PathLike)):
            data = path
            path = None
        self.path = None if path is None else os.fspath(path)
        self.data = data
        self.caption = caption
        self.metadata = metadata
        self.sample_rate = sample_rate

    @classmethod
    def from_data(
        cls,
        data: Any,
        sample_rate: int = 48000,
        caption: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "Audio":
        return cls(caption=caption, metadata=metadata, data=data, sample_rate=sample_rate)


def _histogram_from_count(values: list[float], bins: int) -> tuple[list[float], list[float]]:
    low = min(values)
    high = max(values)
    if low == high:
        if bins == 1:
            return [low - 0.5, high + 0.5], [float(len(values))]
        width = 1.0 / bins
        start = low - 0.5
        edges = [start + index * width for index in range(bins + 1)]
        return edges, _histogram_counts_for_edges(values, edges)
    width = (high - low) / bins
    edges = [low + index * width for index in range(bins)]
    edges.append(high)
    return edges, _histogram_counts_for_edges(values, edges)


def _histogram_counts_for_edges(values: list[float], edges: list[float]) -> list[float]:
    counts = [0.0 for _ in range(len(edges) - 1)]
    for value in values:
        if value < edges[0] or value > edges[-1]:
            continue
        if value == edges[-1]:
            counts[-1] += 1.0
            continue
        for index in range(len(edges) - 1):
            if edges[index] <= value < edges[index + 1]:
                counts[index] += 1.0
                break
    return counts


for _public_class in (Table, Histogram, File, Artifact, VersionedArtifact, CheckpointPolicy, Text, Image, Video, Audio):
    _public_class.__module__ = "instantml.client"

del _public_class
