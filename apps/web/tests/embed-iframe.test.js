import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");
const repo = path.resolve(webRoot, "../..");

function read(relPath) {
  return fs.readFileSync(path.join(webRoot, relPath), "utf8");
}

test("embed API rewrites preserve split control/data ownership before catch-all", async () => {
  const configUrl = pathToFileURL(path.join(webRoot, "next.config.mjs")).href;
  const config = (await import(`${configUrl}?case=${Date.now()}`)).default;
  const rewrites = await config.rewrites();
  const sources = rewrites.map((rewrite) => rewrite.source);
  const catchAllIndex = sources.indexOf("/api/:path*");
  for (const source of [
    "/api/embed/sessions",
    "/api/embed/sessions/:session_id/frame-policy",
    "/api/embed/sessions/:session_id/current",
    "/api/embed/sessions/:session_id/runs/data",
  ]) {
    const index = sources.indexOf(source);
    assert.ok(index >= 0, `${source} rewrite exists`);
    assert.ok(index < catchAllIndex, `${source} is matched before /api/:path*`);
  }
  const bySource = new Map(rewrites.map((rewrite) => [rewrite.source, rewrite.destination]));
  assert.match(bySource.get("/api/embed/sessions"), /\/api\/embed\/sessions$/);
  assert.match(bySource.get("/api/embed/sessions/:session_id/runs/data"), /\/api\/embed\/sessions\/:session_id\/runs\/data$/);
});

test("embed page headers are no-store and do not include legacy frame options", async () => {
  const configUrl = pathToFileURL(path.join(webRoot, "next.config.mjs")).href;
  const config = (await import(`${configUrl}?headers=${Date.now()}`)).default;
  const headers = await config.headers();
  const embedEntry = headers.find((entry) => entry.source === "/embed/:path*");
  assert.ok(embedEntry, "embed route header entry exists");
  const byKey = new Map(embedEntry.headers.map((header) => [header.key, header.value]));
  assert.equal(byKey.get("Cache-Control"), "private, no-store");
  assert.equal(byKey.get("Referrer-Policy"), "no-referrer");
  assert.equal(byKey.get("X-Content-Type-Options"), "nosniff");
  assert.equal(byKey.has("X-Frame-Options"), false);
  assert.equal(byKey.has("Content-Security-Policy"), false, "embed CSP is dynamic in proxy.ts");
});

test("embed route has proxy-owned frame policy and bypasses Clerk middleware", () => {
  const proxy = read("proxy.ts");
  assert.match(proxy, /isEmbedPath\(request\.nextUrl\.pathname\)/);
  assert.match(proxy, /x-instantml-embed-route/);
  assert.match(proxy, /activeAllowedParentOrigin/);
  assert.match(proxy, /frame-ancestors \$\{frameAncestors\}/);
  assert.match(proxy, /response\.headers\.delete\("X-Frame-Options"\)/);
  assert.match(proxy, /typeof framePolicy\?\.status === "string"/);
  assert.ok(proxy.indexOf("isEmbedPath(request.nextUrl.pathname)") < proxy.indexOf("clerkProxy(request, event)"));
});

test("root layout strips dashboard providers and storage-backed scripts from embeds", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /headers\(\)/);
  assert.match(layout, /x-instantml-embed-route/);
  assert.match(layout, /isEmbedRoute \? null/);
  assert.match(layout, /isEmbedRoute \? children : <ClerkProvider/);
});

test("embedded run canvas keeps the bearer token out of render state and browser credentials", () => {
  const canvas = read("app/embed/runs/[session_id]/embedded-runs-canvas.tsx");
  assert.match(canvas, /useRef\(""\)/);
  assert.match(canvas, /parseEmbedTokenLocation/);
  assert.match(canvas, /window\.history\.replaceState/);
  assert.match(canvas, /credentials:\s*"omit"/);
  assert.match(canvas, /zoomRangesByPanelId/);
  assert.match(canvas, /onZoomRangeChange=\{\(range\) =>/);
  assert.match(canvas, /zoomRange=\{zoomRangesByPanelId\[panel\.id\] \?\? null\}/);
  assert.match(canvas, /showExportActions=\{false\}/);
  assert.doesNotMatch(canvas, /localStorage|sessionStorage/);
  assert.doesNotMatch(canvas, /set[A-Za-z]*Token/);
});

test("embedded run canvas renders mixed read-only panel branches", () => {
  const canvas = read("app/embed/runs/[session_id]/embedded-runs-canvas.tsx");
  const sharedCharts = read("app/dashboard/runs/summary-panel-charts.tsx");
  const embedCss = read("app/styles/embed.css");
  assert.match(canvas, /embedPanelsFromViewData/);
  assert.match(canvas, /panel\.kind === "bar" \|\| panel\.kind === "dot" \|\| panel\.kind === "histogram" \|\| panel\.kind === "value_histogram"/);
  assert.match(canvas, /LatestMetricPanelChart/);
  assert.match(canvas, /ScatterPanelChart/);
  assert.match(canvas, /DistributionPanelChart/);
  assert.match(canvas, /This scatter panel is missing numeric X and Y fields/);
  assert.match(canvas, /This distribution panel is missing a numeric value field/);
  assert.match(canvas, /showExportActions=\{false\}/);
  assert.doesNotMatch(canvas, /showExportActions=\{true\}/);
  assert.match(sharedCharts, /onMouseEnter=\{\(\) => setHover/);
  assert.match(sharedCharts, /onFocus=\{\(\) => setHover/);
  assert.match(sharedCharts, /tabIndex=\{0\}/);
  assert.match(sharedCharts, /scatter-dot\$\{hover/);
  assert.match(sharedCharts, /summary-dot\$\{hover/);
  assert.match(embedCss, /height:\s*clamp\(220px, 38vh, 260px\)/);
  assert.match(embedCss, /chart-menu-pop[\s\S]*overflow-y:\s*auto/);
});

test("embed routes are redacted in frontend API logs", () => {
  const apiClient = read("src/api.js");
  assert.match(apiClient, /segments\[1\] === "embed" && segments\[2\] === "sessions"/);
  assert.match(apiClient, /\["api", "embed", "sessions", ":session_id", "runs", "data"\]/);
  assert.match(apiClient, /"embed\/sessions"/);
});

test("MetricChart separates export actions from chart controls for read-only embeds", () => {
  const chart = read("app/dashboard/metrics/metric-chart.tsx");
  assert.match(chart, /showChartOptions = showExportActions/);
  assert.match(chart, /showInlineControls = chartView === "chart" && showChartOptions/);
  assert.match(chart, /menuHasExport = chartView === "chart" && showExportActions/);
});
