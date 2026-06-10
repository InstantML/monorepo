import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");

function css(relPath) {
  return readFileSync(path.join(webRoot, relPath), "utf8");
}

function missingPlaywrightBrowser(error) {
  return /Executable doesn't exist|Looks like Playwright was just installed or updated|playwright install/.test(String(error?.message ?? error));
}

function installChromium() {
  return spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!missingPlaywrightBrowser(error)) throw error;
    const install = installChromium();
    assert.equal(
      install.status,
      0,
      `failed to install Playwright Chromium\nSTDOUT:\n${install.stdout}\nSTDERR:\n${install.stderr}`,
    );
    return chromium.launch();
  }
}

function chartMarkup({ legendCount = 10, rowSpan = 6 } = {}) {
  const legend = Array.from({ length: legendCount }, (_, index) => `
    <span class="legend-chip"><i class="legend-line"></i> run-${index}</span>
  `).join("");

  return `
    <div class="workspace-panel-grid">
      <article
        class="workspace-panel-card"
        data-panel-height="${rowSpan}"
        data-panel-width="12"
        style="--panel-grid-span: 12; --panel-row-span: ${rowSpan}; --panel-chart-min-height: ${rowSpan * 54}px;"
      >
        <div class="workspace-panel-head">
          <div><h3>Return Mean</h3></div>
        </div>
        <div class="workspace-panel-meta">
          <span>Step</span><span>Ungrouped</span><span>Full fidelity</span><span>${legendCount} current page</span>
        </div>
        <div class="chart-area chart-area-exportable">
          <div class="chart-export-actions">
            <button class="icon-button">csv</button>
            <button class="icon-button">svg</button>
          </div>
          <div class="chart-legend">${legend}</div>
          <div class="metric-chart-frame">
            <svg class="metric-chart" preserveAspectRatio="none" viewBox="0 0 560 360">
              <line class="axis" x1="56" x2="504" y1="304" y2="304"></line>
              <line class="axis" x1="56" x2="56" y1="56" y2="304"></line>
              <polyline class="series" points="56,280 180,220 300,170 504,100"></polyline>
            </svg>
          </div>
          <div class="chart-tooltip-slot"></div>
        </div>
        <button aria-label="Resize Return Mean" class="panel-resize-handle" type="button"></button>
      </article>
    </div>
  `;
}

test("workspace chart panels keep row-span sizing authoritative", { timeout: 60_000 }, async () => {
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.setContent(`
      <!doctype html>
      <html data-theme="dark">
        <head>
          <style>
            ${css("app/styles/tokens.css")}
            ${css("app/styles/base.css")}
            ${css("app/styles/panels.css")}
            ${css("app/styles/charts.css")}
            body { margin: 0; padding: 24px; background: var(--bg); }
          </style>
        </head>
        <body>${chartMarkup({ legendCount: 10, rowSpan: 6 })}</body>
      </html>
    `);

    const layout = await page.evaluate(() => {
      const grid = document.querySelector(".workspace-panel-grid");
      const card = document.querySelector(".workspace-panel-card");
      const chartArea = card?.querySelector(".chart-area");
      const frame = card?.querySelector(".metric-chart-frame");
      const legend = card?.querySelector(".chart-legend");
      const handle = card?.querySelector(".panel-resize-handle");
      const rect = (node) => {
        const box = node.getBoundingClientRect();
        return { bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width };
      };
      const handleBox = handle.getBoundingClientRect();
      const hit = document.elementFromPoint(handleBox.left + handleBox.width / 2, handleBox.top + handleBox.height / 2);
      const rowHeight = Number.parseFloat(getComputedStyle(grid).gridAutoRows);
      const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap);
      const rowSpan = Number(card.dataset.panelHeight);
      return {
        expectedCardHeight: rowSpan * rowHeight + (rowSpan - 1) * rowGap,
        gridAutoRows: getComputedStyle(grid).gridAutoRows,
        panel: rect(card),
        chartArea: rect(chartArea),
        frame: rect(frame),
        legend: rect(legend),
        frameAspect: getComputedStyle(frame).aspectRatio,
        hitClass: hit?.className ?? "",
        handleZIndex: getComputedStyle(handle).zIndex,
        legendColumns: getComputedStyle(legend).gridTemplateColumns.split(" ").filter(Boolean).length,
        legendScrollHeight: legend.scrollHeight,
        lowerDeadSpace: rect(chartArea).bottom - Math.max(rect(frame).bottom, rect(legend).bottom),
      };
    });

    assert.equal(layout.gridAutoRows, "78px");
    assert.ok(Math.abs(layout.panel.height - layout.expectedCardHeight) <= 2, `panel height ${layout.panel.height} should match fixed grid span ${layout.expectedCardHeight}`);
    assert.equal(layout.frameAspect, "auto");
    assert.match(layout.hitClass, /panel-resize-handle/);
    assert.equal(layout.handleZIndex, "12");
    assert.ok(layout.legendColumns >= 4, `wide workspace legends should compact into more than two columns, got ${layout.legendColumns}`);
    assert.ok(layout.legend.height <= 56, `workspace legend should not starve the chart, got ${layout.legend.height}`);
    assert.ok(layout.legendScrollHeight <= 56, `wide 10-run legends should fit without hidden overflow, got ${layout.legendScrollHeight}`);
    assert.ok(layout.frame.height >= 260, `chart frame should remain W&B-like in a compact 10-run panel, got ${layout.frame.height}`);
    assert.ok(layout.lowerDeadSpace <= 18, `chart area should not leave a dead bottom gutter, got ${layout.lowerDeadSpace}`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});
