"""Optional framework adapters for the InstantML Python SDK.

The modules in this package intentionally avoid importing heavy ML frameworks
at package import time. Install and import only the adapter you need.
"""

from .catboost import InstantMLCallback as CatBoostCallback
from .datasets import log_dvc_metadata, log_hf_dataset
from .lightgbm import InstantMLCallback as LightGBMCallback
from .optuna import InstantMLCallback as OptunaCallback
from .stable_baselines import InstantMLCallback as StableBaselinesCallback
from .xgboost import InstantMLCallback as XGBoostCallback

__all__ = [
    "CatBoostCallback",
    "LightGBMCallback",
    "OptunaCallback",
    "StableBaselinesCallback",
    "XGBoostCallback",
    "log_dvc_metadata",
    "log_hf_dataset",
]
