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
  if (!Number.isFinite(args.expectSessions) || args.expectSessions < 1) {
    throw new Error("--expect-sessions must be a positive integer");
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
    assert(runCards >= args.expectRuns, `expected at least ${args.expectRuns} run cards, found ${runCards}`);
    assert(tabs >= args.expectSessions, `expected at least ${args.expectSessions} session tabs, found ${tabs}`);
    assert(iframes >= 1, "expected at least one iframe");

    const iframeBox = await page.locator("iframe").first().boundingBox();
    assert(iframeBox && iframeBox.width >= 280 && iframeBox.height >= 320, "iframe is not visibly sized");
    const iframeHasToken = await page.locator("iframe").first().evaluate((frame) => {
      const src = frame.getAttribute("src") || "";
      return /#token=instantml_embed_[A-Za-z0-9_-]+/.test(src);
    });
    assert(iframeHasToken, "iframe src was missing its embed token fragment");

    let interaction = "single session only";
    if (tabs > 1) {
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
      interaction = `selected tab: ${secondLabel}`;
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

    if (args.screenshot) {
      await page.screenshot({ path: args.screenshot, fullPage: false });
    }

    const result = {
      ok: true,
      url: args.url,
      title,
      viewport: args.viewport,
      run_cards: runCards,
      session_tabs: tabs,
      iframes,
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
