"""Local file and media conversion helpers for SDK uploads."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import InstantMLError
from .serialization import _tensor_to_python


def _is_local_file_uri(uri: str) -> bool:
    if not isinstance(uri, str):
        return False
    if uri.startswith("file://"):
        return True
    return "://" not in uri and Path(uri).exists()


def _strip_file_uri(uri: str) -> str:
    return uri[len("file://"):] if uri.startswith("file://") else uri


@dataclass(frozen=True)
class _FileStats:
    path: str
    sha256: str
    size_bytes: int


def _hash_file(path: Path) -> _FileStats:
    if not path.exists() or not path.is_file():
        raise InstantMLError(f"upload source does not exist: {path}")
    digest = hashlib.sha256()
    size_bytes = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            size_bytes += len(chunk)
            digest.update(chunk)
    return _FileStats(path=str(path), sha256=digest.hexdigest(), size_bytes=size_bytes)


def _write_image_data(data: Any, target: Path) -> None:
    if data is None:
        raise InstantMLError("image data is required")
    if callable(getattr(data, "savefig", None)):
        data.savefig(target)
        return
    if callable(getattr(data, "save", None)):
        data.save(target)
        return
    try:
        from PIL import Image as PillowImage
    except ImportError as exc:
        raise InstantMLError("Pillow is required to log image data") from exc
    try:
        import numpy as np
    except ImportError as exc:
        raise InstantMLError("numpy is required to log image data arrays") from exc
    array = np.asarray(_tensor_to_python(data))
    if array.dtype != np.uint8:
        if array.max() <= 1.0:
            array = array * 255
        array = np.clip(array, 0, 255).astype("uint8")
    PillowImage.fromarray(array).save(target)


def _write_audio_data(data: Any, target: Path, sample_rate: int) -> None:
    if data is None:
        raise InstantMLError("audio data is required")
    try:
        import soundfile
    except ImportError as exc:
        raise InstantMLError("soundfile is required to log audio data") from exc
    soundfile.write(target, _tensor_to_python(data), sample_rate)


def _write_video_data(data: Any, target: Path, fps: int | float) -> None:
    if data is None:
        raise InstantMLError("video data is required")
    try:
        import imageio.v3 as imageio
    except ImportError as imageio_error:
        try:
            from moviepy.video.io.ImageSequenceClip import ImageSequenceClip
        except ImportError as moviepy_error:
            raise InstantMLError("moviepy or imageio is required to log video data") from moviepy_error
        clip = ImageSequenceClip(_tensor_to_python(data), fps=fps)
        clip.write_videofile(str(target), logger=None)
        return
    try:
        imageio.imwrite(target, _tensor_to_python(data), fps=fps)
    except TypeError as exc:
        raise InstantMLError("moviepy or imageio is required to log video data") from exc
