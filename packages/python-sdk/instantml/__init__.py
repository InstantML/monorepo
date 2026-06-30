"""Python SDK for Training Observability."""

__version__ = "0.1.1"

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
    InstantMLStopRequested,
    InstantMLCallback,
    InstantMLKerasCallback,
    InstantMLLogger,
    LightningLogger,
    InstantMLError,
    LoggedArtifact,
    MetricSeriesPage,
    Page,
    Run,
    SourceTracking,
    StopRequest,
    Table,
    Text,
    TransformersCallback,
    Video,
    VersionedArtifact,
    attach_run,
    init,
)
from .tracing import AttachedTraceContext, TraceContext, TraceSpan
from .integrations import (
    CatBoostCallback,
    LightGBMCallback,
    OptunaCallback,
    StableBaselinesCallback,
    XGBoostCallback,
    log_dvc_metadata,
    log_hf_dataset,
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
    "InstantMLStopRequested",
    "InstantMLCallback",
    "InstantMLKerasCallback",
    "InstantMLLogger",
    "LightningLogger",
    "InstantMLError",
    "LoggedArtifact",
    "MetricSeriesPage",
    "Page",
    "Run",
    "SourceTracking",
    "StopRequest",
    "Table",
    "Text",
    "AttachedTraceContext",
    "TraceContext",
    "TraceSpan",
    "TransformersCallback",
    "Video",
    "VersionedArtifact",
    "CatBoostCallback",
    "LightGBMCallback",
    "OptunaCallback",
    "StableBaselinesCallback",
    "XGBoostCallback",
    "__version__",
    "drain_spool",
    "attach_run",
    "init",
    "log_dvc_metadata",
    "log_hf_dataset",
]


def drain_spool(*args, **kwargs):
    from .uploader import drain_spool as _drain_spool

    return _drain_spool(*args, **kwargs)
