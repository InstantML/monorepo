"""Python SDK for Training Observability."""

__version__ = "0.1.0a1"

from .client import (
    Api,
    Artifact,
    Audio,
    CheckpointPolicy,
    Client,
    File,
    Histogram,
    Image,
    LightningLogger,
    InstantMLError,
    Run,
    Table,
    Text,
    TransformersCallback,
    Video,
    init,
)

__all__ = [
    "Api",
    "Artifact",
    "Audio",
    "CheckpointPolicy",
    "Client",
    "File",
    "Histogram",
    "Image",
    "LightningLogger",
    "InstantMLError",
    "Run",
    "Table",
    "Text",
    "TransformersCallback",
    "Video",
    "__version__",
    "drain_spool",
    "init",
]


def drain_spool(*args, **kwargs):
    from .uploader import drain_spool as _drain_spool

    return _drain_spool(*args, **kwargs)
