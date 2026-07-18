#!/usr/bin/env node
import { chromium } from "playwright";

const LIVE_EMBED_TOKEN_RE = /instantml_embed_(?!redacted\b)[A-Za-z0-9_-]+/g;

function parseArgs(argv) {
  const args = {
    url: "http://127.0.0.1:5174",
    expectRuns: 1,
    expectSessions: 1,
    timeoutMs: 15000,
    viewport: { width: 1366, height: 900 },
    screenshot: null,
    failOnWarnings: false,
    allowBlockedEmbeds: false,
    requireIframeContent: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };
    if (arg === "--url") args.url = next();
    else if (arg === "--expect-runs") args.expectRuns = Number.parseInt(next(), 10);
    else if (arg === "--expect-sessions") args.expectSessions = Number.parseInt(next(), 10);
    else if (arg === "--timeout-ms") args.timeoutMs = Number.parseInt(next(), 10);
    else if (arg === "--viewport") args.viewport = parseViewport(next());
    else if (arg === "--screenshot") args.screenshot = next();
    else if (arg === "--fail-on-warnings") args.failOnWarnings = true;
    else if (arg === "--allow-blocked-embeds") args.allowBlockedEmbeds = true;
    else if (arg === "--require-iframe-content") args.requireIframeContent = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.expectRuns) || args.expectRuns < 1) {
    throw new Error("--expect-runs must be a positive integer");
  }
  if (!Number.isFinite(args.expectSessions) || args.expectSessions < 0) {
    throw new Error("--expect-sessions must be a non-negative integer");
  }
  if (!args.allowBlockedEmbeds && args.expectSessions < 1) {
    throw new Error("--expect-sessions must be at least 1 unless --allow-blocked-embeds is set");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  return args;
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error("--viewport must use WIDTHxHEIGHT, for example 1366x900");
  }
  return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
}

function printHelp() {
  console.log(`Usage: node demo/castform/browser_verify.mjs [options]

Options:
  --url <url>                 Parent page URL. Default: http://127.0.0.1:5174
  --expect-runs <n>           Minimum rendered run cards. Default: 1
  --expect-sessions <n>       Minimum rendered session tabs. Default: 1
  --viewport <WIDTHxHEIGHT>   Browser viewport. Default: 1366x900
  --screenshot <path>         Optional screenshot output path
  --fail-on-warnings          Treat console warnings as failures
  --allow-blocked-embeds      Accept the explicit hosted-embed-blocked state
  --require-iframe-content    Verify the InstantML embed app rendered panels
  --timeout-ms <ms>           Navigation and selector timeout. Default: 15000
`);
}

function sanitize(value) {
  return String(value || "").replace(LIVE_EMBED_TOKEN_RE, "instantml_embed_redacted");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function visibleText(page) {
  return page.locator("body").innerText({ timeout: 3000 });
}

async function waitForEmbedFrame(page, timeoutMs, expectedPath = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      const url = candidate.url();
      return url.includes("/embed/runs/") && (!expectedPath || url.includes(expectedPath));
    });
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  return null;
}

async function waitForEmbedText(frame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1000, Math.min(3000, deadline - Date.now()));
      const text = await frame.locator("body").innerText({ timeout: remaining });
      lastText = text;
      if (
        text.includes("INSTANTML EMBED")
        && text.includes("Run metrics")
        && (text.includes("plotted") || text.includes("latest values"))
      ) {
        return text;
      }
    } catch (error) {
      lastError = sanitize(error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const excerpt = sanitize(lastText).slice(0, 500).replace(/\s+/g, " ");
  throw new Error(`InstantML embed frame did not render expected text. Last text: ${excerpt || "empty"} ${lastError}`);
}

async function waitForPanelCount(frame, timeoutMs) {
  const selector = ".embed-run-panel, [class*=embed-run-panel], .chart-area, svg, canvas";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const panelCount = await frame.locator(selector).count().catch(() => 0);
    if (panelCount > 0) return panelCount;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const consoleIssues = [];
  const pageErrors = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: args.viewport });
    page.on("console", (message) => {
      const type = message.type();
      if (type === "error" || type === "warning" || type === "assert") {
        consoleIssues.push({ type, text: sanitize(message.text()) });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(sanitize(error.message));
    });

    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await page.waitForSelector(".app-shell, .empty-state", { timeout: args.timeoutMs });

    const title = await page.title();
    assert(title.includes("Castform InstantML Demo"), `unexpected page title: ${title}`);

    const emptyStateCount = await page.locator(".empty-state").count();
    assert(emptyStateCount === 0, "page rendered the empty state instead of a generated manifest");

    const bodyText = await visibleText(page);
    assert(bodyText.includes("Castform training observability"), "main demo heading was not visible");
    assert(!bodyText.includes("Tunnel website ahead"), "parent page is behind a tunnel warning");
    assert(!LIVE_EMBED_TOKEN_RE.test(bodyText), "live embed token appeared in visible page text");
    LIVE_EMBED_TOKEN_RE.lastIndex = 0;

    const runCards = await page.locator(".run-card").count();
    const tabs = await page.locator(".tab").count();
    const iframes = await page.locator("iframe").count();
    const blockedPanels = await page.locator(".blocked-panel").count();
    const embedsBlocked = blockedPanels > 0;
    let iframeContent = "not requested";
    assert(runCards >= args.expectRuns, `expected at least ${args.expectRuns} run cards, found ${runCards}`);
    if (embedsBlocked) {
      assert(args.allowBlockedEmbeds, "page rendered blocked embeds, but --allow-blocked-embeds was not set");
      assert(iframes === 0, `blocked embed state should not render iframes, found ${iframes}`);
      assert(bodyText.includes("Live data is persisted"), "blocked embed state did not show live-data evidence");
      assert(bodyText.includes("production currently returns 404"), "blocked embed state did not show the production route failure");
    } else {
      assert(tabs >= args.expectSessions, `expected at least ${args.expectSessions} session tabs, found ${tabs}`);
      assert(iframes >= 1, "expected at least one iframe");

      const iframe = page.locator("iframe").first();
      await iframe.scrollIntoViewIfNeeded({ timeout: args.timeoutMs });
      const iframeBox = await iframe.boundingBox();
      assert(iframeBox && iframeBox.width >= 280 && iframeBox.height >= 320, "iframe is not visibly sized");
      const iframeHasToken = await iframe.evaluate((frame) => {
        const src = frame.getAttribute("src") || "";
        return /#token=instantml_embed_[A-Za-z0-9_-]+/.test(src);
      });
      assert(iframeHasToken, "iframe src was missing its embed token fragment");
      if (args.requireIframeContent) {
        const embedFrame = await waitForEmbedFrame(page, args.timeoutMs);
        assert(embedFrame, "InstantML embed frame was not attached");
        const embedText = await waitForEmbedText(embedFrame, args.timeoutMs);
        const panelCount = await waitForPanelCount(embedFrame, args.timeoutMs);
        assert(panelCount > 0, "embed frame did not render any InstantML panel elements");
        assert(!LIVE_EMBED_TOKEN_RE.test(embedText), "live embed token appeared inside iframe text");
        LIVE_EMBED_TOKEN_RE.lastIndex = 0;
        iframeContent = `verified ${panelCount} panels`;
      }
    }

    let interaction = "single session only";
    if (!embedsBlocked && tabs > 1) {
      const secondTab = page.locator(".tab").nth(1);
      const secondLabel = (await secondTab.innerText()).trim();
      await secondTab.click();
      await page.waitForFunction(
        (label) => document.querySelector(".tab[aria-selected='true']")?.textContent?.trim() === label,
        secondLabel,
        { timeout: args.timeoutMs },
      );
      const iframeTitle = await page.locator("iframe").first().getAttribute("title");
      assert(iframeTitle === secondLabel, "iframe title did not follow selected tab");
      if (args.requireIframeContent) {
        const iframeSrc = await page.locator("iframe").first().getAttribute("src");
        const expectedPath = new URL(iframeSrc).pathname;
        const selectedFrame = await waitForEmbedFrame(page, args.timeoutMs, expectedPath);
        assert(selectedFrame, "selected InstantML embed frame was not attached");
        await waitForEmbedText(selectedFrame, args.timeoutMs);
        const selectedPanelCount = await waitForPanelCount(selectedFrame, args.timeoutMs);
        assert(selectedPanelCount > 0, "selected embed frame did not render any InstantML panel elements");
        iframeContent = `verified selected tab with ${selectedPanelCount} panels`;
      }
      interaction = `selected tab: ${secondLabel}`;
    }

    if (args.screenshot) {
      await page.screenshot({ path: args.screenshot, fullPage: false });
    }

    await page.locator("[data-refresh]").click();
    await page.waitForSelector(".app-shell", { timeout: args.timeoutMs });
    const refreshedText = await visibleText(page);
    assert(refreshedText.includes("Castform training observability"), "refresh did not restore the demo shell");
    assert(!LIVE_EMBED_TOKEN_RE.test(refreshedText), "live embed token appeared after refresh");
    LIVE_EMBED_TOKEN_RE.lastIndex = 0;

    const consoleErrors = consoleIssues.filter((issue) => issue.type === "error" || issue.type === "assert");
    const consoleWarnings = consoleIssues.filter((issue) => issue.type === "warning");
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);
    assert(consoleErrors.length === 0, `console errors: ${consoleErrors.map((issue) => issue.text).join("; ")}`);
    if (args.failOnWarnings) {
      assert(consoleWarnings.length === 0, `console warnings: ${consoleWarnings.map((issue) => issue.text).join("; ")}`);
    }

    const result = {
      ok: true,
      url: args.url,
      title,
      viewport: args.viewport,
      run_cards: runCards,
      session_tabs: tabs,
      iframes,
      embeds_blocked: embedsBlocked,
      iframe_content: iframeContent,
      interaction,
      console_warnings: consoleWarnings.length,
      screenshot: args.screenshot || undefined,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`browser verification failed: ${sanitize(error.message)}`);
  process.exit(1);
});
