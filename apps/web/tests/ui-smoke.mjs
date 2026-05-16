import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const repo = process.cwd();
const externalApiBaseUrl = process.env.INSTANTML_UI_SMOKE_API_BASE || "";
const backendMode = (process.env.INSTANTML_UI_SMOKE_BACKEND || "rust").toLowerCase();
const fullWorkspaceSmoke = process.env.INSTANTML_UI_SMOKE_FULL_WORKSPACE === "1";
if (!externalApiBaseUrl && backendMode !== "node") {
  const result = spawnSync("node", ["tools/rust-service-smoke.mjs", "ui"], {
    cwd: repo,
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-ui-"));
let apiServer = null;
if (!externalApiBaseUrl && backendMode === "node") {
  const { createServer } = await import("../../server/src/server.js");
  apiServer = createServer({ dbPath: path.join(dir, "ui.json") });
}
const commandKey = process.platform === "darwin" ? "Meta" : "Control";
let nextServer = null;
let browser = null;

try {
  if (apiServer) await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiBaseUrl = externalApiBaseUrl || `http://127.0.0.1:${apiServer.address().port}`;
  const paginationRunIds = [];
  const nextEnv = {
    ...process.env,
    INSTANTML_API_BASE: apiBaseUrl,
    INSTANTML_CONTROL_API_BASE: apiBaseUrl,
    INSTANTML_DATA_API_BASE: apiBaseUrl,
    INSTANTML_API_ALLOWED_ORIGINS: apiBaseUrl,
  };

  const webPort = await freePort();
  const nextBin = path.join(repo, "node_modules/.bin/next");
  const build = spawnSync(nextBin, ["build"], {
    cwd: path.join(repo, "apps/web"),
    env: nextEnv,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  nextServer = spawn(nextBin, ["start", "--port", String(webPort)], {
    cwd: path.join(repo, "apps/web"),
    env: nextEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHttp(`http://127.0.0.1:${webPort}`);
  await assertStaticAssetsOk(`http://127.0.0.1:${webPort}`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const summaryUrls = [];
  const objectUrls = [];
  const logUrls = [];
  const objectNotFoundUrls = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/runs/summary")) summaryUrls.push(request.url());
    if (request.url().includes("/objects")) objectUrls.push(request.url());
    if (request.url().includes("/logs")) logUrls.push(request.url());
  });
  page.on("response", (response) => {
    if (response.url().includes("/objects") && response.status() === 404) objectNotFoundUrls.push(response.url());
  });

  const webBaseUrl = `http://127.0.0.1:${webPort}`;
  await page.goto(webBaseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".landing-page", { timeout: 10000 });
  assert.equal(summaryUrls.length, 0, "public landing page should not fetch run summaries");

  await page.goto(`${webBaseUrl}/signup`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill("ui-smoke@example.com");
  await page.getByLabel("Name").fill("UI Smoke");
  await page.getByLabel("Business").check();
  await page.getByLabel("Organization").fill(`UI Smoke ${Date.now()}`);
  await page.getByRole("radio", { name: /Pro/ }).check();
  await page.getByLabel("Reserved seats").fill("teammate@example.com");
  await page.getByRole("button", { name: /Continue with Dev Google/ }).click();
  await page.waitForURL(/\/onboarding$/, { timeout: 10000 });
  await page.getByRole("button", { name: /Create SDK API key/ }).click();
  await page.waitForSelector(".api-key-reveal code", { timeout: 10000 });
  assert.match(await page.locator(".api-key-reveal code").innerText(), /^instantml_/);

  await pageApiRequest(page, "POST", "/api/demo/reset", {}, { retries: 2 });
  if (backendMode !== "node") {
    const seedRuns = await pageApiGet(page, "/api/runs/summary?project=demo&q=seed-44&limit=1");
    const seedRunId = seedRuns.runs?.[0]?.id;
    assert.ok(seedRunId, "seed-44 demo run should exist for rich-object smoke coverage");
    const imageArtifact = (await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/artifacts/upload`, {
      type: "file",
      name: "qa-preview.png",
      content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      step: 2,
      mime_type: "image/png",
      metadata: { kind: "image", caption: "qa preview" },
    })).artifact;
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/objects`, {
      key: "media/qa-image",
      kind: "image",
      step: 2,
      artifact_id: imageArtifact.id,
      metadata: { caption: "qa preview" },
      summary: {},
    });
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/objects`, {
      key: "eval/samples",
      kind: "table",
      step: 2,
      metadata: { source: "ui-smoke" },
      summary: { columns: ["prompt", "prediction", "score"] },
      rows: [
        { prompt: "alpha", prediction: "accept", score: 0.9 },
        { prompt: "beta", prediction: "revise", score: 0.7 },
      ],
    });
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/objects`, {
      key: "eval/score_distribution",
      kind: "histogram",
      step: 2,
      metadata: { source: "ui-smoke" },
      summary: {},
      value: { bins: [0, 0.5, 1], counts: [2, 5] },
    });
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/logs`, {
      stream: "stdout",
      lines: [
        { line_number: 1, message: "Epoch 1 loss=0.42", timestamp: "2026-05-14T00:00:00Z" },
        { line_number: 2, message: "\u001b[32mcheckpoint saved\u001b[0m", timestamp: "2026-05-14T00:00:01Z" },
      ],
    });
  }
  for (let index = 1; index <= 30; index += 1) {
    const run = (await pageApiRequest(page, "POST", "/runs", { project: "pagination", name: `page-run-${String(index).padStart(2, "0")}`, config: { seed: index } })).run;
    paginationRunIds.push(run.id);
    await pageApiRequest(page, "POST", `/runs/${run.id}/metrics`, { step: 0, metrics: { "eval/return_mean": index, "train/reward": index * 2, "train/loss": 1 / index } });
  }
  summaryUrls.length = 0;
  objectUrls.length = 0;
  logUrls.length = 0;
  objectNotFoundUrls.length = 0;

  let delayedInitialSummary = true;
  await page.route("**/api/runs/summary**", async (route) => {
    if (delayedInitialSummary) {
      delayedInitialSummary = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });
  await page.goto(`${webBaseUrl}/dashboard/runs`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-loading-screen", { timeout: 5000 });
  await page.waitForSelector(".workspace-run-row", { timeout: 15000 });
  await page.unroute("**/api/runs/summary**");
  assert.equal(objectUrls.length, 0, "initial dashboard entry should not fetch rich objects");
  assert.equal(logUrls.length, 0, "initial dashboard entry should not fetch console logs");
  await page.getByRole("link", { name: /^Settings$/ }).click();
  await page.waitForSelector("text=Plan Usage", { timeout: 10000 });
  await page.waitForSelector("text=teammate@example.com", { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active").innerText(), /Pro/);
  assert.match(await page.locator(".tab-pane.active").innerText(), /teammate@example\.com/);
  await page.getByLabel("Invite email").fill("second@example.com");
  await page.getByRole("button", { name: /^Invite$/ }).click();
  await page.waitForSelector("text=second@example.com", { timeout: 10000 });
  await page.getByRole("link", { name: /^API$/ }).click();
  await page.waitForSelector("text=API Keys", { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active").innerText(), /Onboarding SDK key/);
  await page.getByLabel("API key name").fill("UI smoke dashboard key");
  await page.getByRole("button", { name: /^Create$/ }).click();
  await page.waitForSelector(".tab-pane.active .api-key-reveal code", { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active .api-key-reveal code").innerText(), /^instantml_/);
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 15000 });
  let screenshotPath = path.join(dir, "ui-smoke-core.png");

  if (!fullWorkspaceSmoke) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } else {

  await page.hover(".tabs");
  await page.waitForFunction(() => (document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0) > 120);
  await page.getByRole("link", { name: /^Metrics$/ }).click();
  await page.mouse.move(520, 140);
  await page.waitForFunction(() => (document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0) < 80);
  const collapsedNav = await page.evaluate(() => {
    const tabs = document.querySelector(".tabs");
    return {
      focusWithin: tabs?.matches(":focus-within") ?? false,
      width: tabs?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.equal(collapsedNav.focusWithin, false);
  assert.ok(collapsedNav.width < 80, `sidebar should collapse after mouse tab select, got ${collapsedNav.width}`);

  await page.evaluate(() => {
    document.querySelector("#sticky-test-spacer")?.remove();
    const spacer = document.createElement("div");
    spacer.id = "sticky-test-spacer";
    spacer.style.height = "1400px";
    document.querySelector(".tab-pane.active")?.appendChild(spacer);
    window.scrollTo(0, 700);
  });
  await page.waitForFunction(() => window.scrollY > 500);
  const stickyNav = await page.evaluate(() => {
    const tabs = document.querySelector(".tabs");
    const topbarHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-height"));
    return {
      navTop: tabs?.getBoundingClientRect().top ?? 0,
      position: tabs ? getComputedStyle(tabs).position : "",
      topbarHeight,
    };
  });
  assert.equal(stickyNav.position, "sticky");
  assert.ok(Math.abs(stickyNav.navTop - stickyNav.topbarHeight) <= 2, `sidebar should stay pinned below topbar, got ${stickyNav.navTop}`);
  await page.evaluate(() => {
    document.querySelector("#sticky-test-spacer")?.remove();
    window.scrollTo(0, 0);
  });
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 15000 });

  await page.evaluate(() => {
    document.querySelector("#workspace-sticky-test-spacer")?.remove();
    const spacer = document.createElement("div");
    spacer.id = "workspace-sticky-test-spacer";
    spacer.style.height = "1400px";
    spacer.setAttribute("aria-hidden", "true");
    document.querySelector(".workspace-canvas")?.appendChild(spacer);
    window.scrollTo(0, 780);
  });
  await page.waitForFunction(() => window.scrollY > 500);
  const stickyRunRail = await page.evaluate(() => {
    const filter = document.querySelector(".runs-workspace-filter");
    const rail = document.querySelector(".workspace-run-rail");
    const toolbar = document.querySelector(".workspace-panel-toolbar");
    const footer = document.querySelector(".workspace-run-footer");
    const rowHeights = [...document.querySelectorAll(".workspace-run-row")].map((row) => row.getBoundingClientRect().height);
    const topbarHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-height"));
    return {
      filterBottom: filter?.getBoundingClientRect().bottom ?? 0,
      filterPosition: filter ? getComputedStyle(filter).position : "",
      filterTop: filter?.getBoundingClientRect().top ?? 0,
      footerBottom: footer?.getBoundingClientRect().bottom ?? 0,
      maxRowHeight: Math.max(0, ...rowHeights),
      railTop: rail?.getBoundingClientRect().top ?? 0,
      position: rail ? getComputedStyle(rail).position : "",
      toolbarPosition: toolbar ? getComputedStyle(toolbar).position : "",
      toolbarTop: toolbar?.getBoundingClientRect().top ?? 0,
      topbarHeight,
      viewportHeight: window.innerHeight,
    };
  });
  assert.equal(stickyRunRail.filterPosition, "sticky");
  assert.ok(Math.abs(stickyRunRail.filterTop - stickyRunRail.topbarHeight) <= 2, `runs filter should stay pinned flush below topbar, got ${stickyRunRail.filterTop}`);
  assert.equal(stickyRunRail.position, "sticky");
  assert.equal(stickyRunRail.toolbarPosition, "sticky");
  assert.ok(stickyRunRail.railTop >= stickyRunRail.filterBottom - 12, `run rail should stay visually below pinned runs filter, got rail ${stickyRunRail.railTop} filter ${stickyRunRail.filterBottom}`);
  assert.ok(stickyRunRail.railTop <= stickyRunRail.filterBottom + 32, `run rail should not leave a large scroll-through gap below pinned filter, got rail ${stickyRunRail.railTop} filter ${stickyRunRail.filterBottom}`);
  assert.ok(stickyRunRail.toolbarTop >= stickyRunRail.filterBottom - 12, `panel toolbar should stay visually below pinned runs filter, got toolbar ${stickyRunRail.toolbarTop} filter ${stickyRunRail.filterBottom}`);
  assert.ok(stickyRunRail.toolbarTop <= stickyRunRail.filterBottom + 32, `panel toolbar should not leave a large scroll-through gap below pinned filter, got toolbar ${stickyRunRail.toolbarTop} filter ${stickyRunRail.filterBottom}`);
  assert.ok(Math.abs(stickyRunRail.toolbarTop - stickyRunRail.railTop) <= 8, `panel toolbar and run rail should pin on the same visual row, got toolbar ${stickyRunRail.toolbarTop} rail ${stickyRunRail.railTop}`);
  assert.ok(stickyRunRail.maxRowHeight <= 96, `run rows should stay readable and bounded, got ${stickyRunRail.maxRowHeight}`);
  assert.ok(stickyRunRail.footerBottom <= stickyRunRail.viewportHeight + 2, `run footer should stay visible, got ${stickyRunRail.footerBottom}`);
  assert.ok(await page.locator(".workspace-run-footer .select-trigger").boundingBox(), "rows dropdown trigger should be visible");
  await page.evaluate(() => {
    document.querySelector("#workspace-sticky-test-spacer")?.remove();
    window.scrollTo(0, 0);
  });

  await chooseSelect(page, "#workspace-rows-per-page", "10");
  await page.waitForFunction(() => /1-10 of \d+/.test(document.querySelector(".workspace-run-footer")?.textContent ?? ""));
  const summaryRequestsBeforeNext = summaryUrls.length;
  await page.getByRole("button", { name: "Next page" }).click();
  await page.waitForFunction(() => /11-20 of \d+/.test(document.querySelector(".workspace-run-footer")?.textContent ?? ""));
  if (backendMode !== "node") {
    assert.ok(
      summaryUrls.slice(summaryRequestsBeforeNext).some((url) => new URL(url).searchParams.has("cursor")),
      "Rust-backed pagination should use cursor after the first page",
    );
    const summaryRequestsBeforeSearch = summaryUrls.length;
    await page.locator("#search").fill("page-run-01");
    await page.waitForFunction(() => /1-1 of 1/.test(document.querySelector(".workspace-run-footer")?.textContent ?? ""));
    const searchSummaryUrls = summaryUrls
      .slice(summaryRequestsBeforeSearch)
      .filter((url) => new URL(url).searchParams.get("q") === "page-run-01");
    assert.ok(searchSummaryUrls.length > 0, "search should issue a run-summary request");
    assert.ok(
      searchSummaryUrls.every((url) => !new URL(url).searchParams.has("cursor")),
      "filter changes should clear stale cursors before the next Rust request",
    );
    await page.locator("#search").fill("");
    await page.waitForFunction(() => /1-10 of \d+/.test(document.querySelector(".workspace-run-footer")?.textContent ?? ""));
    await page.getByRole("button", { name: "Next page" }).click();
    await page.waitForFunction(() => /11-20 of \d+/.test(document.querySelector(".workspace-run-footer")?.textContent ?? ""));
  }
  await page.getByRole("button", { name: "Previous page" }).click();
  await page.waitForFunction(() => /1-10 of \d+/.test(document.querySelector(".workspace-run-footer")?.textContent ?? ""));
  await page.evaluate((ids) => {
    localStorage.setItem("instantml:next:view:off-page-selection", JSON.stringify({
      project: "pagination",
      selectedRunIds: ids,
      primaryRunId: ids[0],
      referenceRunId: ids[1],
      pageSize: 10,
      viewName: "off-page-selection",
    }));
  }, [paginationRunIds[0], paginationRunIds[29]]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".workspace-run-row", { timeout: 15000 });
  await chooseSelect(page, "#saved-view-select", "instantml:next:view:off-page-selection");
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-open", { state: "visible", timeout: 10000 });
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("2 runs"));
  assert.match(await page.locator("#run-detail").innerText(), /2 runs/);
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });
  await page.waitForFunction(() => {
    const panelKeys = [...document.querySelectorAll(".workspace-panel-head small")]
      .map((node) => (node.textContent ?? "").split(" · ")[0])
      .filter(Boolean);
    return panelKeys.length === 3 && panelKeys.every((key) => ["eval/return_mean", "train/loss", "train/reward"].includes(key));
  });
  await page.waitForFunction(() => document.querySelector(".stat strong")?.textContent?.trim() === "30");
  await chooseSelect(page, "#project-filter", "demo");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("matching runs"));
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });

  await page.keyboard.press("Shift+/");
  await page.waitForSelector('[role="dialog"][aria-label="Keyboard shortcuts"]');
  assert.match(await page.locator(".command-card").innerText(), /Open quick search/);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Keyboard shortcuts"]'))), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]'));

  const firstWorkspaceRun = page.locator(".workspace-run-row").first();
  const quickSearchRunName = (await firstWorkspaceRun.locator(".workspace-run-open").getAttribute("title"))?.replace(/^Open\s+/, "")
    ?? await firstWorkspaceRun.locator(".workspace-run-body strong").innerText();
  await page.keyboard.press("Control+K");
  await page.waitForSelector("#quick-search-input");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Quick search"]'))), true);
  await page.focus("#quick-search-input");
  await page.fill("#quick-search-input", quickSearchRunName);
  await page.waitForFunction((runName) => document.querySelector(".quick-search-results")?.textContent?.includes(runName), quickSearchRunName);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (runName) => {
      const detailText = document.querySelector("#run-detail")?.textContent ?? "";
      return detailText.includes(runName) && detailText.includes("Metric Summary");
    },
    quickSearchRunName,
  );
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });

  await page.keyboard.press("Control+Period");
  await page.waitForFunction(() => document.querySelector(".runs-workspace")?.classList.contains("run-rail-collapsed"));
  await page.keyboard.press("Control+Period");
  await page.waitForFunction(() => !document.querySelector(".runs-workspace")?.classList.contains("run-rail-collapsed"));
  await page.keyboard.press("Control+J");
  await page.waitForFunction(() => Boolean(document.activeElement?.closest(".workspace-run-rail")));
  await page.keyboard.press("Control+J");
  await page.waitForFunction(() => document.activeElement?.id === "panel-search");

  const selectedBeforeRowClick = await page.locator(".workspace-run-row.selected").count();
  const unselectedRunRow = page.locator(".workspace-run-row:not(.selected)").first();
  const inspectedRunName = (await unselectedRunRow.locator(".workspace-run-open").getAttribute("title"))?.replace(/^Open\s+/, "");
  assert.ok(inspectedRunName, "unselected run row should expose its full run name");
  await unselectedRunRow.locator(".workspace-run-select").click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".workspace-run-row.selected").length === expected,
    selectedBeforeRowClick + 1,
  );
  await page.getByRole("button", { name: new RegExp(`^Open ${escapeRegExp(inspectedRunName)}$`) }).click();
  await page.waitForFunction(
    (runName) => {
      const detailText = document.querySelector("#run-detail")?.textContent ?? "";
      return detailText.includes(runName) && detailText.includes("Metric Summary");
    },
    inspectedRunName,
  );
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });
  await chooseSelect(page, "#project-filter", "demo");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("matching runs"));
  await page.fill("#search", "seed-44");
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("seed-44"));
  await page.waitForFunction(() => document.querySelector(".workspace-run-open")?.getAttribute("title")?.includes("seed-44"));
  assert.doesNotMatch(await page.locator(".workspace-run-list").innerText(), /No runs match/);
  const objectRequestsBeforeSeedDetail = objectUrls.length;
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-open", { state: "visible", timeout: 10000 });
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Metric Summary"));
  assert.equal(objectUrls.length, objectRequestsBeforeSeedDetail, "Run Detail summary should not fetch rich objects before Files is opened");
  if (backendMode !== "node") {
    const logsBeforeRunTab = logUrls.length;
    await page.getByRole("button", { name: "Logs" }).click();
    await page.waitForFunction(() => document.querySelector(".terminal-frame")?.textContent?.includes("loss=0.42"));
    assert.ok(logUrls.length > logsBeforeRunTab, "Logs run tab should fetch selected-run console logs only when opened");
    assert.match(await page.locator(".terminal-ts").first().innerText(), /\d{2}:\d{2}:\d{2}\.\d{3}/);
    await page.fill(".logs-search input", "checkpoint");
    await page.waitForFunction(() => document.querySelector(".terminal-frame")?.textContent?.includes("checkpoint saved"));
    await page.getByRole("button", { name: "Files" }).click();
    await page.waitForFunction(() => document.querySelector(".evidence-panel")?.textContent?.includes("eval/samples"));
    assert.ok(objectUrls.length > objectRequestsBeforeSeedDetail, "Files tab should fetch active-run rich objects when opened");
    assert.ok(await page.locator(".evidence-row.active").count() > 0, "Files tab should select a bounded evidence item");
    await page.fill(".evidence-search input", "eval/samples");
    await page.locator(".evidence-row", { hasText: "eval/samples" }).click();
    await page.waitForSelector(".rich-object-card.kind-table", { timeout: 10000 });
    const tablePreviewSize = await page.locator(".rich-object-card.kind-table .rich-table-preview").first().evaluate((node) => ({
      cells: node.querySelectorAll("span").length,
      headers: node.querySelectorAll("strong").length,
    }));
    assert.ok(tablePreviewSize.headers <= 8, `table preview should cap columns, got ${tablePreviewSize.headers}`);
    assert.ok(tablePreviewSize.cells <= 160, `table preview should cap cells, got ${tablePreviewSize.cells}`);
  } else {
    await page.getByRole("button", { name: "Files" }).click();
    await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("No evidence logged"));
  }
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
  await page.fill("#search", "reward stability");
  await page.waitForFunction(() => document.querySelector(".workspace-run-note")?.textContent?.includes("reward stability"));
  assert.match(await page.locator(".workspace-run-list").innerText(), /reward stability/i);
  await page.fill("#search", "");
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });

  await page.locator(".runs-commandbar").getByRole("button", { name: "Columns" }).click();
  await page.waitForSelector("#columns-popover");
  await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").uncheck();
  assert.equal(await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").isChecked(), false);
  await page.fill("#column-metric-filter", "train/.*");
  await page.locator("#columns-popover").getByRole("checkbox", { name: "loss", exact: true }).check();
  assert.equal(await page.locator("#columns-popover").getByRole("checkbox", { name: "loss", exact: true }).isChecked(), true);
  await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").check();
  assert.equal(await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").isChecked(), true);

  await page.fill("#search", "no-such-training-run");
  await page.waitForSelector(".workspace-run-list .compact-empty");
  assert.match(await page.locator(".workspace-run-list .compact-empty").innerText(), /No runs match/);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await chooseSelect(page, "#project-filter", "demo");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("matching runs"));
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });

  const automaticPanelCount = await page.locator(".workspace-panel-card").count();
  assert.ok(automaticPanelCount >= 3, `expected automatic metric panels, got ${automaticPanelCount}`);
  await page.fill("#panel-search", "loss");
  await page.waitForFunction(() => {
    const panels = [...document.querySelectorAll(".workspace-panel-card h3")];
    return panels.length > 0 && panels.every((node) => /loss/i.test(node.textContent ?? ""));
  });
  await page.fill("#panel-search", "");
  await chooseSelect(page, "#workspace-mode", "manual");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-panel-card").length === 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).click();
  await page.waitForSelector(".panel-drawer");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".panel-drawer"));
  await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).click();
  await page.waitForSelector(".panel-drawer");
  await page.locator(".drawer-metric-row").first().click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector(".panel-drawer") && document.querySelector("#status-message")?.textContent?.includes("Undo"));
  await page.keyboard.press(`${commandKey}+Z`);
  await page.waitForFunction(() => document.querySelectorAll(".workspace-panel-card").length === 0);
  await page.keyboard.press(`${commandKey}+Shift+Z`);
  await page.waitForSelector(".workspace-panel-card", { timeout: 10000 });
  await page.locator(".workspace-panel-card").first().hover();
  const actionOpacity = await page.locator(".workspace-panel-card .panel-card-actions").first().evaluate((node) => getComputedStyle(node).opacity);
  assert.ok(Number(actionOpacity) > 0.5, `panel actions should stay visible enough to avoid invisible destructive targets, got ${actionOpacity}`);
  await page.locator('.workspace-panel-card button[aria-label^="Edit"]').first().click();
  await page.waitForSelector(".edit-drawer");
  const panelCountBeforeEditTab = await page.locator(".workspace-panel-card").count();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".edit-drawer").count(), 1);
  assert.equal(await page.locator(".workspace-panel-card").count(), panelCountBeforeEditTab);
  await page.fill('.edit-drawer label:has-text("Title") input', "Smoke panel");
  await page.waitForFunction(() => document.querySelector(".workspace-panel-card h3")?.textContent?.includes("Smoke panel"));
  await page.locator(".edit-drawer").getByRole("button", { name: "Close edit panel" }).click();
  await page.locator(".workspace-section .section-title-button").first().click();
  await page.waitForFunction(() => document.querySelector(".workspace-section")?.classList.contains("collapsed"));
  await page.locator(".workspace-section .section-title-button").first().click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 10000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Reset layout" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".workspace-panel-card").length >= 3);
  assert.equal(await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).count(), 1);
  assert.equal(await page.locator(".workspace-section-head").getByRole("button", { name: /Add panels/ }).count(), 0);

  if (await page.locator(".workspace-section").count() < 2) {
    await page.getByRole("button", { name: "Add section" }).click();
  }
  const movedPanelTitle = await page.locator(".workspace-panel-card .panel-title-text").first().innerText();
  await page.evaluate(() => {
    const source = document.querySelector(".workspace-panel-card .panel-drag-handle");
    const targetGrid = document.querySelectorAll(".workspace-section")[1]?.querySelector(".workspace-panel-grid");
    if (!source || !targetGrid) throw new Error("Missing panel drag source or target grid");
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    targetGrid.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    targetGrid.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await page.waitForFunction((title) => {
    const targetSection = document.querySelectorAll(".workspace-section")[1];
    return targetSection?.textContent?.includes(title);
  }, movedPanelTitle, { timeout: 10000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });
  await chooseSelect(page, "#project-filter", "demo");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("matching runs"));
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });
  await page.waitForFunction((title) => {
    const targetSection = document.querySelectorAll(".workspace-section")[1];
    return targetSection?.textContent?.includes(title);
  }, movedPanelTitle);
  await page.getByRole("button", { name: "Reset layout" }).click();
  await page.waitForFunction(() => document.querySelector("#workspace-mode")?.value === "automatic" && document.querySelectorAll(".workspace-panel-card").length >= 3);
  await page.evaluate(() => window.scrollTo(0, 0));

  const firstWorkspacePanel = page.locator(".workspace-panel-card").first();
  const startingLayout = await firstWorkspacePanel.evaluate((node) => ({
    h: Number(node.dataset.panelHeight),
    w: Number(node.dataset.panelWidth),
  }));
  const resizeBox = await firstWorkspacePanel.locator(".panel-resize-handle").boundingBox();
  assert.ok(resizeBox, "expected workspace panel resize handle");
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 260, resizeBox.y + resizeBox.height / 2 + 120, { steps: 8 });
  await page.mouse.up();
  const resizedOnce = await page.evaluate((start) => {
    const card = document.querySelector(".workspace-panel-card");
    return Boolean(card) && (Number(card.dataset.panelWidth) > start.w || Number(card.dataset.panelHeight) > start.h);
  }, startingLayout);
  if (!resizedOnce) {
    const retryBox = await firstWorkspacePanel.locator(".panel-resize-handle").boundingBox();
    assert.ok(retryBox, "expected workspace panel resize handle after retry");
    await page.mouse.move(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(retryBox.x + retryBox.width / 2 + 320, retryBox.y + retryBox.height / 2 + 180, { steps: 12 });
    await page.mouse.up();
  }
  await page.waitForFunction((start) => {
    const card = document.querySelector(".workspace-panel-card");
    return Boolean(card) && (Number(card.dataset.panelWidth) > start.w || Number(card.dataset.panelHeight) > start.h);
  }, startingLayout);
  await page.getByRole("button", { name: "Reset layout" }).click();
  await page.waitForFunction(() => document.querySelector("#workspace-mode")?.value === "automatic" && document.querySelectorAll(".workspace-panel-card").length >= 3);

  const visibleRunChecks = page.locator(".workspace-run-row");
  const visibleRunCheckCount = await visibleRunChecks.count();
  const selectedRunCheckTarget = Math.min(6, visibleRunCheckCount);
  for (let index = 0; index < selectedRunCheckTarget; index += 1) {
    const selectButton = visibleRunChecks.nth(index).locator(".workspace-run-select");
    if ((await selectButton.getAttribute("aria-pressed")) !== "true") await selectButton.click();
  }
  const selectedRunPanel = page.locator(".workspace-panel-card").filter({ hasText: "system/cpu_percent" }).first();
  await selectedRunPanel.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction((target) => {
    const card = [...document.querySelectorAll(".workspace-panel-card")]
      .find((node) => node.textContent?.includes("system/cpu_percent"));
    return card?.querySelector(".workspace-panel-meta")?.textContent?.includes(`${target} selected`);
  }, selectedRunCheckTarget);
  await page.waitForFunction((target) => {
    const card = [...document.querySelectorAll(".workspace-panel-card")]
      .find((node) => node.textContent?.includes("system/cpu_percent"));
    return card?.querySelectorAll(".metric-chart .series").length === target;
  }, selectedRunCheckTarget);
  const workspacePanelSeriesCount = await selectedRunPanel.locator(".metric-chart .series").count();
  assert.equal(workspacePanelSeriesCount, selectedRunCheckTarget);
  assert.equal(await selectedRunPanel.locator(".chart-legend .legend-chip:not(.legend-overflow)").count(), selectedRunCheckTarget);
  if (selectedRunCheckTarget >= 2) {
    await visibleRunChecks.nth(0).locator(".workspace-run-select").click();
    await visibleRunChecks.nth(1).locator(".workspace-run-select").click();
    await page.waitForFunction((target) => {
      const card = [...document.querySelectorAll(".workspace-panel-card")]
        .find((node) => node.textContent?.includes("system/cpu_percent"));
      return card?.querySelector(".workspace-panel-meta")?.textContent?.includes(`${target} selected`)
        && card?.querySelectorAll(".metric-chart .series").length === target
        && card?.querySelectorAll(".chart-legend .legend-chip:not(.legend-overflow)").length === target;
    }, selectedRunCheckTarget - 2);
  }
  if (selectedRunCheckTarget >= 2) {
    await visibleRunChecks.nth(0).locator(".workspace-run-select").click();
    await visibleRunChecks.nth(1).locator(".workspace-run-select").click();
    await page.waitForFunction((target) => {
      const card = [...document.querySelectorAll(".workspace-panel-card")]
        .find((node) => node.textContent?.includes("system/cpu_percent"));
      return card?.querySelector(".workspace-panel-meta")?.textContent?.includes(`${target} selected`)
        && card?.querySelectorAll(".metric-chart .series").length === target
        && card?.querySelectorAll(".chart-legend .legend-chip:not(.legend-overflow)").length === target;
    }, selectedRunCheckTarget);
  }
  await selectedRunPanel.scrollIntoViewIfNeeded();
  const workspacePlotCoverage = await selectedRunPanel.evaluate((card) => {
    const chart = card.querySelector(".metric-chart");
    const horizontalAxis = [...card.querySelectorAll(".axis")].find((axis) => axis.getAttribute("y1") === axis.getAttribute("y2"));
    const chartRect = chart?.getBoundingClientRect();
    const axisRect = horizontalAxis?.getBoundingClientRect();
    return chartRect && axisRect ? axisRect.width / chartRect.width : 0;
  });
  assert.ok(workspacePlotCoverage > 0.72, `workspace chart plot should fill the panel width, got ${(workspacePlotCoverage * 100).toFixed(1)}%`);
  const workspacePointBox = await selectedRunPanel.locator(".series-point").first().boundingBox();
  assert.ok(workspacePointBox, "expected workspace chart point to have a bounding box");
  await selectedRunPanel.locator(".series-point").first().hover({ force: true });
  await selectedRunPanel.locator(".chart-tooltip").waitFor({ state: "visible", timeout: 10000 });
  const workspaceTooltipText = await selectedRunPanel.locator(".chart-tooltip").first().innerText();
  assert.match(workspaceTooltipText, /(llm|rl)-.+-seed-/);
  assert.match(workspaceTooltipText, /\d/);
  await selectedRunPanel.hover();
  await selectedRunPanel.locator('button[aria-label^="Fullscreen"]').click();
  await page.waitForSelector(".workspace-modal");
  const fullscreenLayout = await page.locator(".fullscreen-modal-card").evaluate((modal) => {
    const modalRect = modal.getBoundingClientRect();
    const chart = modal.querySelector(".metric-chart")?.getBoundingClientRect();
    const visibleInnerHeads = [...modal.querySelectorAll(".workspace-panel-head")].filter((node) => getComputedStyle(node).display !== "none").length;
    const range = modal.querySelector(".chart-range")?.getBoundingClientRect();
    const subtitle = modal.querySelector(".fullscreen-title-block span")?.textContent ?? "";
    return {
      chartBottom: chart?.bottom ?? 0,
      chartWidth: chart?.width ?? 0,
      modalBottom: modalRect.bottom,
      modalWidth: modalRect.width,
      rangeVisible: Boolean(range && range.width > 100 && range.height > 20),
      subtitle,
      visibleInnerHeads,
    };
  });
  assert.equal(fullscreenLayout.visibleInnerHeads, 0, "fullscreen modal should not duplicate the panel card header");
  assert.match(fullscreenLayout.subtitle, /of \d+/);
  assert.ok(fullscreenLayout.chartWidth > fullscreenLayout.modalWidth * 0.62, "fullscreen chart should use the modal width");
  assert.ok(fullscreenLayout.chartBottom < fullscreenLayout.modalBottom, "fullscreen chart should stay inside the modal viewport");
  assert.ok(fullscreenLayout.rangeVisible, "fullscreen chart should expose the range zoom brush");
  const fullscreenRangeBox = await page.locator(".fullscreen-modal .chart-range svg").first().boundingBox();
  assert.ok(fullscreenRangeBox, "expected fullscreen chart range brush");
  await page.mouse.move(fullscreenRangeBox.x + fullscreenRangeBox.width * 0.25, fullscreenRangeBox.y + fullscreenRangeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fullscreenRangeBox.x + fullscreenRangeBox.width * 0.78, fullscreenRangeBox.y + fullscreenRangeBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".fullscreen-modal .chart-zoom-reset", { timeout: 10000 });
  const firstFullscreenTitle = await page.locator(".workspace-modal .drawer-head h2").innerText();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((title) => document.querySelector(".workspace-modal .drawer-head h2")?.textContent !== title, firstFullscreenTitle);
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction((title) => document.querySelector(".workspace-modal .drawer-head h2")?.textContent === title, firstFullscreenTitle);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".workspace-modal"));

  await chooseSelect(page, "#sort-select", "metric-best");
  let runCheckboxes = page.locator(".workspace-run-row");
  if ((await runCheckboxes.nth(1).getAttribute("aria-pressed")) !== "true") await runCheckboxes.nth(1).click();

  await page.getByRole("link", { name: /Metrics/ }).click();
  await page.waitForFunction(() => document.querySelector(".tab-pane.active")?.textContent?.includes("Metric Catalog"));
  await page.waitForFunction(() => document.querySelector(".tab-pane.active")?.textContent?.includes("Leaderboard"));
  await page.fill("#metric-filter", "train/.*");
  await page.waitForFunction(() => [...document.querySelectorAll("#metric-select option")].some((option) => option.textContent === "train/loss"));
  await chooseSelect(page, "#metric-select", "train/loss");
  await page.waitForFunction(() => document.querySelector("#metric-select")?.value === "train/loss");
  const pinMetric = page.locator("#pin-metric");
  if (!(await pinMetric.innerText()).includes("Pinned")) await pinMetric.click();
  await chooseSelect(page, "#group-select", "seed");
  await chooseSelect(page, "#x-mode", "time");
  await page.locator("#smoothing").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.check("#group-average");
  await page.waitForSelector(".tab-pane.active .series-point", { timeout: 10000 });
  await page.locator(".tab-pane.active .series-point").first().hover({ force: true });
  await page.waitForSelector(".tab-pane.active .readout-card", { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active .readout-card").innerText(), /step/);

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-open", { state: "visible", timeout: 10000 });
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Metric Summary"));
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Metric Summary"));
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Reproducibility"));
  await page.getByRole("button", { name: "Data" }).click();
  await page.waitForSelector(".run-data-panel");
  await page.getByRole("button", { name: "Summary" }).click();
  const detailMetadataEditor = page.locator("#run-detail .run-metadata-editor").first();
  await detailMetadataEditor.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await detailMetadataEditor.innerText(), /Run tags and notes/);
  await detailMetadataEditor.getByRole("button", { name: /Edit/ }).click();
  await detailMetadataEditor.locator(".tag-textarea").first().fill("qa-smoke, reviewed, note-search");
  await page.waitForFunction(() => document.querySelector("#run-detail .metadata-tag-preview")?.textContent?.includes("note-search"));
  await detailMetadataEditor.locator(".notes-control textarea").first().fill("qa-note-smoke searchable detail note");
  await detailMetadataEditor.getByRole("button", { name: /Save/ }).click();
  await page.waitForFunction(() => document.querySelector("#run-detail .run-metadata-editor")?.textContent?.includes("qa-note-smoke searchable detail note"));
  await page.getByRole("button", { name: "Files" }).click();
  await page.waitForSelector(".evidence-panel", { timeout: 10000 });
  await page.waitForSelector(".evidence-panel .copy-button", { timeout: 10000 });
  await page.getByRole("button", { name: "Summary" }).click();
  assert.doesNotMatch(await page.locator("#run-detail").innerText(), /Hovered point/);

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
  await page.fill("#search", "qa-note-smoke");
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("qa-note-smoke"));
  assert.match(await page.locator(".workspace-run-list").innerText(), /qa-smoke/);
  await page.fill("#search", "");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("matching runs"));
  await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row").length >= 4);
  for (let index = 0; index < 4; index += 1) {
    const selectedForCompare = await page.locator(".workspace-run-row.selected").count();
    if (selectedForCompare >= 4) break;
    await page.locator(".workspace-run-row:not(.selected) .workspace-run-select").first().click();
    await page.waitForFunction((minimum) => document.querySelectorAll(".workspace-run-row.selected").length >= minimum, selectedForCompare + 1);
  }
  const objectRequestsBeforeCompare = objectUrls.length;
  await page.getByRole("link", { name: /Compare/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("#reference-run option").length >= 2);
  assert.equal(objectUrls.length, objectRequestsBeforeCompare, "Compare should not fan out rich-object requests");
  const referenceOptions = await page.locator("#reference-run option").count();
  assert.ok(referenceOptions >= 2);
  await page.locator(".compare-annotation-details summary").click();
  const compareMetadataEditor = page.locator(".compare-metadata-editor .run-metadata-editor").first();
  await compareMetadataEditor.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await compareMetadataEditor.innerText(), /Tags and notes/);
  await compareMetadataEditor.getByRole("button", { name: /Edit/ }).click();
  await compareMetadataEditor.locator(".tag-textarea").first().fill("compare-smoke, needs-review");
  await page.waitForFunction(() => document.querySelector(".compare-metadata-editor .metadata-tag-preview")?.textContent?.includes("compare-smoke"));
  await compareMetadataEditor.locator(".notes-control textarea").first().fill("compare-note-smoke edited from compare");
  await compareMetadataEditor.getByRole("button", { name: /Save/ }).click();
  await page.waitForFunction(() => document.querySelector(".compare-metadata-editor")?.textContent?.includes("compare-note-smoke edited from compare"));
  await chooseSelect(page, "#compare-layout", "columns");
  await page.waitForSelector(".compare-matrix");
  const firstReferenceLabel = await page.locator("#reference-run option").nth(0).innerText();
  await chooseSelect(page, "#reference-run", { index: 0 });
  await page.waitForFunction(
    (label) => document.querySelector(".compare-head.reference")?.textContent?.includes(label),
    firstReferenceLabel,
  );
  await chooseSelect(page, "#reference-run", { index: 1 });
  await page.check("#diff-only");
  await page.waitForFunction(() => document.querySelector(".compare-summary")?.textContent?.includes("Best run"));
  await page.waitForFunction(() => document.querySelector("#side-by-side")?.textContent?.includes("seed"));
  assert.match(await page.locator(".compare-head.reference").innerText(), /reference/i);
  const compareLabels = await page.locator(".compare-attribute strong").allTextContents();
  assert.ok(compareLabels.length > 0);
  assert.ok(compareLabels.some((label) => /(?:agent|data|eval|gpu|rollout|system|train)\//.test(label)), `compare labels should expose metric paths: ${compareLabels.slice(0, 8).join(", ")}`);
  assert.ok(compareLabels.every((label) => !["latest", "max", "mean"].includes(label)), `compare labels should not be reducer-only: ${compareLabels.slice(0, 8).join(", ")}`);
  await chooseSelect(page, "#compare-layout", "rows");
  await chooseSelect(page, "#compare-row-sort", "spread");
  await chooseSelect(page, "#compare-run-sort", "metric-best");
  await page.fill("#compare-search", "seed");
  await page.waitForSelector(".compare-run-layout");
  const compareMetricToAdd = await page.locator("#compare-add-metric option").nth(1).evaluate((option) => option.value);
  assert.ok(compareMetricToAdd, "compare add-metric select should expose at least one additional metric");
  const compareMetricLabel = compareMetricToAdd.split("/").pop() || compareMetricToAdd;
  await chooseSelect(page, "#compare-add-metric", { index: 1 });
  await page.waitForFunction((label) => document.querySelector(".compare-metric-strip")?.textContent?.includes(label), compareMetricLabel);
  await page.getByRole("button", { name: new RegExp(`Sort compared runs by ${escapeRegExp(compareMetricToAdd)}`) }).first().click();
  await page.waitForFunction((label) => document.querySelector(".compare-row-head.active")?.textContent?.includes(label), compareMetricLabel);
  const compareRowText = await page.locator("#side-by-side").innerText();
  assert.match(compareRowText, /NOTES/i);
  assert.match(compareRowText, /ARTIFACTS/i);
  assert.match(compareRowText, new RegExp(escapeRegExp(compareMetricLabel), "i"));
  assert.ok(await page.locator(".compare-artifact-strip").count() > 0);
  await chooseSelect(page, "#compare-run-sort", "config");
  await chooseSelect(page, "#compare-config-key", "seed");
  await chooseSelect(page, "#compare-layout", "columns");
  await page.fill("#compare-search", "");
  await page.waitForSelector(".compare-matrix");
  await page.fill("#view-name", "demo-loss-review");
  await page.click("#save-view");

  const tabChecks = [
    ["Alerts", "Run Health"],
    ["Datasets", "Config-derived Datasets"],
    ["Artifacts", "Selected-run Artifacts"],
    ["Models", "Checkpoint Lineage"],
    ["Reports", "Local Saved Views"],
    ["Settings", "Workspace"],
    ["Integrations", "Python SDK"],
    ["API", "API Surface"],
  ];
  for (const [tab, expectedText] of tabChecks) {
    const objectsBeforeTabClick = objectUrls.length;
    await page.getByRole("link", { name: new RegExp(`^${tab}$`) }).click();
    await page.waitForFunction(
      (text) => document.querySelector(".tab-pane.active")?.textContent?.includes(text),
      expectedText,
    );
    if (tab === "Artifacts") {
      await page.waitForFunction(() => document.querySelectorAll(".tab-pane.active .copy-button").length > 0);
      await page.waitForFunction(() => document.querySelector(".tab-pane.active")?.textContent?.includes("Logged Objects"));
      if (backendMode !== "node") {
        assert.ok(objectUrls.length > objectsBeforeTabClick, "Artifacts tab should fetch selected-run rich objects");
      }
      assert.ok(await page.locator(".tab-pane.active .copy-button").count() > 0);
    }
    if (tab === "API") {
      assert.ok(await page.locator(".tab-pane.active .copy-button").count() > 0);
    }
  }

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
  const runsData = await page.evaluate(() => ({
    rows: document.querySelectorAll(".workspace-run-row").length,
    panels: document.querySelectorAll(".workspace-panel-card").length,
    sections: document.querySelectorAll(".workspace-section").length,
    mode: document.querySelector("#workspace-mode")?.value,
    sort: document.querySelector("#sort-select")?.value,
    notePreviews: [...document.querySelectorAll(".workspace-run-note")].map((node) => node.textContent ?? ""),
    tagPreviews: [...document.querySelectorAll(".workspace-run-tags")].map((node) => node.textContent ?? ""),
    tallRows: [...document.querySelectorAll(".workspace-run-row")].filter((row) => row.getBoundingClientRect().height > 120).length,
  }));
  await page.getByRole("link", { name: /^Metrics$/ }).click();
  await page.waitForSelector(".tab-pane.active .metric-chart", { timeout: 10000 });
  const metricsData = await page.evaluate(() => ({
    chart: Boolean(document.querySelector(".tab-pane.active .metric-chart")),
    chartStrokeWidth: getComputedStyle(document.querySelector(".tab-pane.active .series")).strokeWidth,
    chartPointRadius: document.querySelector(".tab-pane.active .series-point")?.getAttribute("r") ?? "",
    points: document.querySelectorAll(".tab-pane.active .series-point").length,
    axisLabels: [...document.querySelectorAll(".tab-pane.active .axis-label")].map((node) => node.textContent),
    metricCatalogRows: document.querySelectorAll(".tab-pane.active .metric-catalog-row").length,
    leaderboardRows: document.querySelectorAll(".tab-pane.active .leaderboard-row").length,
    leaderboardEmpty: document.querySelector(".tab-pane.active")?.textContent?.includes("No selected runs have") ?? false,
    controls: {
      group: document.querySelector("#group-select")?.value,
      x: document.querySelector("#x-mode")?.value,
      smooth: document.querySelector("#smoothing")?.value,
      average: document.querySelector("#group-average")?.checked,
    },
  }));
  await page.getByRole("link", { name: /^Run Detail$/ }).click();
  await page.waitForSelector("#run-detail", { timeout: 10000 });
  await page.getByRole("button", { name: "Data" }).click();
  await page.waitForSelector(".run-data-panel", { timeout: 10000 });
  const runDetailChart = await page.locator(".run-data-panel .metric-chart").count() > 0;
  await page.getByRole("button", { name: "Summary" }).click();
  await page.waitForSelector(".tab-pane.active .metric-summary-row:not(.metric-summary-head)", { timeout: 10000 });
  const detailData = await page.evaluate(() => ({
    detail: document.querySelector("#run-detail")?.textContent ?? "",
    runTimelineRows: document.querySelectorAll(".tab-pane.active .run-timeline-row").length,
    runMetricRows: document.querySelectorAll(".tab-pane.active .metric-summary-row:not(.metric-summary-head)").length,
    runDetailChart: false,
  }));
  detailData.runDetailChart = runDetailChart;
  await page.getByRole("link", { name: /^Compare$/ }).click();
  await page.waitForSelector(".compare-matrix", { timeout: 10000 });
  const compareData = await page.evaluate(() => ({
    sideBySide: document.querySelector("#side-by-side")?.textContent ?? "",
    compareMatrix: Boolean(document.querySelector(".compare-matrix")),
    diff: document.querySelector("#diff-only")?.checked,
    layout: document.querySelector("#compare-layout")?.value,
    runSort: document.querySelector("#compare-run-sort")?.value,
    configSort: document.querySelector("#compare-config-key")?.value,
  }));
  const data = await page.evaluate(() => ({
    title: document.title,
    brandLabel: document.querySelector(".brand")?.getAttribute("aria-label"),
    brandMark: Boolean(document.querySelector(".instantml-mark-svg")),
    projectControl: Boolean(document.querySelector("#project-filter")),
    visibleBrandTitle: document.querySelector(".brand h1")?.textContent ?? null,
    navTabs: [...document.querySelectorAll(".tab-button:not(.nav-pin-button)")].map((button) => button.textContent?.trim()),
    savedViews: [...document.querySelectorAll("#saved-view-select option")].map((option) => option.textContent),
  }));
  Object.assign(data, runsData, metricsData, detailData, compareData);
  assert.equal(data.title, "InstantML");
  assert.equal(data.brandLabel, "InstantML");
  assert.equal(data.brandMark, true);
  assert.equal(data.projectControl, true);
  assert.ok(Number.parseFloat(data.chartStrokeWidth) <= 1.5, `chart lines should stay thin for overlap, got ${data.chartStrokeWidth}`);
  assert.ok(Number.parseFloat(data.chartPointRadius) <= 2.5, `chart markers should stay compact, got ${data.chartPointRadius}`);
  assert.equal(data.visibleBrandTitle, null);
  assert.deepEqual(data.navTabs, ["Runs", "Metrics", "Run Detail", "Compare", "Alerts", "Datasets", "Artifacts", "Models", "Reports", "Settings", "Integrations", "API"]);
  assert.ok(data.rows >= 6);
  assert.equal(data.chart, true);
  assert.ok(data.points > 0);
  assert.ok(data.axisLabels.some((label) => label?.includes("Logged time")));
  assert.ok(data.axisLabels.some((label) => label?.includes("Loss")));
  assert.ok(data.panels >= 3);
  assert.ok(data.sections >= 1);
  assert.equal(data.mode, "automatic");
  assert.ok(data.notePreviews.some((note) => /Synthetic|note/i.test(note)), "workspace rows should expose note previews");
  assert.ok(data.tagPreviews.some((tags) => /demo|qa-smoke|compare-smoke/i.test(tags)), "workspace rows should expose tag previews");
  assert.ok(data.metricCatalogRows >= 3);
  assert.ok(data.leaderboardRows >= 1 || data.leaderboardEmpty);
  assert.ok(data.runTimelineRows >= 3);
  assert.ok(data.runMetricRows >= 3);
  assert.equal(data.runDetailChart, true);
  assert.match(data.detail, /Metric Summary/);
  assert.match(data.detail, /tags and notes/i);
  assert.match(data.sideBySide, /seed/);
  assert.match(data.sideBySide, /compare-note-smoke|qa-note-smoke|Synthetic/i);
  assert.equal(data.compareMatrix, true);
  assert.ok(data.savedViews.some((view) => view?.includes("demo-loss-review")));
  assert.deepEqual(
    { sort: data.sort, group: data.controls.group, x: data.controls.x, smooth: data.controls.smooth, average: data.controls.average, diff: data.diff, layout: data.layout, runSort: data.runSort, configSort: data.configSort },
    { sort: "metric-best", group: "seed", x: "time", smooth: "20", average: true, diff: true, layout: "columns", runSort: "config", configSort: "seed" },
  );
  assert.equal(data.tallRows, 0);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row");
  const midWidth = await page.evaluate(() => ({
    viewport: window.innerWidth,
    bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    footer: document.querySelector(".workspace-run-footer")?.textContent ?? "",
    visibleTabs: [...document.querySelectorAll(".tab-button:not(.nav-pin-button)")].filter((button) => button.getBoundingClientRect().width > 0).length,
  }));
  assert.equal(midWidth.viewport, 1280);
  assert.ok(midWidth.bodyOverflow <= 4, `mid-width horizontal overflow: ${midWidth.bodyOverflow}`);
  assert.match(midWidth.footer, /of 1,?000/);
  assert.equal(midWidth.visibleTabs, 12);

  await page.setViewportSize({ width: 390, height: 820 });
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".runs-workspace");
  const mobileWidth = await page.evaluate(() => ({
    viewport: window.innerWidth,
    bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    workspaceColumns: getComputedStyle(document.querySelector(".runs-workspace")).gridTemplateColumns,
    visibleRunRail: Boolean(document.querySelector(".workspace-run-rail")?.getBoundingClientRect().height),
  }));
  assert.equal(mobileWidth.viewport, 390);
  assert.ok(mobileWidth.bodyOverflow <= 4, `mobile horizontal overflow: ${mobileWidth.bodyOverflow}`);
  assert.ok(mobileWidth.visibleRunRail);
  assert.match(mobileWidth.workspaceColumns, /^\d+(\.\d+)?px$/);

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.fill("#search", "empty-state-check");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("No runs match"));
  assert.match(await page.locator("#status-message").innerText(), /current filters/);
  assert.match(await page.locator(".workspace-run-list .compact-empty").innerText(), /No runs match/);
  screenshotPath = path.join(dir, "ui-smoke.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  await browser.close();
  browser = null;
  let expectedNodeObject404s = backendMode === "node" ? objectNotFoundUrls.length : 0;
  const unexpectedErrors = errors.filter((error) => {
    if (expectedNodeObject404s > 0 && error === "Failed to load resource: the server responded with a status of 404 (Not Found)") {
      expectedNodeObject404s -= 1;
      return false;
    }
    return true;
  });
  assert.deepEqual(unexpectedErrors, []);
  console.log(`UI smoke passed. Screenshot: ${screenshotPath}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (nextServer) {
    nextServer.kill();
    await new Promise((resolve) => nextServer.once("close", resolve));
  }
  if (apiServer) {
    await new Promise((resolve) => apiServer.close(resolve));
    apiServer.store.close();
  }
}

async function chooseSelect(page, selector, valueOrOptions) {
  await page.locator(selector).evaluate((select, nextValueOrOptions) => {
    const element = select;
    const nextValue = typeof nextValueOrOptions === "object" && nextValueOrOptions !== null && "index" in nextValueOrOptions
      ? element.options[nextValueOrOptions.index]?.value
      : String(nextValueOrOptions);
    if (nextValue === undefined) throw new Error("No option found");
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, valueOrOptions);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pageApiRequest(page, method, route, body, options = {}) {
  const attempts = 1 + (options.retries ?? 0);
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await page.evaluate(async ({ method, route, body }) => {
      const response = await fetch(route, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { text };
      }
      return { ok: response.ok, payload, status: response.status };
    }, { method, route, body });
    if (result.ok || result.status < 500 || attempt === attempts - 1) break;
    await page.waitForTimeout(250);
  }
  assert.equal(result.ok, true, `${method} ${route}: ${JSON.stringify(result.payload)} (${result.status})`);
  return result.payload;
}

async function pageApiGet(page, route) {
  const result = await page.evaluate(async (route) => {
    const response = await fetch(route);
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { text };
    }
    return { ok: response.ok, payload, status: response.status };
  }, route);
  assert.equal(result.ok, true, `GET ${route}: ${JSON.stringify(result.payload)} (${result.status})`);
  return result.payload;
}

async function apiRequest(root, method, route, body) {
  const response = await fetch(root + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}

async function apiGet(root, route) {
  const response = await fetch(root + route);
  const payload = await response.json();
  assert.equal(response.ok, true, `GET ${route}: ${JSON.stringify(payload)}`);
  return payload;
}

async function assertStaticAssetsOk(root) {
  const response = await fetch(root);
  assert.equal(response.ok, true, `HTML request failed: ${response.status}`);
  const html = await response.text();
  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/g)]
    .map((match) => new URL(match[1], root).toString());
  const uniqueAssets = [...new Set(assetUrls)];
  assert.ok(uniqueAssets.length > 0, "expected Next static assets in rendered HTML");
  for (const assetUrl of uniqueAssets) {
    const assetResponse = await fetch(assetUrl);
    assert.equal(assetResponse.ok, true, `${assetUrl} returned ${assetResponse.status}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 30000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}
