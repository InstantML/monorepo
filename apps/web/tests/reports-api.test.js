import assert from "node:assert/strict";
import test from "node:test";

import {
  createReport,
  deleteReport,
  fetchReport,
  listReports,
  patchReport,
  refreshReportBlock,
  reportFromPayload,
  reportSummariesFromPayload,
  reportMarkdownUrl,
  rotateReportShareToken,
} from "../src/reports-api.js";

/**
 * Tiny in-memory ApiClient double. Lets us assert the request shapes the
 * dashboard's reports surface sends without spinning up a real server.
 */
function fakeApi(routes) {
  const calls = [];
  const handle = (method, path, body) => {
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      throw new Error(`No fake route registered for ${method} ${path}`);
    }
    return typeof handler === "function" ? handler(body) : handler;
  };
  return {
    calls,
    get: (path) => Promise.resolve(handle("GET", path, undefined)),
    post: (path, body) => Promise.resolve(handle("POST", path, body)),
    patch: (path, body) => Promise.resolve(handle("PATCH", path, body)),
    request: (path, options = {}) =>
      Promise.resolve(handle(options.method ?? "GET", path, undefined)),
  };
}

test("listReports normalizes envelope payload", async () => {
  const api = fakeApi({
    "GET /api/reports": {
      reports: [
        { id: "r-1", title: "Demo", block_count: 3 },
        { id: "r-2", title: "Ablation", block_count: 6 },
        { bogus: true }, // should be filtered out
      ],
      limit: 50,
      offset: 0,
      total: 2,
    },
  });
  const result = await listReports(api);
  assert.equal(result.reports.length, 2);
  assert.equal(result.reports[0].title, "Demo");
  assert.equal(result.total, 2);
});

test("createReport posts CreateReportRequest body and returns parsed report", async () => {
  const sampleRow = {
    id: "00000000-0000-0000-0000-000000000001",
    org_id: "00000000-0000-0000-0000-000000000099",
    project_id: null,
    title: "New",
    description: null,
    blocks: [],
    created_at: "2026-05-26T00:00:00Z",
    updated_at: "2026-05-26T00:00:00Z",
    visibility: "private",
    schema_version: 1,
  };
  const api = fakeApi({
    "POST /api/reports": { report: sampleRow },
  });
  const result = await createReport(api, { title: "New", template: "ablation" });
  assert.equal(api.calls[0].body.title, "New");
  assert.equal(api.calls[0].body.template, "ablation");
  assert.equal(result?.id, sampleRow.id);
});

test("fetchReport appends share token as query parameter", async () => {
  const sample = {
    id: "00000000-0000-0000-0000-000000000010",
    title: "Public",
    blocks: [],
  };
  const api = fakeApi({
    "GET /api/reports/00000000-0000-0000-0000-000000000010?share=tok123": {
      report: sample,
    },
  });
  const result = await fetchReport(api, sample.id, { shareToken: "tok123" });
  assert.equal(result?.title, "Public");
});

test("patchReport sends PATCH and returns updated row", async () => {
  const sample = {
    id: "00000000-0000-0000-0000-000000000010",
    title: "Renamed",
    blocks: [],
  };
  const api = fakeApi({
    "PATCH /api/reports/00000000-0000-0000-0000-000000000010": { report: sample },
  });
  const result = await patchReport(api, sample.id, { title: "Renamed" });
  assert.equal(api.calls[0].body.title, "Renamed");
  assert.equal(result?.title, "Renamed");
});

test("deleteReport sends DELETE method", async () => {
  const sample = {
    id: "00000000-0000-0000-0000-000000000010",
    title: "x",
    blocks: [],
  };
  const api = fakeApi({
    "DELETE /api/reports/00000000-0000-0000-0000-000000000010": { report: sample },
  });
  const result = await deleteReport(api, sample.id);
  assert.equal(api.calls[0].method, "DELETE");
  assert.ok(result);
});

test("rotateReportShareToken posts to the share endpoint", async () => {
  const sample = {
    id: "00000000-0000-0000-0000-000000000010",
    title: "x",
    share_token: "instantml_share_abc",
    blocks: [],
  };
  const api = fakeApi({
    "POST /api/reports/00000000-0000-0000-0000-000000000010/share": {
      report: sample,
    },
  });
  const result = await rotateReportShareToken(api, sample.id);
  assert.equal(result?.share_token, "instantml_share_abc");
});

test("refreshReportBlock hits the per-block refresh endpoint", async () => {
  const sample = {
    id: "00000000-0000-0000-0000-000000000010",
    title: "x",
    blocks: [{ kind: "llm_summary", angle: "what-worked", generated_text: "ok" }],
  };
  const api = fakeApi({
    "POST /api/reports/00000000-0000-0000-0000-000000000010/blocks/3/refresh": {
      report: sample,
    },
  });
  const result = await refreshReportBlock(api, sample.id, 3);
  assert.equal(result?.blocks[0].kind, "llm_summary");
});

test("reportSummariesFromPayload tolerates legacy / empty shapes", () => {
  assert.deepEqual(reportSummariesFromPayload(null), []);
  assert.deepEqual(reportSummariesFromPayload({ reports: undefined }), []);
  assert.equal(
    reportSummariesFromPayload({
      reports: [
        { id: "r-1", title: "OK", block_count: 1 },
        { id: 42, title: "bad-id" },
      ],
    }).length,
    1,
  );
});

test("reportFromPayload returns null when blocks array is missing", () => {
  assert.equal(reportFromPayload(null), null);
  assert.equal(reportFromPayload({ report: { id: "r-1", title: "x" } }), null);
  const row = reportFromPayload({
    report: { id: "r-1", title: "x", blocks: [] },
  });
  assert.equal(row?.id, "r-1");
});

test("reportMarkdownUrl includes share token query parameter", () => {
  assert.equal(reportMarkdownUrl("r-1"), "/api/reports/r-1/markdown");
  assert.equal(
    reportMarkdownUrl("r-1", { shareToken: "abc" }),
    "/api/reports/r-1/markdown?share=abc",
  );
});
