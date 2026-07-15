import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const webpack = require("next/dist/compiled/webpack/webpack").webpack;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-chart-browser-"));

function compileFixture() {
  return new Promise((resolve, reject) => {
    webpack({
      context: repoRoot,
      entry: path.join(repoRoot, "benchmarks/chart_browser_fixture.tsx"),
      mode: "production",
      module: {
        rules: [{
          test: /\.[jt]sx?$/,
          exclude: /node_modules/,
          use: [{ loader: path.join(repoRoot, "benchmarks/typescript-transpile-loader.cjs") }],
        }],
      },
      optimization: { minimize: false },
      output: { filename: "fixture.js", path: outputDir },
      resolve: { extensions: [".tsx", ".ts", ".jsx", ".js", ".json"] },
      target: "web",
    }, (error, stats) => {
      if (error) return reject(error);
      if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve();
    });
  });
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

await compileFixture();

const css = [
  "apps/web/app/styles/tokens.css",
  "apps/web/app/styles/base.css",
  "apps/web/app/styles/charts.css",
].map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8")).join("\n");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}
#root{width:920px;padding:12px}.fixture-shell{width:900px}.chart-area{min-width:0}
</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const bundle = fs.readFileSync(path.join(outputDir, "fixture.js"));
const server = http.createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    response.end(bundle);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const navigationStartedAt = performance.now();
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  const navigationMs = performance.now() - navigationStartedAt;
  await page.waitForFunction(() => window.__INSTANTML_CHART_FIXTURE__?.ready === true, null, { timeout: 30_000 });
  const fixture = await page.evaluate(() => window.__INSTANTML_CHART_FIXTURE__);
  const canvasCount = await page.locator("canvas.metric-chart-canvas").count();
  const svgSeriesCount = await page.locator("svg.metric-chart .series").count();
  const chart = page.locator("svg.metric-chart");
  const box = await chart.boundingBox();
  if (!box) throw new Error("Chart fixture did not produce a measurable SVG");

  const hoverLatencies = [];
  for (const fraction of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    await page.mouse.move(box.x - 20, box.y - 20);
    await page.waitForFunction(() => !document.querySelector(".chart-tooltip"));
    const startedAt = performance.now();
    await page.mouse.move(box.x + box.width * fraction, box.y + box.height * 0.5);
    await page.waitForFunction(() => Boolean(document.querySelector(".chart-tooltip")));
    hoverLatencies.push(performance.now() - startedAt);
  }
  await page.mouse.move(box.x - 20, box.y - 20);
  await page.waitForFunction(() => !document.querySelector(".chart-tooltip"));

  await page.evaluate(() => { window.__INSTANTML_CHART_FIXTURE__.longTasks = []; });
  const range = page.locator('svg[aria-label^="Drag to zoom"]');
  const rangeBox = await range.boundingBox();
  if (!rangeBox) throw new Error("Range fixture did not render");
  await page.mouse.move(rangeBox.x + rangeBox.width * 0.25, rangeBox.y + rangeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rangeBox.x + rangeBox.width * 0.75, rangeBox.y + rangeBox.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Reset zoom" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await page.getByRole("button", { name: "Reset zoom" }).waitFor({ state: "detached" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const zoomLongTasks = await page.evaluate(() => window.__INSTANTML_CHART_FIXTURE__.longTasks);

  await page.locator('summary[aria-label="train/loss chart options"]').click();
  const summaryStartedAt = performance.now();
  await page.getByRole("button", { name: "Summary table" }).click();
  await page.locator(".chart-summary-table").waitFor({ state: "visible", timeout: 30_000 });
  const summarySwitchMs = performance.now() - summaryStartedAt;
  const summaryRows = await page.locator(".chart-summary-table tbody tr").count();

  const result = {
    generatedAt: new Date().toISOString(),
    browser: await browser.version(),
    platform: `${process.platform}-${process.arch} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    navigationMs,
    firstCommittedPaintMs: fixture.firstPaintMs,
    hoverP95Ms: percentile(hoverLatencies, 95),
    hoverLatenciesMs: hoverLatencies,
    canvasCount,
    svgSeriesCount,
    zoomLongTasks,
    summarySwitchMs,
    summaryRows,
    consoleErrors: errors,
  };
  console.log(JSON.stringify(result, null, 2));

  const failures = [];
  if (fixture.firstPaintMs >= 500) failures.push(`first committed paint ${fixture.firstPaintMs.toFixed(1)} ms >= 500 ms`);
  if (result.hoverP95Ms >= 100) failures.push(`hover p95 ${result.hoverP95Ms.toFixed(1)} ms >= 100 ms`);
  if (canvasCount !== 1) failures.push(`expected one dense canvas, found ${canvasCount}`);
  if (svgSeriesCount >= 50) failures.push(`expected fewer than 50 SVG series, found ${svgSeriesCount}`);
  if (zoomLongTasks.some((task) => task.duration > 50)) failures.push("zoom/reset produced a long task over 50 ms");
  if (summaryRows !== 2_000) failures.push(`summary rendered ${summaryRows} rows instead of 2000`);
  if (errors.length) failures.push(`${errors.length} console/page error(s)`);
  if (failures.length) {
    console.error(`Chart browser benchmark failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(outputDir, { recursive: true, force: true });
}
