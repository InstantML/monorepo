import os
import sys

sys.path.insert(0, "packages/python-sdk")

import instantml as ro  # noqa: E402
from instantml.client import Client  # noqa: E402


base_url = os.environ["INSTANTML_RUST_SMOKE_BASE_URL"]

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
run.log_stdout(["Epoch 1 loss=0.5", "checkpoint saved"], timestamp="2026-05-14T00:00:00Z")
run.log_stderr("warning: clipped gradient", timestamp="2026-05-14T00:00:01Z")
run.finish()

client = Client(base_url=base_url)
fetched = client._request("GET", f"/runs/{run.run_id}")["run"]
metrics = client._request("GET", f"/runs/{run.run_id}/metrics?key=reward&limit=10")["metrics"]
stdout = client._request("GET", f"/api/runs/{run.run_id}/logs?stream=stdout&limit=10")["lines"]
stderr = client._request("GET", f"/api/runs/{run.run_id}/logs?stream=stderr&limit=10")["lines"]

assert fetched["status"] == "finished"
assert fetched["project"] == "rust-sdk-smoke"
assert metrics == [{"created_at": metrics[0]["created_at"], "key": "reward", "step": 1.0, "value": 3.5}]
assert [line["line_number"] for line in stdout] == [1, 2]
assert [line["message"] for line in stdout] == ["Epoch 1 loss=0.5", "checkpoint saved"]
assert [(line["line_number"], line["message"]) for line in stderr] == [(1, "warning: clipped gradient")]
print(f"Rust SDK smoke passed against {base_url}")
