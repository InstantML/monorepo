import os
import sys

sdk_path = os.path.abspath("packages/python-sdk")
sys.path.insert(0, sdk_path)
os.environ["PYTHONPATH"] = sdk_path + os.pathsep + os.environ.get("PYTHONPATH", "")

import instantml as im  # noqa: E402
from instantml.client import Client  # noqa: E402


base_url = os.environ["INSTANTML_RUST_SMOKE_BASE_URL"]

run = im.init(
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
with run.trace("decorator-rollout", kind="rollout", step=2, attributes={"scenario": "rl-smoke"}, capture="preview"):

    @run.trace_op(
        name="reward.score",
        kind="reward",
        step=2,
        attributes={"component": "reward", "api_key": "instantml_SHOULD_NOT_LEAK"},
        metrics={"reward": 0.75, "gen_ai.usage.input_tokens": 5},
        capture="preview",
    )
    def reward_score(observation, action, authorization="Bearer abcdefghijklmnop"):
        return {"reward": 0.75, "secret": "sk-abcdefghijklmnopqrstuvwxyz"}

    assert reward_score({"state": [0, 1]}, 1, authorization="Bearer abcdefghijklmnop") == {
        "reward": 0.75,
        "secret": "sk-abcdefghijklmnopqrstuvwxyz",
    }
run.finish()

client = Client(base_url=base_url)
fetched = client._request("GET", f"/runs/{run.run_id}")["run"]
metrics = client._request("GET", f"/runs/{run.run_id}/metrics?key=reward&limit=10")["metrics"]
stdout = client._request("GET", f"/api/runs/{run.run_id}/logs?stream=stdout&limit=10")["lines"]
stderr = client._request("GET", f"/api/runs/{run.run_id}/logs?stream=stderr&limit=10")["lines"]
traces = client._request("GET", f"/api/traces?run_id={run.run_id}&limit=20")["traces"]

assert fetched["status"] == "finished"
assert fetched["project"] == "rust-sdk-smoke"
assert metrics == [{"created_at": metrics[0]["created_at"], "key": "reward", "step": 1.0, "value": 3.5}]
assert [line["line_number"] for line in stdout] == [1, 2]
assert [line["message"] for line in stdout] == ["Epoch 1 loss=0.5", "checkpoint saved"]
assert [(line["line_number"], line["message"]) for line in stderr] == [(1, "warning: clipped gradient")]
trace = next(item for item in traces if item["root_name"] == "decorator-rollout")
assert trace["status"] == "ok"
assert trace["reward_count"] == 1
detail = client._request("GET", f"/api/runs/{run.run_id}/traces/{trace['trace_id']}?span_limit=20")
root = next(span for span in detail["spans"] if span["name"] == "decorator-rollout")
children = client._request(
    "GET",
    f"/api/runs/{run.run_id}/traces/{trace['trace_id']}/spans?parent_span_id={root['span_id']}&limit=20",
)
reward = next(span for span in children["spans"] if span["name"] == "reward.score")
assert reward["parent_span_id"] == root["span_id"]
assert reward["kind"] == "reward"
assert reward["metrics"]["gen_ai.usage.input_tokens"] == 5
assert reward["attributes"]["api_key"] == "[REDACTED]"
assert "Bearer abcdefghijklmnop" not in reward["input_preview"]
assert "sk-abcdefghijklmnopqrstuvwxyz" not in reward["output_preview"]
assert "[REDACTED]" in reward["input_preview"]
assert "[REDACTED]" in reward["output_preview"]
print(f"Rust SDK smoke passed against {base_url}")
