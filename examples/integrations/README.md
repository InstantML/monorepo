# Integrations Example

This directory shows how to wire InstantML into common framework callbacks
without adding those frameworks to the core SDK dependency set.

## Setup

From the repository root:

```bash
python3 -m pip install -e packages/python-sdk
```

Install only the framework extra you need in real training code:

```bash
python3 -m pip install "instantml[optuna]"
python3 -m pip install "instantml[xgboost]"
python3 -m pip install "instantml[lightgbm]"
python3 -m pip install "instantml[catboost]"
python3 -m pip install "instantml[rl]"
python3 -m pip install "instantml[datasets]"
```

## Dependency-Free Smoke

`smoke.py` sends representative Optuna, tree-boosting, RL, and dataset
metadata events through the public SDK using fake framework event objects. It
does not install Optuna, XGBoost, LightGBM, CatBoost, Stable Baselines, Datasets,
or DVC.

```bash
PYTHONPATH=packages/python-sdk \
  python3 examples/integrations/smoke.py \
  --server http://127.0.0.1:8000 \
  --project integrations-smoke
```

Set `INSTANTML_API_KEY` or pass `--api-key` when the target server requires API
keys.

## Real Framework Shapes

```python
from instantml.integrations.optuna import InstantMLCallback as OptunaCallback

study.optimize(objective, callbacks=[OptunaCallback(run=run)])
```

```python
from instantml.integrations.xgboost import InstantMLCallback as XGBoostCallback

xgb.train(params, dtrain, evals=[(valid, "valid")], callbacks=[XGBoostCallback(run=run, params=params)])
```

```python
from instantml.integrations.lightgbm import InstantMLCallback as LightGBMCallback

lgb.train(params, train_set, valid_sets=[valid_set], callbacks=[LightGBMCallback(run=run)])
```

```python
from instantml.integrations.catboost import InstantMLCallback as CatBoostCallback

model.fit(train_pool, eval_set=valid_pool, callbacks=[CatBoostCallback(run=run, config=params)])
```

```python
from instantml.integrations.stable_baselines import InstantMLCallback as SB3Callback

model.learn(total_timesteps=100_000, callback=SB3Callback(run=run))
```

```python
from instantml.integrations.datasets import log_hf_dataset, log_dvc_metadata

log_hf_dataset(run, train_dataset, key="data/train", include_preview=True)
log_dvc_metadata(run, repo_path=".")
```

Adapters passed an explicit `run=` do not finish it unless `finish_run=True` is
set. Adapters that create their own run finish only through their documented
training-end hook or explicit `finish()`/`close()`.

## Testing

Focused SDK tests:

```bash
python3 -m pytest packages/python-sdk/tests/test_integrations.py -q --no-cov
```
