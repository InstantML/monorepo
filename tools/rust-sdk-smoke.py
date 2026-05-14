import os
import sys

sys.path.insert(0, "packages/python-sdk")

import rl_observability as ro  # noqa: E402
from rl_observability.client import Client  # noqa: E402


base_url = os.environ["RLOBS_RUST_SMOKE_BASE_URL"]

run = ro.init(
    project="rust-sdk-smoke",
    name="sdk-overlap",
    config={"seed": 1},
    tags=["rust"],
    metadata={"source": "rust-sdk-smoke"},
    base_url=base_url,
    source_tracking=False,
)
run.log_metrics({"reward": 3.5}, step=1)
run.finish()

client = Client(base_url=base_url)
fetched = client._request("GET", f"/runs/{run.run_id}")["run"]
metrics = client._request("GET", f"/runs/{run.run_id}/metrics?key=reward&limit=10")["metrics"]

assert fetched["status"] == "finished"
assert fetched["project"] == "rust-sdk-smoke"
assert metrics == [{"created_at": metrics[0]["created_at"], "key": "reward", "step": 1.0, "value": 3.5}]
print(f"Rust SDK smoke passed against {base_url}")
