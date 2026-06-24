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
const docsScreenshotMode = process.env.INSTANTML_UI_SMOKE_DOC_SCREENSHOTS === "1";
const docsProductDir = path.join(repo, "apps/docs/images/product");
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
let expectedBadRequestResourceErrors = 0;
let expectedPaymentRequiredResourceErrors = 0;
let expectedServiceUnavailableResourceErrors = 0;
let expectedServiceUnavailableApiErrors = 0;
let nextOutput = "";

try {
  if (apiServer) await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiBaseUrl = externalApiBaseUrl || `http://127.0.0.1:${apiServer.address().port}`;
  const paginationRunIds = [];
  const nextEnv = {
    ...process.env,
    INSTANTML_WEB_EXPLICIT_API_BASES: "1",
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
  const appendNextOutput = (chunk) => {
    nextOutput = `${nextOutput}${chunk.toString()}`.slice(-8192);
  };
  nextServer.stdout.on("data", appendNextOutput);
  nextServer.stderr.on("data", appendNextOutput);
  try {
    await waitForHttp(`http://127.0.0.1:${webPort}`, nextServer);
  } catch (error) {
    throw new Error(`Next server did not become ready on port ${webPort}: ${error instanceof Error ? error.message : String(error)}\n${nextOutput}`);
  }
  await assertStaticAssetsOk(`http://127.0.0.1:${webPort}`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  let expectedForbiddenResourceErrors = 0;
  let expectedApiFailureConsoleErrors = 0;
  let expectedRateLimitResourceErrors = 0;
  const unexpectedForbiddenResourceUrls = [];
  const unexpectedPaymentRequiredResourceUrls = [];
  const unexpectedBadRequestResourceUrls = [];
  const unexpectedRateLimitResourceUrls = [];
  const consoleErrorReads = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const read = consoleErrorText(message).then((text) => errors.push(text));
      consoleErrorReads.push(read);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const summaryUrls = [];
  const objectUrls = [];
  const logUrls = [];
  const forkRequests = [];
  const objectNotFoundUrls = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/runs/summary")) summaryUrls.push(request.url());
    if (request.url().includes("/objects")) objectUrls.push(request.url());
    if (request.url().includes("/logs")) logUrls.push(request.url());
    if (request.method() === "POST" && request.url().includes("/api/runs/") && request.url().endsWith("/forks")) {
      forkRequests.push({ headers: request.headers(), url: request.url() });
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("/objects") && response.status() === 404) objectNotFoundUrls.push(response.url());
    if (response.status() === 403) {
      if (isExpectedForbiddenResource(response)) {
        expectedForbiddenResourceErrors += 1;
        expectedApiFailureConsoleErrors += 1;
      } else {
        unexpectedForbiddenResourceUrls.push(response.url());
      }
    }
    if (response.status() === 402) {
      if (isExpectedPaymentRequiredResource(response)) {
        expectedApiFailureConsoleErrors += 1;
      } else {
        unexpectedPaymentRequiredResourceUrls.push(response.url());
      }
    }
    if (response.status() === 429) {
      if (isExpectedRateLimitedResource(response)) {
        expectedRateLimitResourceErrors += 1;
        expectedApiFailureConsoleErrors += 1;
      } else {
        unexpectedRateLimitResourceUrls.push(response.url());
      }
    }
    if (response.status() === 400) {
      if (isExpectedBadRequestResource(response)) {
        expectedBadRequestResourceErrors += 1;
        expectedApiFailureConsoleErrors += 1;
      } else {
        unexpectedBadRequestResourceUrls.push(response.url());
      }
    }
  });

  const webBaseUrl = `http://127.0.0.1:${webPort}`;
  const smokeId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const ownerEmail = `ui-smoke-${smokeId}@example.com`;
  const primaryOrgName = docsScreenshotMode ? "InstantML Demo Lab" : `UI Smoke ${smokeId}`;
  await page.goto(webBaseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".landing-root", { timeout: 10000 });
  assert.equal(summaryUrls.length, 0, "public landing page should not fetch run summaries");

  await page.goto(`${webBaseUrl}/signup`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Name").fill(docsScreenshotMode ? "InstantML Demo" : "UI Smoke");
  await page.getByLabel("Business").check();
  await page.getByLabel("Organization").fill(primaryOrgName);
  await page.getByRole("button", { name: /Continue with Dev Google/ }).click();
  await page.waitForURL(/\/onboarding$/, { timeout: 10000 });
  await page.getByRole("button", { name: /Create SDK API key/ }).click();
  await page.waitForSelector(".iml-term-body code", { timeout: 10000 });
  assert.match(await page.locator(".iml-term-body code").innerText(), /^instantml_/);

  if (backendMode !== "node") {
    const seedRun = (await pageApiRequest(page, "POST", "/runs", {
      project: "demo",
      name: "rl-ppo-seed-44",
      config: { seed: 44, variant: "tuned", model: "rl", workload: "ppo", learning_rate: 0.0001 },
      tags: ["demo", "rl", "seed-44"],
      metadata: { notes: "reward stability and rollout quality for seed 44" },
    })).run;
    const seedRunId = seedRun.id;
    await pageApiRequest(page, "POST", `/runs/${seedRunId}/metrics`, {
      step: 0,
      metrics: { "eval/return_mean": 42, "eval/score_distribution": 0.7, "train/reward": 84, "train/loss": 0.42, "system/cpu_percent": 38 },
    });
    await pageApiRequest(page, "POST", `/runs/${seedRunId}/metrics`, {
      step: 1,
      metrics: { "eval/return_mean": 44, "eval/score_distribution": 0.8, "train/reward": 88, "train/loss": 0.37, "system/cpu_percent": 41 },
    });
    const imageArtifact = (await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/artifacts/upload`, {
      type: "file",
      name: "qa-preview.png",
      content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      step: 2,
      mime_type: "image/png",
      metadata: { kind: "image", caption: "qa preview" },
    })).artifact;
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/artifacts/upload`, {
      type: "checkpoint",
      name: "qa-checkpoint.json",
      content_base64: Buffer.from(JSON.stringify({ step: 2, weights: [0.42, 0.58] })).toString("base64"),
      step: 2,
      mime_type: "application/json",
      metadata: { kind: "checkpoint", checkpoint: { step: 2, source_run_id: seedRunId } },
    });
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
      step: 0,
      metadata: { source: "ui-smoke" },
      summary: {},
      value: { bins: [0, 0.25, 0.5, 0.75, 1], counts: [5, 12, 9, 3] },
    });
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/objects`, {
      key: "eval/score_distribution",
      kind: "histogram",
      step: 1,
      metadata: { source: "ui-smoke" },
      summary: {},
      value: { bins: [0, 0.25, 0.5, 0.75, 1], counts: [3, 8, 13, 7] },
    });
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/objects`, {
      key: "eval/score_distribution",
      kind: "histogram",
      step: 2,
      metadata: { source: "ui-smoke" },
      summary: {},
      value: { bins: [0, 0.25, 0.5, 0.75, 1], counts: [2, 5, 10, 16] },
    });
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/objects`, {
      key: "eval/classification",
      kind: "classification_eval",
      step: 2,
      metadata: { source: "ui-smoke" },
      summary: {
        task: "binary_classification",
        split: "validation",
        sample_count: 20,
        accuracy: 0.75,
        macro_f1: 0.749,
        class_names: ["negative", "positive"],
        positive_label: "positive",
      },
      value: {
        schema_version: 1,
        task: "binary_classification",
        split: "validation",
        positive_label: "positive",
        threshold: 0.5,
        threshold_direction: "score_gte_threshold",
        class_names: ["negative", "positive"],
        sample_count: 20,
        confusion_matrix: [[8, 2], [3, 7]],
        per_class: [
          { class_name: "negative", precision: 0.7272727273, recall: 0.8, f1: 0.7619047619, support: 10 },
          { class_name: "positive", precision: 0.7777777778, recall: 0.7, f1: 0.7368421053, support: 10 },
        ],
        accuracy: 0.75,
        macro_f1: 0.7493734336,
        pr_curve: [
          { threshold: 0.95, precision: 1, recall: 0.1 },
          { threshold: 0.8, precision: 0.9, recall: 0.35 },
          { threshold: 0.65, precision: 0.82, recall: 0.6 },
          { threshold: 0.5, precision: 0.78, recall: 0.7 },
          { threshold: 0.35, precision: 0.64, recall: 0.9 },
          { threshold: 0.15, precision: 0.5, recall: 1 },
        ],
        roc_curve: [
          { threshold: 0.95, tpr: 0.1, fpr: 0 },
          { threshold: 0.8, tpr: 0.35, fpr: 0.05 },
          { threshold: 0.65, tpr: 0.6, fpr: 0.15 },
          { threshold: 0.5, tpr: 0.7, fpr: 0.2 },
          { threshold: 0.35, tpr: 0.9, fpr: 0.5 },
          { threshold: 0.15, tpr: 1, fpr: 1 },
        ],
        predictions: [
          { id: "ex-1", true_label: "negative", predicted_label: "negative", score: 0.1, correct: true },
          { id: "ex-2", true_label: "positive", predicted_label: "positive", score: 0.8, correct: true },
          { id: "ex-3", true_label: "positive", predicted_label: "negative", score: 0.42, correct: false },
          { id: "ex-4", true_label: "negative", predicted_label: "positive", score: 0.61, correct: false },
        ],
      },
    });
    await pageApiRequest(page, "POST", `/api/runs/${seedRunId}/logs`, {
      stream: "stdout",
      lines: [
        { line_number: 1, message: "Epoch 1 loss=0.42", timestamp: "2026-05-14T00:00:00Z" },
        { line_number: 2, message: "\u001b[32mcheckpoint saved\u001b[0m", timestamp: "2026-05-14T00:00:01Z" },
      ],
    });
    const demoVariants = ["baseline", "baseline", "baseline", "baseline", "baseline", "tuned", "tuned", "tuned", "tuned", "tuned"];
    for (const [index, variant] of demoVariants.entries()) {
      const seed = 50 + index;
      const score = variant === "baseline" ? 38 + index * 1.1 : 45 + (index - 5) * 1.3;
      const run = (await pageApiRequest(page, "POST", "/runs", {
        project: "demo",
        name: `rl-ppo-${variant}-seed-${seed}`,
        config: { seed, variant, model: "rl", workload: "ppo", learning_rate: variant === "baseline" ? 0.0003 : 0.0001 },
        tags: ["demo", variant],
        metadata: { notes: `Synthetic ${variant} ablation seed ${seed}` },
      })).run;
      await pageApiRequest(page, "POST", `/runs/${run.id}/metrics`, {
        step: 0,
        metrics: { "eval/return_mean": score, "train/reward": score * 2, "train/loss": 1 / (index + 2) },
      });
      await pageApiRequest(page, "POST", `/runs/${run.id}/metrics`, {
        step: 1,
        metrics: { "eval/return_mean": score + 1.5, "train/reward": score * 2 + 3, "train/loss": 1 / (index + 3) },
      });
    }
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

  if (docsScreenshotMode) {
    await captureDocScreenshots(page, webBaseUrl);
    if (browser) await browser.close().catch(() => {});
    if (nextServer) {
      nextServer.kill();
      await new Promise((resolve) => nextServer.once("close", resolve)).catch(() => {});
    }
    console.log("[doc-shot] capture routine complete");
    process.exit(0);
  }

  let delayedInitialSummary = true;
  await page.route("**/api/runs/summary**", async (route) => {
    if (delayedInitialSummary) {
      delayedInitialSummary = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });
  await page.goto(`${webBaseUrl}/dashboard/runs`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-loading-screen, .workspace-run-loading", { timeout: 5000 });
  await page.waitForSelector(".workspace-run-row", { timeout: 15000 });
  await page.unroute("**/api/runs/summary**");
  assert.equal(objectUrls.length, 0, "initial dashboard entry should not fetch rich objects");
  assert.equal(logUrls.length, 0, "initial dashboard entry should not fetch console logs");
  await assertWorkbarDropdownVisible(page, "project-filter");
  await assertWorkbarDropdownVisible(page, "status-filter");
  await page.getByRole("link", { name: /^Settings$/ }).click();
  await page.waitForSelector("text=Plan Usage", { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active").innerText(), /Free/);
  const inviteEmail = `teammate+${Date.now()}@example.com`;
  await page.getByLabel("Invite email").fill(inviteEmail);
  const [inviteResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && /\/api\/orgs\/[^/]+\/invitations$/.test(url.pathname);
    }),
    page.getByRole("button", { name: /^Invite$/ }).click(),
  ]);
  assert.equal(inviteResponse.status(), 200, `settings invite request should succeed, got ${inviteResponse.status()}`);
  const invitePayload = await inviteResponse.json();
  assert.equal(invitePayload.delivery_error ?? null, null, "settings invite should not report an email delivery failure");
  assert.notEqual(invitePayload.invitation?.delivery_status, "send_failed", "settings invite should not persist a failed delivery status");
  await page.waitForSelector(`text=${inviteEmail}`, { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active").innerText(), new RegExp(escapeRegExp(inviteEmail)));
  await page.getByRole("link", { name: /^API$/ }).click();
  await page.waitForSelector("text=API Keys", { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active").innerText(), /API Surface/);
  await page.getByLabel("API key name").fill("UI smoke dashboard key");
  await page.getByRole("button", { name: /^Create$/ }).click();
  await page.waitForSelector(".tab-pane.active .api-key-reveal code", { timeout: 10000 });
  assert.match(await page.locator(".tab-pane.active .api-key-reveal code").innerText(), /^instantml_/);
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 15000 });
  let screenshotPath = path.join(dir, "ui-smoke-core.png");

  if (!fullWorkspaceSmoke) {
    if (backendMode !== "node") {
      await assertOrganizationWorkspaceFlow(page, webBaseUrl, primaryOrgName, smokeId);
    }
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } else {
  await page.mouse.move(520, 140);
  await page.waitForFunction(() => (document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0) < 80);
  await page.hover(".tabs");
  await page.waitForFunction(() => (document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0) > 120);
  await page.getByRole("link", { name: /^Metrics$/ }).click();
  await page.mouse.move(520, 140);
  await page.waitForFunction(() => (document.querySelector(".tabs")?.getBoundingClientRect().width ?? 0) < 80);
  const collapsedNav = await page.evaluate(() => {
    const tabs = document.querySelector(".tabs");
    return {
      focusWithin: tabs?.matches(":focus-within") ?? false,
      nativeTitleCount: document.querySelectorAll("nav.tabs [title]").length,
      width: tabs?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.equal(collapsedNav.focusWithin, false);
  assert.equal(collapsedNav.nativeTitleCount, 0, "sidebar nav should use stable custom labels instead of native title tooltips");
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
  const savedViewSession = await pageApiGet(page, "/api/auth/session");
  const savedViewOrgId = savedViewSession?.organization?.id;
  assert.ok(savedViewOrgId, "smoke should have an active organization before saving a local view");
  const offPageSavedViewKey = `instantml:next:local:view:${savedViewOrgId}:off-page-selection`;
  await page.evaluate(({ ids, key }) => {
    localStorage.setItem(key, JSON.stringify({
      project: "pagination",
      selectedRunIds: ids,
      primaryRunId: ids[0],
      referenceRunId: ids[1],
      pageSize: 10,
      viewName: "off-page-selection",
    }));
  }, { ids: [paginationRunIds[0], paginationRunIds[29]], key: offPageSavedViewKey });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".workspace-run-row", { timeout: 15000 });
  await page.getByRole("button", { name: "View actions" }).click();
  await page.waitForSelector("#saved-view-select", { state: "attached", timeout: 10000 });
  await page.waitForFunction((key) => [...document.querySelectorAll("#saved-view-select option")]
    .some((option) => option.getAttribute("value") === key), offPageSavedViewKey).catch(async (error) => {
      const savedViewState = await page.evaluate((key) => ({
        activeWorkspace: document.querySelector(".account-workspace-current")?.textContent ?? "",
        hasLocalKey: Boolean(localStorage.getItem(key)),
        localKeys: Object.keys(localStorage).filter((item) => item.startsWith("instantml:next:local:view:") || item.startsWith("instantml:next:view:")).sort(),
        options: [...document.querySelectorAll("#saved-view-select option")].map((option) => ({
          label: option.textContent,
          value: option.getAttribute("value"),
        })),
      }), offPageSavedViewKey);
      throw new Error(`org-scoped local saved view option did not load for ${offPageSavedViewKey}: ${JSON.stringify(savedViewState)}: ${error.message}`);
    });
  await chooseSelect(page, "#saved-view-select", offPageSavedViewKey);
  await page.waitForFunction((ids) => {
    const runParam = new URL(window.location.href).searchParams.get("runs") ?? "";
    return ids.every((id) => runParam.includes(id));
  }, [paginationRunIds[0], paginationRunIds[29]]);
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-open", { state: "visible", timeout: 10000 });
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction((ids) => {
    const runParam = new URL(window.location.href).searchParams.get("runs") ?? "";
    return ids.every((id) => runParam.includes(id));
  }, [paginationRunIds[0], paginationRunIds[29]]).catch(async (error) => {
    const detailText = await page.locator("#run-detail").innerText().catch(() => "<missing detail>");
    const selectedText = await page.locator(".workspace-run-rail").innerText().catch(() => "<missing rail>");
    throw new Error(`saved-view off-page selection did not keep both run ids in the URL; detail=${JSON.stringify(detailText.slice(0, 500))}; rail=${JSON.stringify(selectedText.slice(0, 500))}: ${error.message}`);
  });
  // Comparison lives in the Runs → Table view: the restored selection renders inline.
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.locator(".runs-view-switch").getByRole("button", { name: /Table/ }).click();
  await page.waitForSelector(".cmp-table", { timeout: 10000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({
      href: window.location.href,
      empty: document.querySelector("#side-by-side .empty, .compare-embed-prompt")?.textContent ?? "",
      sideBySideSnippet: document.querySelector("#side-by-side")?.textContent?.slice(0, 800) ?? "",
    }));
    throw new Error(`saved-view selection did not render the comparison; state=${JSON.stringify(state)}: ${error.message}`);
  });
  const savedViewCompareText = await page.locator("#side-by-side").innerText();
  assert.match(savedViewCompareText, /page-run-01/);
  assert.match(savedViewCompareText, /page-run-30/);
  await page.locator(".runs-view-switch").getByRole("button", { name: /Panels/ }).click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });
  await page.waitForFunction(() => {
    const panelKeys = [...document.querySelectorAll(".workspace-panel-head small")]
      .map((node) => (node.textContent ?? "").split(" · ")[1])
      .filter(Boolean);
    return panelKeys.length === 3 && panelKeys.every((key) => ["eval/return_mean", "train/loss", "train/reward"].includes(key));
  }).catch(async (error) => {
    const panelKeys = await page.evaluate(() => [...document.querySelectorAll(".workspace-panel-head small")]
      .map((node) => (node.textContent ?? "").split(" · ")[1])
      .filter(Boolean));
    throw new Error(`saved-view workspace panels did not restore expected metric set; saw ${JSON.stringify(panelKeys)}: ${error.message}`);
  });
  await page.waitForFunction(() => document.querySelector("#status-filter option[value='']")?.textContent?.trim() === "All (30)");
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
  const quickSearchRunName = (await firstWorkspaceRun.locator(".workspace-run-open").getAttribute("aria-label"))?.replace(/^Open\s+/, "")
    ?? await firstWorkspaceRun.locator(".workspace-run-body strong").innerText();
  await page.keyboard.press("Control+K");
  await page.waitForSelector("#quick-search-input");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"][aria-label="Quick search"]'))), true);
  await page.focus("#quick-search-input");
  await page.fill("#quick-search-input", quickSearchRunName);
  await page.waitForFunction((runName) => document.querySelector(".quick-search-results")?.textContent?.includes(runName), quickSearchRunName);
  await page.locator(".quick-search-row", { hasText: quickSearchRunName }).first().click();
  await page.waitForFunction(
    (runName) => {
      const detailText = document.querySelector("#run-detail")?.textContent ?? "";
      return detailText.includes(runName) && detailText.includes("Run tags and notes");
    },
    quickSearchRunName,
  ).catch(async (error) => {
    const state = await page.evaluate((runName) => ({
      activeTab: document.querySelector(".tab-pane.active")?.getAttribute("aria-label") ?? "",
      detailSnippet: document.querySelector("#run-detail")?.textContent?.slice(0, 800) ?? "",
      href: window.location.href,
      quickSearchOpen: Boolean(document.querySelector('[role="dialog"][aria-label="Quick search"]')),
      runName,
      status: document.querySelector("#status-message")?.textContent ?? "",
    }), quickSearchRunName);
    throw new Error(`quick search did not open selected run; state=${JSON.stringify(state)}: ${error.message}`);
  });
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({
      href: window.location.href,
      activeTab: document.querySelector(".tab-pane.active")?.getAttribute("aria-label") ?? "",
      bodySnippet: document.body.textContent?.slice(0, 500) ?? "",
      panels: document.querySelectorAll(".workspace-panel-card").length,
      runRows: document.querySelectorAll(".workspace-run-row").length,
      status: document.querySelector("#status-message")?.textContent ?? "",
    }));
    throw new Error(`quick-search return to Runs did not restore workspace panels; state=${JSON.stringify(state)}: ${error.message}`);
  });

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
  const inspectedRunName = (await unselectedRunRow.locator(".workspace-run-open").getAttribute("aria-label"))?.replace(/^Open\s+/, "");
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
      return detailText.includes(runName) && detailText.includes("Run tags and notes");
    },
    inspectedRunName,
  );
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });
  await chooseSelect(page, "#project-filter", "demo");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("matching runs"));
  await page.fill("#search", "seed-44");
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("seed-44"));
  await page.waitForFunction(() => document.querySelector(".workspace-run-open")?.getAttribute("aria-label")?.includes("seed-44"));
  assert.doesNotMatch(await page.locator(".workspace-run-list").innerText(), /No runs match/);
  const objectRequestsBeforeSeedDetail = objectUrls.length;
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-open", { state: "visible", timeout: 10000 });
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Run tags and notes"));
  assert.equal(objectUrls.length, objectRequestsBeforeSeedDetail, "Run Detail summary should not fetch rich objects before Artifacts is opened");
  if (backendMode !== "node") {
    await page.getByRole("button", { name: "Artifacts" }).click();
    await page.locator(".evidence-row", { hasText: "qa-checkpoint.json" }).click();
    await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Resume Code")).catch(async (error) => {
      const state = await page.evaluate(() => ({
        detailSnippet: document.querySelector("#run-detail")?.textContent?.slice(0, 800) ?? "",
        objectRequests: window.location.href,
        status: document.querySelector("#status-message")?.textContent ?? "",
      }));
      throw new Error(`seed run detail did not render checkpoint resume controls; state=${JSON.stringify(state)}: ${error.message}`);
    });
    assert.match(await page.locator("#run-detail").innerText(), /qa-checkpoint\.json/);
    await page.getByRole("button", { name: /Resume Code/ }).first().click();
  }
  if (backendMode !== "node") {
    const logsBeforeRunTab = logUrls.length;
    await page.getByRole("button", { name: "Logs" }).click();
    await page.waitForFunction(() => document.querySelector(".terminal-frame")?.textContent?.includes("loss=0.42")).catch(async (error) => {
      const state = await page.evaluate(() => ({
        activeRunTab: [...document.querySelectorAll(".run-workspace-tab")]
          .find((node) => node.getAttribute("aria-pressed") === "true")?.textContent ?? "",
        detailSnippet: document.querySelector("#run-detail")?.textContent?.slice(0, 800) ?? "",
        status: document.querySelector("#status-message")?.textContent ?? "",
      }));
      throw new Error(`seed run logs did not render seeded stdout; state=${JSON.stringify(state)}: ${error.message}`);
    });
    assert.ok(logUrls.length > logsBeforeRunTab, "Logs run tab should fetch selected-run console logs only when opened");
    assert.match(await page.locator(".terminal-ts").first().innerText(), /\d{2}:\d{2}:\d{2}\.\d{3}/);
    await page.fill(".logs-search input", "checkpoint");
    await page.waitForFunction(() => document.querySelector(".terminal-frame")?.textContent?.includes("checkpoint saved"));
    await page.getByRole("button", { name: "Artifacts" }).click();
    await page.waitForFunction(() => document.querySelector(".evidence-panel")?.textContent?.includes("eval/samples"));
    assert.ok(objectUrls.length > objectRequestsBeforeSeedDetail, "Artifacts tab should fetch active-run rich objects when opened");
    assert.ok(await page.locator(".evidence-row.active").count() > 0, "Artifacts tab should select a bounded evidence item");
    await page.fill(".evidence-search input", "eval/samples");
    await page.locator(".evidence-row", { hasText: "eval/samples" }).click();
    await page.waitForSelector(".rich-object-card.kind-table", { timeout: 10000 });
    const tablePreviewSize = await page.locator(".rich-object-card.kind-table .rich-table-preview").first().evaluate((node) => ({
      cells: node.querySelectorAll("span").length,
      headers: node.querySelectorAll("strong").length,
    }));
    assert.ok(tablePreviewSize.headers <= 8, `table preview should cap columns, got ${tablePreviewSize.headers}`);
    assert.ok(tablePreviewSize.cells <= 160, `table preview should cap cells, got ${tablePreviewSize.cells}`);
    await page.fill(".evidence-search input", "eval/classification");
    await page.locator(".evidence-row", { hasText: "eval/classification" }).click();
    await page.waitForSelector(".rich-object-card.kind-classification_eval .classification-eval-preview", { timeout: 10000 });
    const evalPreviewText = await page.locator(".rich-object-card.kind-classification_eval").innerText();
    assert.match(evalPreviewText, /\bPR\b/);
    assert.match(evalPreviewText, /\bROC\b/);
    assert.match(evalPreviewText, /Pred negative/);
    assert.match(evalPreviewText, /Class\s+Precision\s+Recall\s+F1/);
    if (docsScreenshotMode) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: path.join(docsProductDir, "dashboard-artifacts-evidence.png") });
      await page.setViewportSize({ width: 1440, height: 1100 });
    }
    await page.locator(".run-workspace-tabs").getByRole("button", { name: "Overview" }).click();
    await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("qa-checkpoint.json"));
    const forkName = `ui-smoke-fork-${Date.now()}`;
    const forkRequestsBefore = forkRequests.length;
    await page.getByRole("button", { name: /^Fork qa-checkpoint\.json$/ }).click();
    await page.waitForSelector(".checkpoint-fork-modal", { timeout: 10000 });
    assert.match(await page.locator(".checkpoint-fork-modal").innerText(), /does not start training/);
    await page.fill("#fork-run-name", forkName);
    await page.locator(".checkpoint-fork-modal textarea").fill("UI smoke retry");
    await Promise.all([
      page.waitForResponse((response) => (
        response.request().method() === "POST"
          && response.url().includes("/api/runs/")
          && response.url().endsWith("/forks")
          && response.status() === 200
      )),
      page.locator(".checkpoint-fork-modal").getByRole("button", { name: /Create Fork/ }).click(),
    ]);
    await page.waitForFunction(
      (name) => document.querySelector(".run-workspace-name")?.textContent?.includes(name),
      forkName,
    );
    await page.waitForFunction(() => document.querySelector(".run-workspace-tab.active")?.textContent?.includes("Lineage"));
    await page.waitForFunction(() => {
      const text = document.querySelector(".graph-panel")?.textContent ?? "";
      return text.includes("Parent") && text.includes("qa-checkpoint.json") && text.includes("No direct children yet.");
    }).catch(async (error) => {
      const state = await page.evaluate(() => ({
        activeRunTab: document.querySelector(".run-workspace-tab.active")?.textContent ?? "",
        detailSnippet: document.querySelector("#run-detail")?.textContent?.slice(0, 1000) ?? "",
        graphSnippet: document.querySelector(".graph-panel")?.textContent?.slice(0, 1000) ?? "",
      }));
      throw new Error(`checkpoint fork lineage did not render; state=${JSON.stringify(state)}: ${error.message}`);
    });
    assert.equal(forkRequests.length, forkRequestsBefore + 1, "checkpoint fork should submit exactly one request");
    assert.match(forkRequests.at(-1).headers["idempotency-key"], /^instantml-fork-[0-9a-f]{32}$/);
  } else {
    await page.getByRole("button", { name: "Artifacts" }).click();
    await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("No evidence logged"));
  }
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
  await page.fill("#search", "reward stability");
  await page.waitForFunction(() => document.querySelector(".workspace-run-note")?.textContent?.includes("reward stability"));
  assert.match(await page.locator(".workspace-run-list").innerText(), /reward stability/i);
  await page.fill("#search", "");
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });

  await page.locator(".runs-commandbar").getByRole("button", { name: "Runs actions" }).click();
  await page.locator(".runs-actions-popover").getByRole("button", { name: "Columns" }).click();
  await page.waitForSelector("#columns-popover");
  await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").uncheck();
  assert.equal(await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").isChecked(), false);
  await page.fill("#column-metric-filter", "train/.*");
  const lossMetricCheckbox = page.locator("#columns-popover").getByRole("checkbox", { name: "Pin train/loss" });
  await lossMetricCheckbox.check();
  assert.equal(await lossMetricCheckbox.isChecked(), true);
  await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").check();
  assert.equal(await page.locator("#columns-popover label", { hasText: "Tags" }).locator("input").isChecked(), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#columns-popover"));

  await page.fill("#search", "no-such-training-run");
  await page.waitForSelector(".workspace-run-list .compact-empty");
  assert.match(await page.locator(".workspace-run-list .compact-empty").innerText(), /No runs match/);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await chooseSelect(page, "#project-filter", "demo");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.includes("matching runs"));
  await page.waitForSelector(".workspace-panel-card", { timeout: 15000 });

  const generatedPanelCount = await page.locator(".workspace-panel-card").count();
  assert.ok(generatedPanelCount >= 3, `expected generated metric panels, got ${generatedPanelCount}`);
  await page.fill("#panel-search", "loss");
  await page.waitForFunction(() => {
    const panels = [...document.querySelectorAll(".workspace-panel-card h3")];
    return panels.length > 0 && panels.every((node) => /loss/i.test(node.textContent ?? ""));
  });
  await page.fill("#panel-search", "");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).click();
  await page.waitForSelector(".panel-drawer");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".panel-drawer"));
  await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).click();
  await page.waitForSelector(".panel-drawer");
  await page.getByRole("button", { name: "Scatter" }).click();
  await page.waitForFunction(() => document.querySelector(".chart-type-segment button.active")?.textContent?.includes("Scatter"));
  await page.locator(".drawer-metric-row").first().click();
  const scatterCard = page.locator(".workspace-panel-card").filter({ has: page.locator(".scatter-panel-chart") }).first();
  await scatterCard.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await scatterCard.innerText(), /Scatter|Summary values|plotted/);
  await page.waitForFunction(() => !document.querySelector(".panel-drawer") && document.querySelector("#status-message")?.textContent?.includes("Undo"));
  await page.keyboard.press(`${commandKey}+Z`);
  await page.waitForFunction((count) => document.querySelectorAll(".workspace-panel-card").length === count, generatedPanelCount);
  await page.keyboard.press(`${commandKey}+Shift+Z`);
  await scatterCard.waitFor({ state: "visible", timeout: 10000 });
  await scatterCard.hover();
  const actionOpacity = await scatterCard.locator(".panel-card-actions").evaluate((node) => getComputedStyle(node).opacity);
  assert.ok(Number(actionOpacity) > 0.5, `panel actions should stay visible enough to avoid invisible destructive targets, got ${actionOpacity}`);
  await openPanelMenu(scatterCard);
  await scatterCard.locator('button[aria-label^="Edit"]').click();
  await page.waitForSelector(".edit-drawer");
  assert.equal(await page.locator("#edit-panel-x-field").count(), 1);
  assert.equal(await page.locator("#edit-panel-y-field").count(), 1);
  const scatterFieldOptionCount = await page.locator("#edit-panel-y-field option").count();
  assert.ok(scatterFieldOptionCount >= 2, `expected editable scatter X/Y fields, got ${scatterFieldOptionCount}`);
  await chooseSelect(page, "#edit-panel-x-field", { index: 0 });
  await chooseSelect(page, "#edit-panel-y-field", { index: 1 });
  const editedScatterFields = await page.evaluate(() => ({
    x: document.querySelector("#edit-panel-x-field")?.value,
    y: document.querySelector("#edit-panel-y-field")?.value,
  }));
  assert.notEqual(editedScatterFields.x, editedScatterFields.y, "scatter smoke should exercise distinct X and Y fields");
  const panelCountBeforeEditTab = await page.locator(".workspace-panel-card").count();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".edit-drawer").count(), 1);
  assert.equal(await page.locator(".workspace-panel-card").count(), panelCountBeforeEditTab);
  const scatterPanelTitle = docsScreenshotMode ? "Learning-rate sweep" : "Smoke panel";
  await page.fill('.edit-drawer label:has-text("Title") input', scatterPanelTitle);
  await page.waitForFunction((title) => [...document.querySelectorAll(".workspace-panel-card h3")].some((node) => node.textContent?.includes(title)), scatterPanelTitle);
  await page.locator(".edit-drawer").getByRole("button", { name: "Close edit panel" }).click();
  await scatterCard.waitFor({ state: "visible", timeout: 10000 });
  await scatterCard.hover();
  await openPanelMenu(scatterCard);
  await scatterCard.locator('button[aria-label^="Fullscreen"]').click();
  await page.waitForSelector(".fullscreen-panel-card .scatter-panel-chart", { timeout: 10000 });
  await page.locator(".fullscreen-modal").getByRole("button", { name: "Close fullscreen panel" }).click();
  await page.waitForFunction(() => !document.querySelector(".fullscreen-modal"));
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(250);
  await page.reload({ waitUntil: "domcontentloaded" });
  await scatterCard.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await scatterCard.innerText(), new RegExp(`${escapeRegExp(scatterPanelTitle)}|Scatter|Summary values`));
  await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).click();
  await page.waitForSelector(".panel-drawer");
  await page.locator(".chart-type-segment").getByRole("button", { name: "Distribution", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".chart-type-segment button.active")?.textContent?.includes("Distribution"));
  await page.locator(".drawer-metric-row", { hasText: "eval/return_mean" }).first().click();
  const distributionCard = page.locator(".workspace-panel-card").filter({ has: page.locator(".distribution-panel-chart") }).first();
  await distributionCard.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await distributionCard.innerText(), /Distribution|Visible-sample distribution|plotted/);
  if (docsScreenshotMode) {
    await page.fill("#search", "");
    await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
    await chooseSelect(page, "#sort-select", "metric-best");
    await page.waitForFunction(() => {
      const firstRun = document.querySelector(".workspace-run-open")?.getAttribute("aria-label") ?? "";
      const status = document.querySelector("#status-message")?.textContent ?? "";
      return document.querySelector("#sort-select")?.value === "metric-best"
        && firstRun.startsWith("Open rl-ppo")
        && !/loading/i.test(status);
    });
    const clearSelected = page.locator(".workspace-run-rail").getByText(/^Clear \d+/);
    if (await clearSelected.count()) {
      await clearSelected.first().click();
      await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row.selected").length === 0);
    }
    await page.locator("#panel-search").evaluate((input) => {
      input.blur();
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(docsProductDir, "dashboard-runs.png") });
    await page.setViewportSize({ width: 1440, height: 1100 });
  }
  await distributionCard.hover();
  await openPanelMenu(distributionCard);
  await distributionCard.locator('button[aria-label^="Edit"]').click();
  await page.waitForSelector(".edit-drawer");
  assert.equal(await page.locator("#edit-panel-value-field").count(), 1);
  assert.equal(await page.locator("#edit-panel-group-field").count(), 1);
  assert.equal(await page.locator("#edit-panel-replicate-field").count(), 1);
  const distributionGroupOptionCount = await page.locator("#edit-panel-group-field option").count();
  assert.ok(distributionGroupOptionCount >= 2, `expected editable distribution grouping fields, got ${distributionGroupOptionCount}`);
  await page.locator(".edit-drawer").getByRole("button", { name: "Close edit panel" }).click();
  await distributionCard.hover();
  await openPanelMenu(distributionCard);
  await distributionCard.locator('button[aria-label^="Fullscreen"]').click();
  await page.waitForSelector(".fullscreen-panel-card .distribution-panel-chart", { timeout: 10000 });
  const fullscreenDistributionText = await page.locator(".fullscreen-panel-card").innerText();
  assert.match(fullscreenDistributionText, /Distribution|Visible-sample distribution|plotted/);
  await page.locator(".fullscreen-modal").getByRole("button", { name: "Close fullscreen panel" }).click();
  await page.waitForFunction(() => !document.querySelector(".fullscreen-modal"));
  await page.fill("#search", 'name:"rl-ppo-seed-44"');
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("rl-ppo-seed-44"));
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("rl-ppo-seed-44"));
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
  await waitForStableCount(page, () => objectUrls.length, 750, 5000);
  const histogramObjectRequestsBefore = objectUrls.length;
  await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).click();
  await page.waitForSelector(".panel-drawer");
  await page.locator(".chart-type-segment").getByRole("button", { name: "Logged histogram timeline", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".chart-type-segment button.active")?.textContent?.includes("Logged histogram timeline"));
  await page.getByLabel("Histogram object key to add").fill("eval/score_distribution");
  await page.locator(".quick-add-card").click();
  const histogramTimelineCard = page.locator(".workspace-panel-card").filter({ has: page.locator(".histogram-timeline-panel-chart") }).first();
  await histogramTimelineCard.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll(".workspace-panel-card")]
      .find((node) => node.querySelector(".histogram-timeline-panel-chart"));
    const text = card?.textContent ?? "";
    return text.includes("3 frames") && text.includes("Compatible bins");
  });
  await waitForStableCount(page, () => objectUrls.length, 500, 5000);
  const histogramObjectRequests = objectUrls.slice(histogramObjectRequestsBefore)
    .filter((url) => url.includes("/api/runs/") && url.includes("/objects"))
    .map((url) => new URL(url));
  const scoreDistributionRequests = histogramObjectRequests
    .filter((url) => url.searchParams.get("key") === "eval/score_distribution");
  assert.ok(scoreDistributionRequests.length >= 1, `histogram timeline should make a selected-run object request, saw ${histogramObjectRequests.map((url) => url.toString()).join(", ")}`);
  assert.equal(
    new Set(scoreDistributionRequests.map((url) => url.pathname)).size,
    1,
    `histogram timeline should not fan out across runs, saw ${scoreDistributionRequests.map((url) => url.toString()).join(", ")}`,
  );
  assert.ok(
    histogramObjectRequests.every((url) => url.searchParams.get("key") === "eval/score_distribution"),
    `histogram timeline should only request the explicit object key, saw ${histogramObjectRequests.map((url) => url.toString()).join(", ")}`,
  );
  assert.equal(scoreDistributionRequests[0].searchParams.get("kind"), "histogram");
  assert.equal(scoreDistributionRequests[0].searchParams.get("limit"), "100");
  await histogramTimelineCard.hover();
  await openPanelMenu(histogramTimelineCard);
  await histogramTimelineCard.locator('button[aria-label^="Edit"]').click();
  await page.waitForSelector(".edit-drawer");
  assert.equal(await page.getByLabel("Histogram object key").inputValue(), "eval/score_distribution");
  await page.locator(".edit-drawer").getByRole("button", { name: "Close edit panel" }).click();
  await histogramTimelineCard.hover();
  await openPanelMenu(histogramTimelineCard);
  await histogramTimelineCard.locator('button[aria-label^="Fullscreen"]').click();
  await page.waitForSelector(".fullscreen-panel-card .histogram-timeline-panel-chart", { timeout: 10000 });
  assert.match(await page.locator(".fullscreen-panel-card").innerText(), /3 frames|Compatible bins/);
  if (docsScreenshotMode) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(docsProductDir, "dashboard-logged-histogram.png") });
    await page.setViewportSize({ width: 1440, height: 1100 });
  }
  await page.locator(".fullscreen-modal").getByRole("button", { name: "Close fullscreen panel" }).click();
  await page.waitForFunction(() => !document.querySelector(".fullscreen-modal"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".workspace-panel-card .scatter-panel-chart", { timeout: 15000 });
  await page.waitForSelector(".workspace-panel-card .distribution-panel-chart", { timeout: 15000 });
  await page.waitForSelector(".workspace-panel-card .histogram-timeline-panel-chart", { timeout: 15000 });
  await page.fill("#search", "");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row").length >= 6);
  await page.locator(".workspace-section .section-title-button").first().click();
  await page.waitForFunction(() => document.querySelector(".workspace-section")?.classList.contains("collapsed"));
  await page.locator(".workspace-section .section-title-button").first().click();
  await page.waitForSelector(".workspace-panel-card", { timeout: 10000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Rebuild layout" }).click();
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
  await page.getByRole("button", { name: "Rebuild layout" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".workspace-panel-card").length >= 3);
  await page.evaluate(() => window.scrollTo(0, 0));

  const firstWorkspacePanel = page.locator(".workspace-panel-card").filter({ has: page.locator(".metric-chart-frame") }).first();
  await firstWorkspacePanel.waitFor({ state: "visible", timeout: 10000 });
  await firstWorkspacePanel.scrollIntoViewIfNeeded();
  const startingLayout = await firstWorkspacePanel.evaluate((node) => ({
    h: Number(node.dataset.panelHeight),
    w: Number(node.dataset.panelWidth),
  }));
  await firstWorkspacePanel.evaluate((node) => {
    node.setAttribute("data-smoke-resize-target", "true");
  });
  const startingGeometry = await firstWorkspacePanel.evaluate((card) => {
    const grid = card.closest(".workspace-panel-grid");
    const chartArea = card.querySelector(".chart-area");
    const frame = card.querySelector(".metric-chart-frame");
    const legend = card.querySelector(".chart-legend");
    const handle = card.querySelector(".panel-resize-handle");
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width };
    };
    const handleBox = rect(handle);
    const rowHeight = Number.parseFloat(getComputedStyle(grid).gridAutoRows);
    const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap);
    const expectedPanelHeight = Number(card.dataset.panelHeight) * rowHeight + (Number(card.dataset.panelHeight) - 1) * rowGap;
    const hit = document.elementFromPoint(handleBox.left + handleBox.width / 2, handleBox.top + handleBox.height / 2);
    const frameBox = rect(frame);
    const legendBox = rect(legend);
    const chartAreaBox = rect(chartArea);
    return {
      chartArea: chartAreaBox,
      expectedPanelHeight,
      frame: frameBox,
      frameAspect: getComputedStyle(frame).aspectRatio,
      handle: handleBox,
      handleHitClass: hit?.className ?? "",
      handleZIndex: getComputedStyle(handle).zIndex,
      legendColumns: getComputedStyle(legend).gridTemplateColumns.split(" ").filter(Boolean).length,
      legendHeight: legendBox.height,
      lowerDeadSpace: chartAreaBox.bottom - Math.max(frameBox.bottom, legendBox.bottom),
      panel: rect(card),
      rows: getComputedStyle(grid).gridAutoRows,
    };
  });
  assert.equal(startingGeometry.rows, "78px");
  assert.ok(Math.abs(startingGeometry.panel.height - startingGeometry.expectedPanelHeight) <= 4, `workspace panel height ${startingGeometry.panel.height} should follow grid span ${startingGeometry.expectedPanelHeight}`);
  assert.equal(startingGeometry.frameAspect, "auto");
  assert.match(String(startingGeometry.handleHitClass), /panel-resize-handle/, "resize handle should be the topmost hit target at its center");
  assert.equal(startingGeometry.handleZIndex, "12");
  assert.ok(startingGeometry.legendColumns >= 3, `workspace legend should compact across the panel, got ${startingGeometry.legendColumns} columns`);
  assert.ok(startingGeometry.legendHeight <= 60, `workspace legend should not starve the chart, got ${startingGeometry.legendHeight}`);
  assert.ok(startingGeometry.frame.height >= 80, `workspace chart frame should stay usable, got ${startingGeometry.frame.height}`);
  assert.ok(startingGeometry.lowerDeadSpace <= 24, `workspace chart should not leave a large bottom gutter, got ${startingGeometry.lowerDeadSpace}`);
  const resizeBox = await firstWorkspacePanel.locator(".panel-resize-handle").boundingBox();
  assert.ok(resizeBox, "expected workspace panel resize handle");
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 180, resizeBox.y + resizeBox.height / 2 + 170, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((start) => {
    const card = document.querySelector('[data-smoke-resize-target="true"]');
    return Boolean(card) && (Number(card.dataset.panelWidth) > start.w || Number(card.dataset.panelHeight) > start.h);
  }, startingLayout);
  const resizedGeometry = await firstWorkspacePanel.evaluate((card) => {
    const grid = card.closest(".workspace-panel-grid");
    const frame = card.querySelector(".metric-chart-frame");
    const handle = card.querySelector(".panel-resize-handle");
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width };
    };
    const rowHeight = Number.parseFloat(getComputedStyle(grid).gridAutoRows);
    const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap);
    const rowSpan = Number(card.dataset.panelHeight);
    return {
      expectedPanelHeight: rowSpan * rowHeight + (rowSpan - 1) * rowGap,
      frame: rect(frame),
      handle: rect(handle),
      panel: rect(card),
      rowSpan,
      widthSpan: Number(card.dataset.panelWidth),
    };
  });
  assert.ok(
    resizedGeometry.rowSpan > startingLayout.h || resizedGeometry.widthSpan > startingLayout.w,
    `resize should increase width or height from ${JSON.stringify(startingLayout)} to ${JSON.stringify({ h: resizedGeometry.rowSpan, w: resizedGeometry.widthSpan })}`,
  );
  assert.ok(Math.abs(resizedGeometry.panel.height - resizedGeometry.expectedPanelHeight) <= 4, `resized panel height ${resizedGeometry.panel.height} should follow grid span ${resizedGeometry.expectedPanelHeight}`);
  assert.ok(resizedGeometry.frame.height > startingGeometry.frame.height, "chart frame should grow when the panel is resized taller");
  await page.getByRole("button", { name: "Rebuild layout" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".workspace-panel-card").length >= 3);

  const visibleRunChecks = page.locator(".workspace-run-row");
  const visibleRunCheckCount = await visibleRunChecks.count();
  const selectedVisibleBefore = await page.locator(".workspace-run-row.selected").count();
  const selectAllVisibleControl = page.locator(".workspace-rail-select-all input");
  if (visibleRunCheckCount > 0) {
    if (selectedVisibleBefore === visibleRunCheckCount) {
      await selectAllVisibleControl.click();
    } else {
      await selectAllVisibleControl.click();
      await selectAllVisibleControl.click();
    }
    await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row.selected").length === 0);
  }
  const selectedRunCheckTarget = Math.min(6, visibleRunCheckCount);
  for (let index = 0; index < selectedRunCheckTarget; index += 1) {
    const selectButton = visibleRunChecks.nth(index).locator(".workspace-run-select");
    if ((await selectButton.getAttribute("aria-pressed")) !== "true") await selectButton.click();
  }
  let selectedRunPanel = page.locator(".workspace-panel-card").filter({ hasText: "train/loss" }).first();
  await selectedRunPanel.waitFor({ state: "visible", timeout: 10000 });
  await selectedRunPanel.evaluate((node) => node.setAttribute("data-smoke-loss-panel", "true"));
  selectedRunPanel = page.locator('[data-smoke-loss-panel="true"]');
  await page.waitForFunction((target) => {
    const card = document.querySelector('[data-smoke-loss-panel="true"]');
    return card?.querySelector(".workspace-panel-meta")?.textContent?.includes(`${target} selected`);
  }, selectedRunCheckTarget);
  await page.waitForFunction((target) => {
    const card = document.querySelector('[data-smoke-loss-panel="true"]');
    const seriesCount = card?.querySelectorAll(".metric-chart .series").length ?? 0;
    return seriesCount > 0 && seriesCount <= target;
  }, selectedRunCheckTarget);
  const workspacePanelSeriesCount = await selectedRunPanel.locator(".metric-chart .series").count();
  assert.ok(workspacePanelSeriesCount > 0 && workspacePanelSeriesCount <= selectedRunCheckTarget);
  assert.equal(await selectedRunPanel.locator(".chart-legend .legend-chip:not(.legend-overflow)").count(), workspacePanelSeriesCount);
  if (selectedRunCheckTarget >= 2) {
    await visibleRunChecks.nth(0).locator(".workspace-run-select").click();
    await visibleRunChecks.nth(1).locator(".workspace-run-select").click();
    await page.waitForFunction(
      (target) => document.querySelectorAll(".workspace-run-row.selected").length === target,
      selectedRunCheckTarget - 2,
    );
  }
  if (selectedRunCheckTarget >= 2) {
    await visibleRunChecks.nth(0).locator(".workspace-run-select").click();
    await visibleRunChecks.nth(1).locator(".workspace-run-select").click();
    await page.waitForFunction((target) => {
      const card = document.querySelector('[data-smoke-loss-panel="true"]');
      const seriesCount = card?.querySelectorAll(".metric-chart .series").length ?? 0;
      return card?.querySelector(".workspace-panel-meta")?.textContent?.includes(`${target} selected`)
        && seriesCount > 0 && seriesCount <= target
        && card?.querySelectorAll(".chart-legend .legend-chip:not(.legend-overflow)").length === seriesCount;
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
  assert.match(workspaceTooltipText, /(llm|rl)-.+-seed-|page-run-\d+/);
  assert.match(workspaceTooltipText, /\d/);

  await page.fill("#search", "");
  await chooseSelect(page, "#project-filter", "demo");
  const clearWorkspaceSelection = page.locator(".workspace-rail-page-select .link-button", { hasText: /^Clear/ }).first();
  if ((await clearWorkspaceSelection.count()) > 0) await clearWorkspaceSelection.click();
  await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row.selected").length === 0);
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-smoke-loss-panel="true"]');
    const pointCount = card?.querySelectorAll(".metric-chart .series-point").length ?? 0;
    const text = card?.textContent ?? "";
    return pointCount >= 2 && !text.includes("No logged series");
  });
  await selectedRunPanel.hover();
  await openPanelMenu(selectedRunPanel);
  await selectedRunPanel.locator('button[aria-label^="Edit"]').click();
  await page.waitForSelector(".edit-drawer");
  await chooseSelect(page, "#edit-panel-x", "step");
  await page.locator(".edit-drawer").getByRole("button", { name: "Close edit panel" }).click();
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-smoke-loss-panel="true"]');
    return card?.querySelector(".workspace-panel-meta")?.textContent?.includes("Step");
  });
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-smoke-loss-panel="true"]');
    const pointCount = card?.querySelectorAll(".metric-chart .series-point").length ?? 0;
    const text = card?.textContent ?? "";
    return pointCount >= 2 && !text.includes("No logged series");
  });
  await selectedRunPanel.hover();
  await openPanelMenu(selectedRunPanel);
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
  await page.locator(".fullscreen-modal .chart-range svg").first().evaluate((svg) => {
    const rect = svg.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const start = rect.left - 8;
    const end = rect.left + rect.width * 0.58;
    const pointerInit = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      clientY: y,
    };
    svg.dispatchEvent(new PointerEvent("pointerdown", { ...pointerInit, clientX: start }));
    svg.dispatchEvent(new PointerEvent("pointermove", { ...pointerInit, clientX: end }));
    svg.dispatchEvent(new PointerEvent("pointerup", { ...pointerInit, buttons: 0, clientX: end }));
  });
  let zoomResetVisible = await page.locator(".fullscreen-modal .chart-zoom-reset").waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
  if (!zoomResetVisible) {
    await page.mouse.move(fullscreenRangeBox.x - 8, fullscreenRangeBox.y + fullscreenRangeBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.move(fullscreenRangeBox.x + fullscreenRangeBox.width * 0.58, fullscreenRangeBox.y + fullscreenRangeBox.height / 2, { steps: 8 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    zoomResetVisible = await page.locator(".fullscreen-modal .chart-zoom-reset").waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
  }
  if (!zoomResetVisible) {
    const zoomDebug = await page.locator(".fullscreen-modal-card").evaluate((modal) => {
      const range = modal.querySelector(".chart-range");
      const rangeWindow = modal.querySelector(".range-window");
      const svg = modal.querySelector(".chart-range svg");
      const svgRect = svg?.getBoundingClientRect();
      const axisLabels = [...modal.querySelectorAll(".axis-label")].map((node) => node.textContent ?? "");
      const seriesPoints = [...modal.querySelectorAll(".series-point")].slice(0, 6).map((node) => ({
        cx: node.getAttribute("cx"),
        cy: node.getAttribute("cy"),
      }));
      const centerHit = svgRect ? document.elementFromPoint(svgRect.left + svgRect.width / 2, svgRect.top + svgRect.height / 2) : null;
      return {
        axisLabels,
        cardText: modal.textContent?.slice(0, 700) ?? "",
        centerHitClass: centerHit instanceof Element ? centerHit.getAttribute("class") : null,
        rangeText: range?.textContent ?? "",
        rangeWindowWidth: rangeWindow instanceof SVGGraphicsElement ? rangeWindow.getBBox().width : null,
        resetCount: modal.querySelectorAll(".chart-zoom-reset").length,
        seriesPoints,
        svgRect: svgRect ? { height: svgRect.height, width: svgRect.width } : null,
      };
    });
    assert.fail(`dragging the fullscreen range brush should expose the reset zoom control; state=${JSON.stringify(zoomDebug)}`);
  }
  const firstFullscreenTitle = await page.locator(".workspace-modal .drawer-head h2").innerText();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((title) => document.querySelector(".workspace-modal .drawer-head h2")?.textContent !== title, firstFullscreenTitle);
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction((title) => document.querySelector(".workspace-modal .drawer-head h2")?.textContent === title, firstFullscreenTitle);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".workspace-modal"));

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.fill("#search", "");
  await chooseSelect(page, "#project-filter", "");
  await chooseSelect(page, "#sort-select", "metric-best");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row").length >= 2).catch(async (error) => {
    const state = await page.evaluate(() => ({
      activeTab: document.querySelector(".tab-button.active")?.textContent?.trim() ?? "",
      rows: document.querySelectorAll(".workspace-run-row").length,
      search: document.querySelector("#search")?.value ?? "",
      sort: document.querySelector("#sort-select")?.value ?? "",
      status: document.querySelector("#status-message")?.textContent ?? "",
      listText: document.querySelector(".workspace-run-list")?.textContent?.slice(0, 500) ?? "",
      message: document.querySelector(".message")?.textContent ?? "",
    }));
    throw new Error(`Runs list did not restore after fullscreen close; state=${JSON.stringify(state)}: ${error.message}`);
  });
  await selectVisibleRunForMetrics(page);

  await page.getByRole("link", { name: /Metrics/ }).click();
  await page.waitForFunction(() => document.querySelector(".tab-pane.active")?.textContent?.includes("Metric browser"));
  await page.waitForFunction(() => document.querySelector(".tab-pane.active")?.textContent?.includes("Series"));
  await page.fill("#metric-filter", "train/.*");
  await page.waitForFunction(() => [...document.querySelectorAll("#metric-select option")].some((option) => option.textContent === "train/loss"));
  await chooseSelect(page, "#metric-select", "train/loss");
  await page.waitForFunction(() => document.querySelector("#metric-select")?.value === "train/loss");
  const pinMetric = page.locator("#pin-metric");
  if (!(await pinMetric.innerText()).includes("Pinned")) await pinMetric.click();
  await chooseSelect(page, "#group-select", "seed");
  await page.locator("#x-mode-time").click();
  await page.waitForFunction(() => document.querySelector("#x-mode-time")?.getAttribute("aria-pressed") === "true");
  await page.locator("#smoothing").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("#smoothing")?.value === "10");
  await page.waitForFunction(() => document.querySelectorAll(".tab-pane.active .series-smooth").length > 0);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("#smoothing")?.value === "20");
  await page.check("#group-average");
  await page.waitForSelector(".tab-pane.active .series-point", { timeout: 10000 });
  await page.locator(".tab-pane.active .series-point").first().hover({ force: true });
  await page.waitForSelector(".tab-pane.active .chart-tooltip", { timeout: 10000 });
  const metricsReadoutText = await page.locator(".tab-pane.active .chart-tooltip").innerText();
  assert.match(metricsReadoutText, /Raw \/ EMA/i);
  assert.match(metricsReadoutText, /EMA/);

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-open", { state: "visible", timeout: 10000 });
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Run tags and notes"));
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("Timeline"));
  await page.locator(".run-workspace-tabs").getByRole("button", { name: /Metrics/ }).click();
  await page.waitForSelector(".pd-data-panel");
  await page.locator(".run-workspace-tabs").getByRole("button", { name: "Overview" }).click();
  const detailMetadataEditor = page.locator("#run-detail .run-metadata-editor").first();
  await detailMetadataEditor.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await detailMetadataEditor.innerText(), /Run tags and notes/);
  await detailMetadataEditor.getByRole("button", { name: /Edit/ }).click();
  await detailMetadataEditor.locator(".tag-textarea").first().fill("qa-smoke, reviewed, note-search");
  await page.waitForFunction(() => document.querySelector("#run-detail .metadata-tag-preview")?.textContent?.includes("note-search"));
  await detailMetadataEditor.locator(".notes-control textarea").first().fill("qa-note-smoke searchable detail note");
  await detailMetadataEditor.getByRole("button", { name: /Save/ }).click();
  await page.waitForFunction(() => document.querySelector("#run-detail .run-metadata-editor")?.textContent?.includes("qa-note-smoke searchable detail note"));
  await page.getByRole("button", { name: "Artifacts" }).click();
  await page.waitForSelector(".evidence-panel", { timeout: 10000 });
  assert.match(await page.locator(".evidence-panel").innerText(), /Checkpoints|No evidence logged/i);
  await page.getByRole("button", { name: "Overview" }).click();
  assert.doesNotMatch(await page.locator("#run-detail").innerText(), /Hovered point/);

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
  await page.getByRole("button", { name: "Run search syntax" }).click();
  await page.waitForSelector("#run-search-help", { timeout: 10000 });
  assert.match(await page.locator("#run-search-help").innerText(), /re:\/seed-\(13\|14\)\//);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#run-search-help", { state: "hidden", timeout: 10000 });
  let summaryResponse = await fillSearchAndWaitForSummary(page, "qa-note-smoke");
  assert.equal(summaryResponse.status(), 200);
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("qa-note-smoke"));
  assert.match(await page.locator(".workspace-run-list").innerText(), /qa-smoke/);
  const noteSearchText = await page.locator(".workspace-run-list").innerText();
  summaryResponse = await fillSearchAndWaitForSummary(page, "tag:note-search OR name:page-run-01");
  assert.equal(summaryResponse.status(), 200);
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("page-run-01"));
  const booleanSearchText = await page.locator(".workspace-run-list").innerText();
  assert.notEqual(booleanSearchText, noteSearchText, "boolean search should apply a new result set");
  assert.match(booleanSearchText, /note-search/);
  assert.match(booleanSearchText, /page-run-01/);
  if (backendMode !== "node") {
    summaryResponse = await fillSearchAndWaitForSummary(page, "re:/[/");
    assert.equal(summaryResponse.status(), 400);
    await page.waitForSelector("#run-search-error", { timeout: 10000 });
    assert.equal(await page.locator("#search").getAttribute("aria-invalid"), "true");
    assert.match(await page.locator("#run-search-error").innerText(), /Invalid run search/);
    assert.doesNotMatch(await page.locator("#run-search-error").innerText(), /Column \d+\. Column \d+\./);
  }
  summaryResponse = await fillSearchAndWaitForSummary(page, "re:/page-run-0[12]/");
  if (backendMode === "node") {
    assert.equal(summaryResponse.status(), 400);
    await page.waitForSelector("#run-search-error", { timeout: 10000 });
    assert.match(await page.locator("#run-search-error").innerText(), /Rust API only/);
  } else {
    assert.equal(summaryResponse.status(), 200);
    await page.waitForFunction(() => {
      const text = document.querySelector(".workspace-run-list")?.textContent ?? "";
      return text.includes("page-run-01") && text.includes("page-run-02") && !text.includes("qa-note-smoke");
    });
    const regexSearchText = await page.locator(".workspace-run-list").innerText();
    assert.match(regexSearchText, /page-run-01/);
    assert.match(regexSearchText, /page-run-02/);
    assert.doesNotMatch(regexSearchText, /qa-note-smoke/);
  }
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
  // Comparison now lives in the Runs → Table view: switching to it renders the
  // selected runs side by side inline (no separate Compare page or toast).
  await page.locator(".runs-view-switch").getByRole("button", { name: /Table/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("#reference-run option").length >= 2);
  await page.waitForSelector(".cmp-table");
  assert.equal(objectUrls.length, objectRequestsBeforeCompare, "Compare should not fan out rich-object requests");
  const referenceOptions = await page.locator("#reference-run option").count();
  assert.ok(referenceOptions >= 2);

  // The rows table is populated for the selected set.
  await page.waitForFunction(() => /seed|page-run|run-/.test(document.querySelector("#side-by-side")?.textContent ?? ""));

  // Picking a reference pins and tags that run's row.
  await chooseSelect(page, "#reference-run", { index: 1 });
  await page.locator(".cmp-row.reference").first().waitFor({ state: "visible", timeout: 10000 });
  assert.ok((await page.locator(".cmp-row.reference [title='Reference run']").count()) > 0, "reference row should expose the reference anchor");
  assert.ok((await page.locator("#side-by-side .cmp-status").count()) > 0, "rows table should expose each run's status pill");

  // Add a second metric column and sort by it.
  const compareMetricToAdd = await page.locator("#compare-add-metric option").nth(1).evaluate((option) => option.value);
  assert.ok(compareMetricToAdd, "compare add-metric select should expose at least one additional metric");
  const compareMetricLabel = compareMetricToAdd.split("/").pop() || compareMetricToAdd;
  const compareMetricDisplay = compareMetricLabel.replace(/[_-]/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
  await chooseSelect(page, "#compare-add-metric", { index: 1 });
  await page.waitForFunction((metric) => [...document.querySelectorAll(".compare-metric-label")]
    .some((node) => node.getAttribute("title") === metric), compareMetricToAdd);
  const addedMetricSort = page.locator("button.cmp-th").filter({ hasText: compareMetricDisplay }).first();
  await addedMetricSort.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await addedMetricSort.getAttribute("title"), compareMetricToAdd, `missing compare sort header for ${compareMetricToAdd}`);
  await addedMetricSort.click();
  await page.waitForFunction((metric) => document.querySelector("button.cmp-th.sorted")?.getAttribute("title") === metric, compareMetricToAdd);
  const compareRowText = await page.locator("#side-by-side").innerText();
  assert.match(compareRowText, /Run/i);
  assert.match(compareRowText, /Running|Finished|Failed|Stopped/i);
  assert.match(compareRowText, /Duration/i);
  assert.match(compareRowText, new RegExp(escapeRegExp(compareMetricDisplay), "i"));
  // Back to the panels view, then save a named view via the View actions menu.
  await page.locator(".runs-view-switch").getByRole("button", { name: /Panels/ }).click();
  await page.waitForSelector(".workspace-run-list");
  await page.getByRole("button", { name: "View actions" }).click();
  await page.waitForSelector("#view-name", { state: "visible", timeout: 10000 });
  await page.fill("#view-name", "demo-loss-review");
  await page.click("#save-view");
  await page.waitForFunction(() => [...document.querySelectorAll("#saved-view-select option")]
    .some((option) => option.textContent?.includes("demo-loss-review"))).catch(async (error) => {
      const state = await page.evaluate(() => ({
        options: [...document.querySelectorAll("#saved-view-select option")].map((option) => option.textContent),
        status: document.querySelector("#status-message")?.textContent ?? "",
      }));
      throw new Error(`saved view did not appear after save; state=${JSON.stringify(state)}: ${error.message}`);
    });

  await page.fill("#search", 'name:"rl-ppo-seed-44"');
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("seed-44"));
  await page.locator(".workspace-run-open").first().click();
  await page.waitForFunction(() => document.querySelector("#run-detail")?.textContent?.includes("rl-ppo-seed-44"));

  const tabChecks = [
    ["Run Health", "Run health"],
    ["Datasets", "Config-derived Datasets"],
    ["Artifacts", "Raw run artifacts"],
    ["Imports", "Dry run"],
    ["Insights", "Insights"],
    ["Reports", "Experiment writeups"],
    ["Settings", "Workspace"],
    ["API", "API Surface"],
  ];
  for (const [tab, expectedText] of tabChecks) {
    const objectsBeforeTabClick = objectUrls.length;
    await page.getByRole("link", { name: new RegExp(`^${tab}$`) }).click();
    await page.waitForFunction(
      (text) => document.querySelector(".tab-pane.active")?.textContent?.includes(text),
      expectedText,
    ).catch(async (error) => {
      const activeText = await page.locator(".tab-pane.active").innerText().catch(() => "");
      throw new Error(`tab ${tab} did not show ${expectedText}; active=${activeText.slice(0, 500)}: ${error.message}`);
    });
    if (tab === "Artifacts") {
      if (backendMode !== "node") {
        await page.waitForFunction(() => {
          const text = document.querySelector(".tab-pane.active")?.textContent ?? "";
          return text.includes("qa-preview.png") && text.includes("qa-checkpoint.json") && text.includes("Logged Objects");
        });
        assert.ok(objectUrls.length > objectsBeforeTabClick, "Artifacts tab should fetch selected-run rich objects");
      } else {
        await page.waitForFunction(() => /Logged Objects|No artifacts|No evidence/i.test(document.querySelector(".tab-pane.active")?.textContent ?? ""));
      }
    }
    if (tab === "API") {
      assert.ok(await page.locator(".tab-pane.active .copy-button").count() > 0);
    }
  }

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-row", { timeout: 10000 });
  let runsData = await page.evaluate(() => ({
    rows: document.querySelectorAll(".workspace-run-row").length,
    panels: document.querySelectorAll(".workspace-panel-card").length,
    sections: document.querySelectorAll(".workspace-section").length,
    sort: document.querySelector("#sort-select")?.value,
    notePreviews: [...document.querySelectorAll(".workspace-run-note")].map((node) => node.textContent ?? ""),
    tagPreviews: [...document.querySelectorAll(".workspace-run-tags")].map((node) => node.textContent ?? ""),
    tallRows: [...document.querySelectorAll(".workspace-run-row")].filter((row) => row.getBoundingClientRect().height > 120).length,
  }));
  await selectVisibleRunForMetrics(page);
  await page.getByRole("link", { name: /^Metrics$/ }).click();
  await page.waitForSelector(".tab-pane.active .metrics-analysis", { timeout: 10000 });
  await page.fill("#metric-filter", "");
  await page.waitForFunction(() => document.querySelectorAll(".tab-pane.active .mx-tree-leaf").length >= 3);
  await page.waitForFunction(() => [...document.querySelectorAll(".tab-pane.active .mx-tree-leaf")]
    .some((row) => /loss/i.test(row.textContent ?? "")));
  await page.locator(".tab-pane.active .mx-tree-leaf", { hasText: "loss" }).first().locator(".mx-tree-leaf-main").click();
  await page.waitForSelector(".tab-pane.active .metric-chart", { timeout: 10000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({
      activeTab: document.querySelector(".tab-button.active")?.textContent?.trim() ?? "",
      catalogRows: [...document.querySelectorAll(".tab-pane.active .mx-tree-leaf")].slice(0, 5).map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      empty: document.querySelector(".tab-pane.active .chart-area .empty")?.textContent ?? "",
      metricSelect: document.querySelector("#metric-select")?.textContent ?? "",
      tabText: document.querySelector(".tab-pane.active")?.textContent?.slice(0, 800) ?? "",
    }));
    throw new Error(`metrics chart did not render after selecting Loss; state=${JSON.stringify(state)}: ${error.message}`);
  });
  await page.waitForSelector(".tab-pane.active .metric-chart .series-point", { timeout: 10000 });
  const metricsData = await page.evaluate(() => ({
    chart: Boolean(document.querySelector(".tab-pane.active .metric-chart")),
    chartStrokeWidth: getComputedStyle(document.querySelector(".tab-pane.active .series")).strokeWidth,
    chartPointRadius: document.querySelector(".tab-pane.active .series-point")?.getAttribute("r") ?? "",
    points: document.querySelectorAll(".tab-pane.active .series-point").length,
    axisLabels: [...document.querySelectorAll(".tab-pane.active .axis-label")].map((node) => node.textContent),
    metricCatalogRows: document.querySelectorAll(".tab-pane.active .mx-tree-leaf").length,
    seriesRows: document.querySelectorAll(".tab-pane.active .mx-table tbody tr").length,
    seriesEmpty: document.querySelector(".tab-pane.active")?.textContent?.includes("No runs have logged") ?? false,
    controls: {
      group: document.querySelector("#group-select")?.value,
      x: document.querySelector("#x-mode-time")?.getAttribute("aria-pressed") === "true" ? "time" : "step",
      smooth: document.querySelector("#smoothing")?.value,
      average: document.querySelector("#group-average")?.checked,
    },
  }));
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await chooseSelect(page, "#project-filter", "demo");
  await page.fill("#search", 'name:"rl-ppo-seed-44"');
  await page.waitForFunction(() => document.querySelector(".workspace-run-open")?.getAttribute("aria-label")?.includes("rl-ppo-seed-44"));
  await page.locator(".workspace-run-open").first().click();
  await page.waitForSelector("#run-detail", { timeout: 10000 });
  await page.locator(".run-workspace-tabs").getByRole("button", { name: /Metrics/ }).click();
  await page.waitForSelector(".pd-data-panel", { timeout: 10000 });
  await page.waitForSelector(".pd-data-panel .metric-chart .series-point", { timeout: 10000 });
  const runDetailChart = await page.locator(".pd-data-panel .metric-chart .series-point").count() > 0;
  const runMetricRows = await page.locator(".pd-data-panel .metric-chart .series").count();
  await page.locator(".run-workspace-tabs").getByRole("button", { name: "Overview" }).click();
  const detailData = await page.evaluate((metricRows) => ({
    detail: document.querySelector("#run-detail")?.textContent ?? "",
    runTimelineRows: document.querySelectorAll(".tab-pane.active .pd-feed-row").length,
    runMetricRows: metricRows,
    runDetailChart: false,
  }), runMetricRows);
  detailData.runDetailChart = runDetailChart;
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.fill("#search", "");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row").length >= 4);
  runsData = await page.evaluate(() => ({
    rows: document.querySelectorAll(".workspace-run-row").length,
    panels: document.querySelectorAll(".workspace-panel-card").length,
    sections: document.querySelectorAll(".workspace-section").length,
    sort: document.querySelector("#sort-select")?.value,
    notePreviews: [...document.querySelectorAll(".workspace-run-note")].map((node) => node.textContent ?? ""),
    tagPreviews: [...document.querySelectorAll(".workspace-run-tags")].map((node) => node.textContent ?? ""),
    tallRows: [...document.querySelectorAll(".workspace-run-row")].filter((row) => row.getBoundingClientRect().height > 120).length,
  }));
  for (let index = 0; index < 4; index += 1) {
    const selectedForCompare = await page.locator(".workspace-run-row.selected").count();
    if (selectedForCompare >= 4) break;
    await page.locator(".workspace-run-row:not(.selected) .workspace-run-select").first().click();
    await page.waitForFunction((minimum) => document.querySelectorAll(".workspace-run-row.selected").length >= minimum, selectedForCompare + 1);
  }
  // Comparison lives in the Runs → Table view: switching to it renders the
  // restored multi-run selection side by side.
  await page.locator(".runs-view-switch").getByRole("button", { name: /Table/ }).click();
  await page.waitForSelector(".cmp-table", { timeout: 10000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({
      selectedRows: document.querySelectorAll(".workspace-run-row.selected, .runs-dtable tbody tr.selected").length,
      referenceOptions: document.querySelectorAll("#reference-run option").length,
      sideBySide: document.querySelector("#side-by-side")?.textContent?.slice(0, 800) ?? "",
      status: document.querySelector("#status-message")?.textContent ?? "",
    }));
    throw new Error(`compare table did not render after restoring multi-run selection; state=${JSON.stringify(state)}: ${error.message}`);
  });
  const compareData = await page.evaluate(() => ({
    sideBySide: document.querySelector("#side-by-side")?.textContent ?? "",
    compareTable: Boolean(document.querySelector(".cmp-table")),
  }));
  // Restore the panels view (run rail) for the responsive checks below.
  await page.locator(".runs-view-switch").getByRole("button", { name: /Panels/ }).click();
  await page.waitForSelector(".workspace-run-list");
  const data = await page.evaluate(() => ({
    title: document.title,
    brandLabel: document.querySelector(".brand, .brand-cell")?.getAttribute("aria-label"),
    brandMark: Boolean(document.querySelector(".instantml-mark-svg")),
    projectControl: Boolean(document.querySelector("#project-filter")),
    visibleBrandTitle: document.querySelector(".brand h1")?.textContent ?? null,
    navTabs: [...document.querySelectorAll(".tab-scroll .tab-button")].map((button) => button.textContent?.trim()),
  }));
  Object.assign(data, runsData, metricsData, detailData, compareData);
  assert.match(data.title, /InstantML$/);
  assert.equal(data.brandLabel, "InstantML");
  assert.equal(data.brandMark, true);
  assert.equal(data.projectControl, true);
  assert.ok(Number.parseFloat(data.chartStrokeWidth) <= 1.5, `chart lines should stay thin for overlap, got ${data.chartStrokeWidth}`);
  assert.ok(Number.parseFloat(data.chartPointRadius) <= 3.5, `chart markers should stay compact, got ${data.chartPointRadius}`);
  assert.equal(data.visibleBrandTitle, null);
  assert.deepEqual(data.navTabs, ["Runs", "Metrics", "Distributed", "Datasets", "Artifacts", "Insights", "Run Health", "Reports", "Settings", "API"]);
  assert.ok(data.rows >= 6);
  assert.equal(data.chart, true);
  assert.ok(data.points > 0);
  assert.ok(data.panels >= 3);
  assert.ok(data.sections >= 1);
  assert.ok(data.notePreviews.some((note) => /Synthetic|note/i.test(note)), "workspace rows should expose note previews");
  assert.ok(data.tagPreviews.some((tags) => /demo|qa-smoke|compare-smoke/i.test(tags)), "workspace rows should expose tag previews");
  assert.ok(data.metricCatalogRows >= 3);
  assert.ok(data.seriesRows >= 1 || data.seriesEmpty);
  assert.ok(data.runTimelineRows >= 3);
  assert.ok(data.runMetricRows >= 1);
  assert.equal(data.runDetailChart, true);
  assert.match(data.detail, /Summary table|Run tags and notes/);
  assert.match(data.detail, /tags and notes/i);
  assert.match(data.sideBySide, /seed/i);
  assert.equal(data.compareTable, true);
  assert.ok(data.savedViews.some((view) => view?.includes("demo-loss-review")));
  assert.deepEqual(
    { sort: data.sort, group: data.controls.group, x: data.controls.x, smooth: data.controls.smooth, average: data.controls.average },
    { sort: "metric-best", group: "seed", x: "time", smooth: "20", average: true },
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
  assert.match(midWidth.footer, /\d+-\d+ of \d+/);
  assert.ok(midWidth.visibleTabs >= 12);

  await page.setViewportSize({ width: 390, height: 820 });
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
  if (backendMode !== "node") {
    await assertOrganizationWorkspaceFlow(page, webBaseUrl, primaryOrgName, smokeId);
  }
  screenshotPath = path.join(dir, "ui-smoke.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  await browser.close();
  browser = null;
  let expectedNodeObject404s = backendMode === "node" ? objectNotFoundUrls.length : 0;
  await Promise.all(consoleErrorReads);
  const unexpectedErrors = errors.filter((error) => {
    if (expectedNodeObject404s > 0 && error === "Failed to load resource: the server responded with a status of 404 (Not Found)") {
      expectedNodeObject404s -= 1;
      return false;
    }
    if (expectedForbiddenResourceErrors > 0 && error === "Failed to load resource: the server responded with a status of 403 (Forbidden)") {
      expectedForbiddenResourceErrors -= 1;
      return false;
    }
    if (expectedBadRequestResourceErrors > 0 && error === "Failed to load resource: the server responded with a status of 400 (Bad Request)") {
      expectedBadRequestResourceErrors -= 1;
      return false;
    }
    if (expectedPaymentRequiredResourceErrors > 0 && error === "Failed to load resource: the server responded with a status of 402 (Payment Required)") {
      expectedPaymentRequiredResourceErrors -= 1;
      return false;
    }
    if (expectedServiceUnavailableResourceErrors > 0 && error === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)") {
      expectedServiceUnavailableResourceErrors -= 1;
      return false;
    }
    if (expectedServiceUnavailableApiErrors > 0 && isExpectedServiceUnavailableApiError(error)) {
      expectedServiceUnavailableApiErrors -= 1;
      return false;
    }
    if (expectedApiFailureConsoleErrors > 0 && isExpectedApiFailureConsoleError(error)) {
      expectedApiFailureConsoleErrors -= 1;
      return false;
    }
    if (expectedRateLimitResourceErrors > 0 && error === "Failed to load resource: the server responded with a status of 429 (Too Many Requests)") {
      expectedRateLimitResourceErrors -= 1;
      return false;
    }
    if (error.includes("Failed to execute 'writeText' on 'Clipboard': Write permission denied.")) return false;
    // The local-dev smoke signs in through InstantML's dev auth flow; Clerk's
    // optional browser bundle can fail independently when hosted env keys are
    // present on a machine without network access to Clerk.
    if (error.includes("TypeError: Failed to fetch") && error.includes("clerk.browser.js")) return false;
    return true;
  });
  assert.deepEqual(unexpectedForbiddenResourceUrls, []);
  assert.deepEqual(unexpectedPaymentRequiredResourceUrls, []);
  assert.deepEqual(unexpectedBadRequestResourceUrls, []);
  assert.deepEqual(unexpectedRateLimitResourceUrls, []);
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

async function captureDocScreenshots(page, webBaseUrl) {
  const cap = async (name, settleMs = 700) => {
    await page.waitForTimeout(settleMs);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(docsProductDir, name) });
    await page.setViewportSize({ width: 1440, height: 1100 });
  };
  const shot = async (name, fn) => {
    try {
      await fn();
      await cap(name);
      console.log(`[doc-shot] OK   ${name}`);
    } catch (err) {
      console.log(`[doc-shot] FAIL ${name}: ${String(err.message ?? err).split("\n")[0]}`);
    }
  };
  const gotoTab = async (tab, sel, timeout = 15000) => {
    await page.goto(`${webBaseUrl}/dashboard/${tab}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(sel, { timeout }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  };

  // Resolve a representative demo run id for detail-centric shots.
  let seedRunId = null;
  try {
    const summary = await pageApiGet(page, "/api/runs/summary?project=demo&limit=50");
    const runs = summary?.runs ?? summary?.data?.runs ?? [];
    const seed = runs.find((r) => (r.name || "").includes("seed-44")) || runs[0];
    seedRunId = seed?.id || seed?.run_id || null;
  } catch (err) {
    console.log(`[doc-shot] could not resolve seed run id: ${err.message}`);
  }

  // Best-effort extra seeding for data-heavy views.
  if (seedRunId) {
    try {
      for (const rank of [0, 1, 2, 3]) {
        await pageApiRequest(page, "POST", `/runs/${seedRunId}/rank-metrics`, {
          step: 0, rank, world_size: 4,
          metrics: { "train/loss": 0.4 - rank * 0.02, "train/grad_norm": 1.2 + rank * 0.1, "system/gpu_util": 80 + rank },
        });
        await pageApiRequest(page, "POST", `/runs/${seedRunId}/rank-metrics`, {
          step: 1, rank, world_size: 4,
          metrics: { "train/loss": 0.34 - rank * 0.02, "train/grad_norm": 1.05 + rank * 0.1, "system/gpu_util": 82 + rank },
        });
      }
      console.log("[doc-shot] seeded rank metrics");
    } catch (err) { console.log(`[doc-shot] rank-metrics seed skipped: ${err.message}`); }
  }
  const openRunsDemo = async () => {
    await page.goto(`${webBaseUrl}/dashboard/runs`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".workspace-run-row", { timeout: 15000 });
    await chooseSelect(page, "#project-filter", "demo").catch(() => {});
    await page.waitForTimeout(400);
  };
  // Open the rich seed-44 run inline; this sets the primary/inspected run so
  // run-scoped tabs (detail, distributed, artifacts) follow it via in-app nav.
  const openSeed44 = async () => {
    await page.fill("#search", 'name:"rl-ppo-seed-44"').catch(() => {});
    await page.waitForSelector(".workspace-run-open", { state: "visible", timeout: 10000 });
    await page.locator(".workspace-run-open").first().click({ timeout: 8000 });
    await page.waitForFunction(() => (document.querySelector("#run-detail, .run-workspace")?.textContent ?? "").includes("rl-ppo-seed-44"), null, { timeout: 12000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    // Wait for the Overview metric series to finish loading (avoid empty charts).
    await page.waitForFunction(() => !/No points logged yet/i.test(document.querySelector(".tab-pane.active, #run-detail, .run-workspace")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  };
  // Standalone Run Detail tabs: Overview / Metrics / Artifacts / Logs / Config / Lineage.
  // Some tabs carry a count badge ("Artifacts 2"), so match on a prefix, not exact.
  const detailTab = async (name) => {
    await page.locator(".run-workspace-tabs").getByRole("button", { name: new RegExp(`^${name}\\b`) }).first().click({ timeout: 8000 });
    await page.waitForTimeout(700);
  };
  const navTo = async (label, sel) => {
    await page.getByRole("link", { name: new RegExp(`^${label}$`) }).click({ timeout: 8000 });
    if (sel) await page.waitForSelector(sel, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(600);
  };

  // ---- Phase A: workspace-level views (independent navigations) ----

  // 1. Runs workspace (panels view, demo project).
  await shot("dashboard-runs.png", async () => {
    await openRunsDemo();
    await page.waitForSelector(".workspace-panel-card", { timeout: 15000 }).catch(() => {});
  });

  // 2. Metrics tab.
  await shot("dashboard-metrics.png", async () => {
    await openRunsDemo();
    await navTo("Metrics", ".tab-pane.active canvas, .metric-chart, .tab-pane.active svg");
  });

  // 3. Compare (select all demo runs first).
  await shot("dashboard-compare.png", async () => {
    await openRunsDemo();
    const master = page.locator(".workspace-run-rail input[type=checkbox]").first();
    if (await master.count()) await master.check().catch(() => {});
    await page.waitForTimeout(300);
    await navTo("Compare", ".compare-table, .side-by-side, .tab-pane.active table");
  });

  // 4. Insights (loaded run analysis over the demo set).
  await shot("dashboard-insights.png", async () => {
    await openRunsDemo();
    const master = page.locator(".workspace-run-rail input[type=checkbox]").first();
    if (await master.count()) await master.check().catch(() => {});
    await page.waitForTimeout(300);
    await navTo("Insights", ".tab-pane.active");
  });

  // 5. Reports editor (create a report via the empty-state action).
  await shot("dashboard-reports-editor.png", async () => {
    await page.goto(`${webBaseUrl}/dashboard/reports`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".tab-pane.active", { timeout: 15000 });
    await page.waitForTimeout(600);
    const tmpl = page.getByRole("button", { name: /Start from template/i }).first();
    const create = page.getByRole("button", { name: /Create report|New report/i }).first();
    if (await tmpl.count()) await tmpl.click({ timeout: 6000 }).catch(() => {});
    else if (await create.count()) await create.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1200);
  });

  // 6. API keys (API tab).
  await shot("dashboard-api-keys.png", async () => {
    await gotoTab("api", ".tab-pane.active");
  });

  // 7. Org / workspaces menu.
  await shot("dashboard-org-workspaces.png", async () => {
    await openRunsDemo();
    const trigger = page.locator(".account-workspace-trigger, [data-account-menu-trigger], .account-workspace-current").first();
    await trigger.click({ timeout: 8000 });
    await page.waitForSelector(".account-workspace-menu, [role=menu]", { timeout: 8000 }).catch(() => {});
  });

  // 8. W&B import flow.
  await shot("import-flow-wandb.png", async () => {
    await gotoTab("imports", ".tab-pane.active");
    const wandb = page.getByRole("button", { name: /W&B|Weights ?& ?Biases|wandb/i }).first();
    if (await wandb.count()) await wandb.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
  });

  // 9. Neptune import flow.
  await shot("import-flow-neptune.png", async () => {
    await gotoTab("imports", ".tab-pane.active");
    const neptune = page.getByRole("button", { name: /Neptune/i }).first();
    if (await neptune.count()) await neptune.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
  });

  // 10. Logged-histogram timeline panel (workspace view keeps it content-rich).
  await shot("dashboard-logged-histogram.png", async () => {
    await openRunsDemo();
    await openSeed44();
    await navTo("Runs", ".workspace-run-row");
    await page.locator(".workspace-panel-toolbar").getByRole("button", { name: "Add panels" }).click({ timeout: 8000 });
    await page.waitForSelector(".panel-drawer", { timeout: 8000 });
    await page.locator(".chart-type-segment").getByRole("button", { name: "Logged histogram timeline", exact: true }).click({ timeout: 8000 });
    await page.getByLabel("Histogram object key to add").fill("eval/score_distribution");
    await page.locator(".quick-add-card").click({ timeout: 8000 });
    const card = page.locator(".workspace-panel-card").filter({ has: page.locator(".histogram-timeline-panel-chart") }).first();
    await card.waitFor({ state: "visible", timeout: 10000 });
    await page.waitForFunction(() => {
      const c = [...document.querySelectorAll(".workspace-panel-card")].find((n) => n.querySelector(".histogram-timeline-panel-chart"));
      return (c?.textContent ?? "").includes("frames");
    }, null, { timeout: 8000 }).catch(() => {});
  });

  // ---- Phase B: seed-44-centric run-scoped views (stateful, in-app nav) ----
  // Open seed-44 once so primaryRunId follows it through detail/distributed/artifacts.
  try {
    await openRunsDemo();
    await openSeed44();

    // Prime every metric series so the Overview charts are fully populated
    // (visiting Metrics fetches all series; the Overview then renders both charts).
    await detailTab("Metrics").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);

    // 11. Run Detail (Overview of the rich run, with both metric charts loaded).
    await shot("dashboard-run-detail.png", async () => {
      await detailTab("Overview").catch(() => {});
      await page.waitForFunction(() => {
        const empty = [...document.querySelectorAll(".tab-pane.active *")].filter((n) => /No points logged yet/i.test(n.textContent ?? "") && n.children.length === 0).length;
        return empty === 0;
      }, null, { timeout: 8000 }).catch(() => {});
    });

    // 12. Checkpoints (Overview's Resume Code action makes this checkpoint-centric
    // and visually distinct from the Run Detail shot).
    await shot("dashboard-checkpoints.png", async () => {
      await detailTab("Overview").catch(() => {});
      await page.waitForFunction(() => /Checkpoint/i.test(document.querySelector(".tab-pane.active, #run-detail, .run-workspace")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
      const resume = page.getByRole("button", { name: /Resume Code/i }).first();
      if (await resume.count()) {
        await resume.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    });

    // 13. Artifacts evidence (Artifacts tab previews objects + eval bundles).
    await shot("dashboard-artifacts-evidence.png", async () => {
      await detailTab("Artifacts").catch(() => {});
      await page.waitForSelector(".evidence-panel, .rich-object-card", { timeout: 10000 }).catch(() => {});
      const evalRow = page.locator(".evidence-row", { hasText: "eval/classification" }).first();
      if (await evalRow.count()) {
        await evalRow.click({ timeout: 5000 }).catch(() => {});
        await page.waitForSelector(".rich-object-card.kind-classification_eval", { timeout: 8000 }).catch(() => {});
      }
    });

    // 14. Distributed (rank metrics for the inspected run).
    await shot("dashboard-distributed.png", async () => {
      await navTo("Distributed", ".tab-pane.active");
      await page.waitForFunction(() => !/No rank metrics/i.test(document.querySelector(".tab-pane.active")?.textContent ?? ""), null, { timeout: 6000 }).catch(() => {});
    });

    // 15. Artifacts browser (inspected-run artifact collections).
    await shot("dashboard-artifacts-browser.png", async () => {
      await navTo("Artifacts", ".tab-pane.active");
    });

    // 16. Checkpoint fork modal.
    await navTo("Runs", ".workspace-run-row");
    await openSeed44();
    await detailTab("Overview").catch(() => {});
    await shot("dashboard-checkpoint-fork.png", async () => {
      await page.getByRole("button", { name: /^Fork qa-checkpoint|^Fork$/ }).first().click({ timeout: 8000 });
      await page.waitForSelector(".checkpoint-fork-modal", { timeout: 10000 });
    });
    // Create the fork (keep the modal's clean default name), then capture lineage
    // from the PARENT so its tree shows the new child rather than an empty leaf.
    if (await page.locator(".checkpoint-fork-modal").count()) {
      await Promise.all([
        page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/forks") && r.status() === 200, { timeout: 12000 }).catch(() => {}),
        page.locator(".checkpoint-fork-modal").getByRole("button", { name: /Create Fork/ }).click({ timeout: 8000 }),
      ]);
      await page.waitForTimeout(800);
    }
    // 17. Lineage graph — re-open the parent (seed-44); its Lineage tab now lists the child.
    await navTo("Runs", ".workspace-run-row");
    await openSeed44();
    await shot("dashboard-lineage-graph.png", async () => {
      await page.locator(".run-workspace-tabs").getByRole("button", { name: /^Lineage$|^Graph$/ }).click({ timeout: 8000 }).catch(() => {});
      await page.waitForSelector(".graph-panel, .lineage-graph", { timeout: 10000 }).catch(() => {});
      await page.waitForFunction(() => !/Loading lineage/i.test(document.querySelector(".graph-panel, .lineage-graph")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(900);
    });
  } catch (err) {
    console.log(`[doc-shot] phase B aborted: ${String(err.message ?? err).split("\n")[0]}`);
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

// Panel actions (edit/duplicate/fullscreen/remove) now live inside a single
// three-dot menu — the chart's options menu for line panels, a head kebab for
// the rest. Force it open before driving an action so the click is actionable.
async function openPanelMenu(card) {
  await card.locator("details.chart-menu").first().evaluate((details) => {
    details.open = true;
  });
}

async function waitForStableCount(page, readCount, quietMs = 500, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = readCount();
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const nextCount = readCount();
    if (nextCount !== lastCount) {
      lastCount = nextCount;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
  throw new Error(`Timed out waiting for request count to settle at ${lastCount}`);
}

async function selectVisibleRunForMetrics(page) {
  await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row").length >= 1);
  const railMaster = page.locator(".workspace-rail-select-all input");
  await railMaster.waitFor({ state: "attached", timeout: 10000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selectedCount = await page.locator(".workspace-run-row.selected").count();
    if (selectedCount === 0) break;
    await railMaster.click();
    await page.waitForTimeout(150);
  }
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const selectedCount = await page.locator(".workspace-run-row.selected").count();
    if (selectedCount === 0) break;
    await page.locator(".workspace-run-row.selected .workspace-run-select").first().click();
    await page.waitForTimeout(25);
  }
  const remainingSelected = await page.locator(".workspace-run-row.selected").count();
  assert.equal(remainingSelected, 0, "expected visible run selection to clear before choosing a metrics run");
  const runButtons = page.locator(".workspace-run-row .workspace-run-select");
  const runCount = await runButtons.count();
  assert.ok(runCount > 0, "expected at least one visible run to select for metrics");
  const index = runCount > 1 ? 1 : 0;
  await runButtons.nth(index).click();
  await page.waitForFunction(() => document.querySelectorAll(".workspace-run-row.selected").length >= 1);
}

async function assertWorkbarDropdownVisible(page, selectId) {
  await page.locator(`#${selectId} + .custom-select .select-trigger`).click();
  await page.waitForSelector(`#${selectId}-menu`, { state: "visible", timeout: 5000 });
  const proof = await page.evaluate((id) => {
    const workbar = document.querySelector(".workbar");
    const menu = document.querySelector(`#${id}-menu`);
    if (!workbar || !menu) return { ok: false };
    const workbarRect = workbar.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(menuRect.left + 18, workbarRect.bottom + 12);
    return {
      menuBelowWorkbar: menuRect.bottom > workbarRect.bottom + 12,
      menuReceivesPointer: Boolean(hit?.closest(`#${id}-menu`)),
      ok: true,
      workbarOverflow: getComputedStyle(workbar).overflow,
    };
  }, selectId);
  assert.deepEqual(
    proof,
    { ok: true, workbarOverflow: "visible", menuBelowWorkbar: true, menuReceivesPointer: true },
    `${selectId} menu should render below the workbar without being clipped`,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction((id) => !document.querySelector(`#${id}-menu`), selectId);
}

async function assertOrganizationWorkspaceFlow(page, webBaseUrl, primaryOrgName, smokeId) {
  const workspaceName = `Switch Org ${smokeId}`;
  const draftWorkspaceName = `Switch Org Draft ${smokeId}`;
  const viewerEmail = `viewer-${smokeId}@example.com`;
  const viewerRunName = `viewer-readable-${smokeId}`;

  await page.setViewportSize({ width: 390, height: 820 });
  await openAccountWorkspaceMenu(page);
  const mobileTrigger = await page.locator(".account-workspace-trigger").evaluate((node) => ({
    text: node.textContent ?? "",
    width: node.getBoundingClientRect().width,
  }));
  assert.match(mobileTrigger.text, new RegExp(escapeRegExp(primaryOrgName)), "mobile account trigger should show current workspace name");
  assert.ok(mobileTrigger.width > 70, `mobile account trigger should not collapse to avatar-only, got ${mobileTrigger.width}`);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1440, height: 1100 });
  await openAccountWorkspaceMenu(page);
  await page.getByRole("button", { name: "New workspace" }).click();
  const modal = page.getByRole("dialog", { name: "Create workspace" });
  await modal.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "workspace-name");
  await modal.getByRole("button", { name: "Personal workspace" }).click();
  assert.match(await modal.innerText(), /Personal workspaces are single-seat/);
  assert.equal(await modal.getByLabel("Invite teammates").count(), 0, "personal workspace creation should not show invite controls");
  await pageApiExpectStatus(page, "POST", "/api/orgs/current-user", {
    name: `Personal Reject ${smokeId}`,
    account_type: "personal",
    plan_tier: "free",
    storage_choice: "instantml-hosted",
    initial_invitations: [{ email: `personal-invite-${smokeId}@example.com`, role: "member" }],
    switch_on_create: false,
  }, 400);
  await modal.getByRole("button", { name: "Organization" }).click();
  await modal.getByLabel("Organization name").fill(draftWorkspaceName);
  assert.equal(await modal.getByRole("button", { name: "Create workspace", exact: true }).isEnabled(), false, "create should wait for name availability");
  await page.waitForFunction(() => document.querySelector(".workspace-create-status")?.textContent?.includes("available"));
  assert.equal(await modal.getByRole("button", { name: "Create workspace", exact: true }).isEnabled(), true, "create should enable after the checked name is available");
  await modal.getByRole("button", { name: "Pro" }).click();
  await page.waitForFunction(() => document.querySelector(".workspace-create-actions .primary-button")?.textContent?.includes("Continue to checkout"));
  await modal.getByRole("button", { name: "Free" }).click();
  await page.waitForFunction(() => document.querySelector(".workspace-create-actions .primary-button")?.textContent?.includes("Create workspace"));
  await modal.getByLabel("Organization name").fill(workspaceName);
  assert.equal(await modal.getByRole("button", { name: "Create workspace", exact: true }).isEnabled(), false, "create should disable again when the name changes before a fresh check");
  await page.waitForFunction(() => document.querySelector(".workspace-create-status")?.textContent?.includes("available"));
  await modal.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction((name) => document.querySelector(".account-workspace-current")?.textContent?.includes(name), workspaceName);

  const createdSession = await pageApiGet(page, "/api/auth/session");
  assert.equal(createdSession.organization.name, workspaceName);
  if (fullWorkspaceSmoke) {
    await assertPaidCheckoutFlow(page, createdSession.organization.id, smokeId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction((name) => document.querySelector(".account-workspace-current")?.textContent?.includes(name), workspaceName);
  }

  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForSelector(".workspace-run-list", { timeout: 15000 });
  const emptySummary = await pageApiGet(page, "/api/runs/summary?limit=1&offset=0");
  assert.equal(emptySummary.total, 0, "new workspace should start without runs");
  const emptyWorkspaceText = await page.locator("body").innerText();
  assert.doesNotMatch(emptyWorkspaceText, /seed-44|page-run-/, "new workspace should not show prior workspace runs");

  const viewerRun = (await pageApiRequest(page, "POST", "/runs", {
    project: "viewer-project",
    name: viewerRunName,
    config: { seed: 101, role: "viewer-flow" },
    tags: ["viewer-flow"],
  })).run;
  await pageApiRequest(page, "POST", `/runs/${viewerRun.id}/metrics`, {
    step: 0,
    metrics: { "eval/viewer_score": 0.3 },
  });
  await pageApiRequest(page, "POST", `/runs/${viewerRun.id}/metrics`, {
    step: 1,
    metrics: { "eval/viewer_score": 0.7 },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((name) => document.querySelector(".workspace-run-list")?.textContent?.includes(name), viewerRunName);

  await page.getByRole("link", { name: /^Settings$/ }).click();
  await page.waitForSelector("text=Seats", { timeout: 10000 });
  await chooseSelect(page, "#seat-role", "viewer");
  await page.getByLabel("Invite email").fill(viewerEmail);
  const [viewerInviteResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && url.pathname === `/api/orgs/${createdSession.organization.id}/invitations`;
    }),
    page.getByRole("button", { name: /^Invite$/ }).click(),
  ]);
  assert.equal(viewerInviteResponse.status(), 200, `created workspace invite request should succeed, got ${viewerInviteResponse.status()}`);
  const invitePayload = await viewerInviteResponse.json();
  assert.equal(invitePayload.delivery_error ?? null, null, "created workspace invite should not report an email delivery failure");
  assert.notEqual(invitePayload.invitation?.delivery_status, "send_failed", "created workspace invite should not persist a failed delivery status");
  assert.equal(invitePayload.invitation.role, "viewer");
  assert.match(invitePayload.preview_link, /\/invite#t=instantml_invite_/);
  const inviteTtlMs = new Date(invitePayload.invitation.expires_at).getTime() - new Date(invitePayload.invitation.created_at).getTime();
  assert.ok(inviteTtlMs > 6.9 * 24 * 60 * 60 * 1000 && inviteTtlMs < 7.1 * 24 * 60 * 60 * 1000, `invite TTL should be 7 days, got ${inviteTtlMs}`);

  await page.waitForFunction((email) => document.querySelector(".tab-pane.active")?.textContent?.includes(email), viewerEmail);
  const ownerSettingsText = await page.locator(".tab-pane.active").innerText();
  assert.match(ownerSettingsText, /2\s*\/\s*2/, "pending viewer invite should reserve the included free seat");
  assert.match(ownerSettingsText, /Read only/);
  assert.match(ownerSettingsText, /Expires/);
  assert.doesNotMatch(ownerSettingsText, /send[_ ]failed|delivery failed/i);

  await openAccountWorkspaceMenu(page);
  await page.waitForFunction((name) => document.querySelector("#account-workspace-menu")?.textContent?.includes(name), primaryOrgName);
  await page.locator("#account-workspace-menu .account-workspace-option", { hasText: primaryOrgName }).click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction((name) => document.querySelector(".account-workspace-current")?.textContent?.includes(name), primaryOrgName);
  await page.getByRole("link", { name: /^Runs$/ }).click();
  await page.waitForFunction(() => document.querySelector(".workspace-run-list")?.textContent?.includes("seed-44"));
  const primaryWorkspaceText = await page.locator("body").innerText();
  assert.doesNotMatch(primaryWorkspaceText, new RegExp(escapeRegExp(viewerRunName)), "primary workspace should not show run data from the created org");

  const previewUrl = new URL(invitePayload.preview_link);
  await page.goto(`${webBaseUrl}${previewUrl.pathname}${previewUrl.hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.textContent?.includes("Read only invite"));
  await page.getByLabel("Email").fill(viewerEmail);
  await page.getByRole("button", { name: /Accept invitation/ }).click();
  await page.waitForURL(/\/dashboard\/runs$/, { timeout: 15000 });
  await page.waitForFunction((name) => document.querySelector(".workspace-run-list")?.textContent?.includes(name), viewerRunName);
  const viewerRunsText = await page.locator("body").innerText();
  assert.match(viewerRunsText, /eval\/viewer_score/);
  await page.getByRole("button", { name: "View actions" }).click();
  assert.equal(await page.locator(".view-actions-popover").getByRole("button", { name: "Save view" }).isEnabled(), false);
  await pageApiExpectStatus(page, "POST", "/runs", {
    project: "viewer-project",
    name: "viewer-must-not-write",
  }, 403);
  await pageApiExpectStatus(page, "PATCH", `/runs/${viewerRun.id}`, {
    name: "viewer-must-not-edit",
  }, 403);
  await pageApiExpectStatus(page, "POST", `/runs/${viewerRun.id}/metrics`, {
    step: 2,
    metrics: { "eval/blocked": 1 },
  }, 403);
  await pageApiExpectStatus(page, "POST", `/api/runs/${viewerRun.id}/artifacts/upload`, {
    type: "file",
    name: "viewer-blocked.txt",
    content_base64: Buffer.from("blocked").toString("base64"),
  }, 403);
  await pageApiExpectStatus(page, "POST", `/api/orgs/${createdSession.organization.id}/invitations`, {
    email: `blocked-${smokeId}@example.com`,
    role: "viewer",
  }, 403);
  await pageApiExpectStatus(page, "POST", `/api/orgs/${createdSession.organization.id}/api-keys`, {
    name: "viewer blocked key",
    scopes: ["sdk:ingest"],
  }, 403);
  await pageApiExpectStatus(page, "POST", "/api/workspace-views", {
    name: "viewer blocked view",
    payload: { panels: [] },
  }, 403);
  await pageApiExpectStatus(page, "POST", "/api/billing/checkout", {
    plan_tier: "pro",
  }, 403);
  await pageApiExpectStatus(page, "POST", "/api/billing/add-seat", {
    email: `billing-blocked-${smokeId}@example.com`,
    role: "viewer",
  }, 403);

  await openAccountWorkspaceMenu(page);
  const viewerMenuText = await page.locator("#account-workspace-menu").innerText();
  assert.match(viewerMenuText, /Read only/);
  assert.doesNotMatch(viewerMenuText, /Manage billing/);
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: /^Settings$/ }).click();
  await page.waitForFunction(() => document.querySelector(".tab-pane.active")?.textContent?.includes("Seat management is available to workspace admins."));
  const viewerSettingsText = await page.locator(".tab-pane.active").innerText();
  assert.match(viewerSettingsText, /2\s*\/\s*2/, "viewer Settings should use membership metadata for seat usage");
  assert.doesNotMatch(viewerSettingsText, /Invite email/);

  await page.getByRole("link", { name: /^API$/ }).click();
  await page.waitForFunction(() => document.querySelector(".tab-pane.active")?.textContent?.includes("API-key management is available to workspace owners and admins."));
  const viewerApiText = await page.locator(".tab-pane.active").innerText();
  assert.doesNotMatch(viewerApiText, /API key name/);
}

async function assertPaidCheckoutFlow(page, returnOrgId, smokeId) {
  const paidName = `Paid Checkout ${smokeId}`;
  const paidResult = await pageApiAttempt(page, "POST", "/api/orgs/current-user", {
    name: paidName,
    account_type: "business",
    plan_tier: "pro",
    storage_choice: "instantml-hosted",
    switch_on_create: true,
  });
  if (!paidResult.ok && paidResult.status === 503 && paidResult.payload?.code === "billing_unavailable") {
    expectedServiceUnavailableApiErrors += 1;
    return;
  }
  assert.equal(paidResult.ok, true, `POST /api/orgs/current-user: ${JSON.stringify(paidResult.payload)} (${paidResult.status})`);
  const paidPayload = paidResult.payload;
  assert.equal(paidPayload.organization.name, paidName);
  assert.equal(paidPayload.organization.plan_tier, "pro");
  assert.match(paidPayload.billing_checkout?.url ?? "", /billing\/return\?session_id=cs_test_instantml__/);
  assert.match(paidPayload.billing_checkout?.session_id ?? "", /^cs_test_instantml__/);

  const pendingSession = await pageApiGet(page, "/api/auth/session");
  assert.equal(pendingSession.organization.name, paidName);
  expectedPaymentRequiredResourceErrors += 1;
  await pageApiExpectStatus(page, "POST", "/runs", {
    project: "paid-checkout",
    name: `paid-before-sync-${smokeId}`,
  }, 402);
  const pendingBilling = await pageApiGet(page, "/api/billing/status");
  assert.equal(pendingBilling.billing.access_state, "checkout_pending");
  assert.equal(pendingBilling.billing.effective_plan_tier, "free");
  assert.equal(pendingBilling.billing.requested_plan_tier, "pro");

  const synced = await pageApiRequest(page, "POST", "/api/billing/checkout/sync", {
    session_id: paidPayload.billing_checkout.session_id,
  });
  assert.equal(synced.billing.access_state, "paid_active");
  assert.equal(synced.billing.effective_plan_tier, "pro");
  const paidRun = await pageApiRequest(page, "POST", "/runs", {
    project: "paid-checkout",
    name: `paid-after-sync-${smokeId}`,
  });
  assert.equal(paidRun.run.name, `paid-after-sync-${smokeId}`);

  await pageApiRequest(page, "POST", "/api/auth/switch-organization", {
    org_id: returnOrgId,
  });
  const restoredSession = await pageApiGet(page, "/api/auth/session");
  assert.equal(restoredSession.organization.id, returnOrgId);
}

async function consoleErrorText(message) {
  const text = message.text();
  if (!text.startsWith("instantml_api_request")) return text;
  const args = message.args();
  const eventArg = args[1];
  if (!eventArg) return text;
  try {
    const event = await eventArg.jsonValue();
    return `instantml_api_request ${JSON.stringify(event)}`;
  } catch {
    return text;
  }
}

function isExpectedServiceUnavailableApiError(error) {
  if (!error.startsWith("instantml_api_request ")) return false;
  try {
    const event = JSON.parse(error.slice("instantml_api_request ".length));
    return event?.outcome === "failure"
      && event?.method === "POST"
      && event?.path === "/api/orgs/current-user"
      && event?.status === 503
      && event?.code === "billing_unavailable";
  } catch {
    return false;
  }
}

function isExpectedApiFailureConsoleError(error) {
  return error.startsWith("instantml_api_request ")
    && error.includes("outcome")
    && error.includes("failure");
}

async function openAccountWorkspaceMenu(page) {
  const trigger = page.getByRole("button", { name: /Account and workspace menu/ });
  await trigger.click();
  await page.waitForSelector("#account-workspace-menu", { state: "visible", timeout: 10000 });
}

function isExpectedForbiddenResource(response) {
  let path = "";
  try {
    path = new URL(response.url()).pathname;
  } catch {
    return false;
  }
  const method = response.request().method();
  return (method === "POST" && (
      path === "/runs"
      || path === "/api/invitations/accept"
      || path === "/api/billing/checkout"
      || path === "/api/billing/add-seat"
      || path === "/api/workspace-views"
      || /^\/runs\/[^/]+\/metrics$/.test(path)
      || /^\/api\/runs\/[^/]+\/artifacts\/upload$/.test(path)
      || /^\/api\/orgs\/[^/]+\/(?:invitations|api-keys)$/.test(path)
    ))
    || (method === "PATCH" && /^\/runs\/[^/]+$/.test(path));
}

function isExpectedPaymentRequiredResource(response) {
  let path = "";
  try {
    path = new URL(response.url()).pathname;
  } catch {
    return false;
  }
  return response.request().method() === "POST" && path === "/runs";
}

function isExpectedBadRequestResource(response) {
  try {
    const url = new URL(response.url());
    const method = response.request().method();
    if (url.pathname === "/api/runs/summary" && url.searchParams.get("q") === "re:/[/") return true;
    return method === "POST" && url.pathname === "/api/orgs/current-user";
  } catch {
    return false;
  }
}

function isExpectedRateLimitedResource(response) {
  let path = "";
  try {
    path = new URL(response.url()).pathname;
  } catch {
    return false;
  }
  const method = response.request().method();
  if (method === "POST") {
    return path === "/runs"
      || path === "/api/metrics/series"
      || path.endsWith("/metrics")
      || path.endsWith("/objects")
      || path.endsWith("/logs")
      || path.endsWith("/artifacts/upload");
  }
  return method === "GET" && (
    path === "/projects"
    || path === "/api/artifact-collections"
    || path === "/api/usage"
    || path === "/api/overview"
    || path === "/api/imports"
    || path === "/api/reports"
    || path === "/api/runs/summary"
    || path === "/api/runs/side-by-side"
    || /^\/api\/runs\/[^/]+\/logs$/.test(path)
    || /^\/api\/artifacts\/[^/]+\/download$/.test(path)
    || /^\/api\/runs\/[^/]+\/artifacts$/.test(path)
    || /^\/api\/runs\/[^/]+\/lineage$/.test(path)
    || /^\/api\/runs\/[^/]+\/objects$/.test(path)
    || /^\/api\/objects\/[^/]+\/rows$/.test(path)
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pageApiRequest(page, method, route, body, options = {}) {
  const attempts = 1 + (options.retries ?? 2);
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await pageApiAttempt(page, method, route, body);
    if (result.ok || (result.status < 500 && result.status !== 429) || attempt === attempts - 1) break;
    await page.waitForTimeout(result.status === 429 ? 600 : 250);
  }
  assert.equal(result.ok, true, `${method} ${route}: ${JSON.stringify(result.payload)} (${result.status})`);
  return result.payload;
}

async function pageApiAttempt(page, method, route, body) {
  return page.evaluate(async ({ method, route, body }) => {
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
}

async function pageApiExpectStatus(page, method, route, body, expectedStatus) {
  const result = await page.evaluate(async ({ method, route, body }) => {
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
  assert.equal(result.status, expectedStatus, `${method} ${route}: expected ${expectedStatus}, got ${result.status} ${JSON.stringify(result.payload)}`);
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

async function fillSearchAndWaitForSummary(page, query) {
  let lastResponse = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) {
      await page.fill("#search", "");
      await page.waitForTimeout(150);
    }
    const responsePromise = page.waitForResponse((response) => {
      if (!response.url().includes("/api/runs/summary")) return false;
      return new URL(response.url()).searchParams.get("q") === query;
    }, { timeout: 10000 });
    await page.fill("#search", query);
    lastResponse = await responsePromise;
    const finishedError = await lastResponse.finished();
    assert.equal(finishedError, null, `summary response for ${query} should complete`);
    if (lastResponse.status() !== 429) return lastResponse;
    const retryAfterSeconds = Number(lastResponse.headers()["retry-after"] ?? lastResponse.headers()["ratelimit-reset"] ?? "1");
    await page.waitForTimeout(Math.max(700, Math.min(3000, retryAfterSeconds * 1000)));
  }
  return lastResponse;
}

async function waitForHttp(url, child = null) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 30000) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`process exited while waiting for ${url}: code=${child.exitCode} signal=${child.signalCode}`);
    }
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
