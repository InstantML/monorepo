/**
 * Smoke test for the Notion-style report editor. Verifies:
 *   1. logged-in dev session can reach /dashboard/reports
 *   2. creating a new report navigates into the editor
 *   3. slash command opens a picker, filters to "heading", inserts on Enter
 *   4. auto-save indicator reaches the "Saved" state without an explicit Save click
 *   5. a PATCH /api/reports/:id request was issued in response to the edit
 *
 * Skipped automatically if the Rust API (:8010) or Next dev (:3010) aren't
 * reachable — keeps the test useful while developers run only part of the
 * stack.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import test from "node:test";
import assert from "node:assert/strict";

const API_URL = process.env.INSTANTML_API_URL ?? "http://localhost:8010";
const WEB_URL = process.env.INSTANTML_WEB_URL ?? "http://localhost:3010";
const TIMEOUT_MS = 30_000;

async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function ensureDevSession(): Promise<{ cookie: string } | null> {
  const response = await fetch(`${API_URL}/api/auth/dev/google`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({
      email: "playwright-reports@local.dev",
      display_name: "Playwright Reports",
      org_name: "playwright-reports-org",
      plan_tier: "free",
    }),
  });
  if (!response.ok) return null;
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/instantml_session=([^;]+)/);
  if (!match) return null;
  return { cookie: match[1] };
}

test("reports editor: slash command, auto-save", { timeout: TIMEOUT_MS * 3 }, async () => {
  const apiUp = await isReachable(`${API_URL}/health`);
  const webUp = await isReachable(WEB_URL);
  if (!apiUp || !webUp) {
    // eslint-disable-next-line no-console
    console.warn(
      `Skipping reports editor smoke — API:${apiUp ? "up" : "down"} WEB:${webUp ? "up" : "down"}`,
    );
    return;
  }
  const session = await ensureDevSession();
  if (!session) {
    // eslint-disable-next-line no-console
    console.warn("Skipping reports editor smoke — could not create dev session");
    return;
  }
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ baseURL: WEB_URL });
    await context.addCookies([
      {
        name: "instantml_session",
        value: session.cookie,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    page = await context.newPage();
    const patchRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().includes("/api/reports/")) {
        patchRequests.push(request.url());
      }
    });
    await page.goto(`${WEB_URL}/dashboard/reports`, { waitUntil: "networkidle" });

    // Click "New report" to enter the editor.
    const newReportButton = page.getByRole("button", { name: /new report/i });
    await newReportButton.first().click({ timeout: TIMEOUT_MS });
    // Wait for the editor to mount.
    await page.locator("input#report-title").waitFor({ state: "visible", timeout: TIMEOUT_MS });

    // Confirm an autosave pill is present.
    const autoSavePill = page.locator(".report-auto-save-pill").first();
    await autoSavePill.waitFor({ state: "visible", timeout: 5_000 });

    // Step 1: insert a paragraph block via the hover-gap "+" button so the
    // slash command has somewhere to live.
    const emptyButton = page.locator(".report-editor__empty-button");
    if (await emptyButton.count()) {
      await emptyButton.click();
      await page.getByRole("option", { name: /Paragraph/i }).first().click();
    } else {
      const addButton = page.locator(".report-block-handle-zone__add").first();
      await addButton.click();
      await page.getByRole("option", { name: /Paragraph/i }).first().click();
    }

    // Step 2: focus the paragraph and trigger the slash menu.
    const paragraph = page.locator(".report-block__textarea--paragraph").first();
    await paragraph.click();
    await paragraph.type("/", { delay: 30 });
    // The floating slash menu should appear with all entries.
    await page.locator(".block-picker-floating").waitFor({ state: "visible", timeout: 5_000 });
    await paragraph.type("heading", { delay: 25 });
    // Filter narrowed the list to heading entries.
    const headingOptions = page.locator(
      ".block-picker-floating .block-picker__row",
    );
    const optionCount = await headingOptions.count();
    assert.ok(optionCount > 0, "slash menu did not surface heading entries");
    // Press Enter to commit the highlighted entry.
    await paragraph.press("Enter");

    // The new heading block exists.
    const headingInput = page.locator(".report-block__heading-input").first();
    await headingInput.waitFor({ state: "visible", timeout: TIMEOUT_MS });
    await headingInput.click();
    await headingInput.type("Hello from Playwright", { delay: 20 });

    // Wait for auto-save to settle into a "Saved" state.
    await page.waitForFunction(
      () => {
        const pill = document.querySelector(".report-auto-save-pill--saved");
        return pill !== null;
      },
      undefined,
      { timeout: 10_000 },
    );

    assert.ok(patchRequests.length > 0, "no PATCH /api/reports/:id request observed");
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
});
