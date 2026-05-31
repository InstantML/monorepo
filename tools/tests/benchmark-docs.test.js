import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function cellsForRow(source, firstCell) {
  const needle = `| ${firstCell} |`;
  const line = source.split("\n").find((candidate) => candidate.startsWith(needle));
  assert.ok(line, `missing table row for ${firstCell}`);
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

function p95FromResultRow(source, firstCell, p95Index) {
  const cells = cellsForRow(source, firstCell);
  const match = cells[p95Index].match(/^(\d+) ms$/);
  assert.ok(match, `missing p95 milliseconds for ${firstCell}`);
  return `${Number(match[1]).toLocaleString("en-US")} ms`;
}

test("public benchmark docs match the committed May 23 hosted result", () => {
  const docs = read("apps/docs/benchmarks.mdx");
  const result = read("benchmarks/2026-05-23-gcp-clickhouse-cloud-run-results.md");

  const cases = [
    ["Project newest 100", "`normal_runs_50k_newest_100`"],
    ["Project metric-best sort", "`normal_runs_50k_sort_metric_best`"],
    ["Project overview", "`normal_runs_50k_overview`"],
    ["Single-run chart", "`chart_eval_return`"],
    ["Org overview", "`org_overview`"],
  ];

  for (const [docsLabel, resultCase] of cases) {
    const docsP95 = cellsForRow(docs, docsLabel)[2];
    assert.equal(docsP95, p95FromResultRow(result, resultCase, 4), docsLabel);
  }

  assert.match(docs, /50,000-run showcase project/);
  assert.match(docs, /522,000,000 metric points/);
  assert.match(result, /Observed project runs: `50000`/);
  assert.match(result, /Observed project metric points: `522000000`/);
  assert.match(docs, /committed May 23 result used the Python `benchmark-instantml --direct`/);
  assert.doesNotMatch(docs, /instantml-data-us-central1-a-[a-z0-9-]+\.a\.run\.app/);
  assert.doesNotMatch(read("benchmarks/README.md"), /instantml-data-us-central1-a-[a-z0-9-]+\.a\.run\.app/);
});

test("public W&B comparison docs match the historical May 18 summary", () => {
  const docs = read("apps/docs/benchmarks.mdx");
  const results = read("benchmarks/RESULTS.md");

  const cases = [
    ["Newest 100 runs", "`org_newest_100_default_page`", "`wandb_newest_100_default_page`"],
    ["Search `seed-13`", "`org_search_seed_13`", "`wandb_search_seed_13`"],
    ["Metric-best sort", "`org_sort_metric_best`", "`wandb_sort_metric_best_exact_key`"],
    ["Sampled chart read", "`chart_eval_return`", "`wandb_chart_eval_return_history`"],
    ["Exact history scan", "`chart_eval_return`", "`wandb_chart_eval_return_scan_history`"],
  ];

  for (const [docsLabel, instantMlCase, wandbCase] of cases) {
    const docsCells = cellsForRow(docs, docsLabel);
    assert.equal(docsCells[1], p95FromResultRow(results, instantMlCase, 3), `${docsLabel} InstantML`);
    assert.equal(docsCells[2], p95FromResultRow(results, wandbCase, 3), `${docsLabel} W&B`);
  }

  assert.match(docs, /visible W&B comparison\s+dataset was 4,321 runs/);
  assert.match(results, /W&B was measured against `4,321` visible seeded runs/);
  assert.match(docs, /--no-include-length/);
  assert.match(docs, /--no-hydrate-runs/);
});
