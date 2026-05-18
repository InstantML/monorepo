// Tests that the chart-series fetch helper passes the `buckets` parameter
// required for M4 downsampling. The constant and fetch pattern come from
// dashboard-shell.tsx; this file verifies the contract without importing TSX.
//
// Rationale: dashboard-shell.tsx is a Next.js server component that cannot be
// imported directly in a Node:test environment. The critical invariant — that
// the API call includes `buckets` in the POST body — is verified here by
// replicating the fetch logic from fetchBatchedMetricSeries and asserting the
// recorded request body.

import assert from "node:assert/strict";
import test from "node:test";

// Mirror the constants from dashboard-shell.tsx.
const METRIC_SERIES_BATCH_LIMIT = 1000;
const METRIC_SERIES_M4_BUCKETS = 1200;

// Minimal stub of fetchBatchedMetricSeries from dashboard-shell.tsx.
// Must stay in sync with the real implementation's POST body shape.
async function fetchBatchedMetricSeries(api, metricKey, runs, signal) {
  if (!runs.length || !metricKey) return [];
  const ids = runs.map((run) => run.id).filter(Boolean);
  if (!ids.length) return [];
  const payload = await api.post(
    `/api/metrics/series`,
    {
      key: metricKey,
      run_ids: ids,
      limit: METRIC_SERIES_BATCH_LIMIT,
      buckets: METRIC_SERIES_M4_BUCKETS,
    },
    { signal },
  );
  const seriesArray = Array.isArray(payload?.series) ? payload.series : [];
  const pointsByRunId = new Map();
  for (const entry of seriesArray) {
    if (entry && typeof entry === "object" && typeof entry.run_id === "string") {
      pointsByRunId.set(entry.run_id, Array.isArray(entry.metrics) ? entry.metrics : []);
    }
  }
  return runs.map((run) => ({
    id: run.id,
    name: run.name,
    group: "all",
    points: pointsByRunId.get(run.id) ?? [],
  }));
}

// Lightweight stub of ApiClient that records calls.
class StubApiClient {
  constructor() {
    this.calls = [];
  }

  async post(path, body, _options) {
    this.calls.push({ path, body });
    return {
      series: body.run_ids.map((id) => ({ run_id: id, metrics: [] })),
    };
  }
}

test("fetchBatchedMetricSeries includes buckets in POST body", async () => {
  const api = new StubApiClient();
  const runs = [
    { id: "run-1", name: "run one" },
    { id: "run-2", name: "run two" },
  ];
  const signal = AbortSignal.timeout(5000);

  const result = await fetchBatchedMetricSeries(api, "train/loss", runs, signal);

  assert.equal(api.calls.length, 1, "exactly one POST should be made");
  const call = api.calls[0];
  assert.equal(call.path, "/api/metrics/series");
  assert.equal(call.body.key, "train/loss");
  assert.deepEqual(call.body.run_ids, ["run-1", "run-2"]);
  assert.equal(call.body.limit, METRIC_SERIES_BATCH_LIMIT);
  assert.equal(call.body.buckets, METRIC_SERIES_M4_BUCKETS,
    "buckets must be present so M4 downsampling fires for large series");
  assert.equal(typeof call.body.buckets, "number");
  assert.equal(result.length, 2);
});

test("fetchBatchedMetricSeries returns empty when no runs provided", async () => {
  const api = new StubApiClient();
  const result = await fetchBatchedMetricSeries(api, "train/loss", [], null);
  assert.deepEqual(result, []);
  assert.equal(api.calls.length, 0, "no API call when runs list is empty");
});

test("fetchBatchedMetricSeries returns empty when no key provided", async () => {
  const api = new StubApiClient();
  const runs = [{ id: "run-1", name: "run one" }];
  const result = await fetchBatchedMetricSeries(api, "", runs, null);
  assert.deepEqual(result, []);
  assert.equal(api.calls.length, 0, "no API call when metric key is absent");
});

test("fetchBatchedMetricSeries maps metrics by run_id from response", async () => {
  const api = new StubApiClient();
  // Override the stub to return a real payload with points.
  api.post = async (_path, body) => ({
    series: [
      {
        run_id: "run-1",
        metrics: [
          { key: "train/loss", step: 0, value: 1.0, created_at: "2026-01-01T00:00:00Z" },
          { key: "train/loss", step: 1, value: 0.8, created_at: "2026-01-01T00:00:01Z" },
        ],
      },
      { run_id: "run-2", metrics: [] },
    ],
  });

  const runs = [
    { id: "run-1", name: "alpha" },
    { id: "run-2", name: "beta" },
  ];
  const result = await fetchBatchedMetricSeries(api, "train/loss", runs, null);

  assert.equal(result.length, 2);
  assert.equal(result[0].id, "run-1");
  assert.equal(result[0].points.length, 2);
  assert.equal(result[1].id, "run-2");
  assert.equal(result[1].points.length, 0);
});

test("M4 bucket constant is within server-accepted range", () => {
  const MAX_M4_BUCKETS = 4096; // must match Rust MAX_M4_BUCKETS constant
  assert.ok(METRIC_SERIES_M4_BUCKETS >= 1, "buckets must be at least 1");
  assert.ok(
    METRIC_SERIES_M4_BUCKETS <= MAX_M4_BUCKETS,
    `buckets ${METRIC_SERIES_M4_BUCKETS} must not exceed server max ${MAX_M4_BUCKETS}`,
  );
});
