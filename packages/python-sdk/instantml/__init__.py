"""Python SDK for Training Observability."""

__version__ = "0.1.0a2"

from .client import (
    Api,
    Artifact,
    Audio,
    CheckpointPolicy,
    ClassificationEval,
    Client,
    File,
    Histogram,
    Image,
    InstantMLCallback,
    InstantMLKerasCallback,
    InstantMLLogger,
    LightningLogger,
    InstantMLError,
    LoggedArtifact,
    Run,
    SourceTracking,
    Table,
    Text,
    TransformersCallback,
    Video,
    VersionedArtifact,
    attach_run,
    init,
)

__all__ = [
    "Api",
    "Artifact",
    "Audio",
    "CheckpointPolicy",
    "ClassificationEval",
    "Client",
    "File",
    "Histogram",
    "Image",
    "InstantMLCallback",
    "InstantMLKerasCallback",
    "InstantMLLogger",
    "LightningLogger",
    "InstantMLError",
    "LoggedArtifact",
    "Run",
    "SourceTracking",
    "Table",
    "Text",
    "TransformersCallback",
    "Video",
    "VersionedArtifact",
    "__version__",
    "drain_spool",
    "attach_run",
    "init",
]


def drain_spool(*args, **kwargs):
    from .uploader import drain_spool as _drain_spool

    return _drain_spool(*args, **kwargs)
