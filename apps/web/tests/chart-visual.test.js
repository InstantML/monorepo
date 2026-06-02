import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function runVisualHarness() {
  return spawnSync(process.execPath, ["apps/web/tests/chart-visual.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CHART_SCREENS_DIR: process.env.CHART_SCREENS_DIR || "/tmp/chart-screens",
    },
  });
}

function installChromium() {
  return spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "install", "chromium"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function missingPlaywrightBrowser(result) {
  return /Executable doesn't exist|Looks like Playwright was just installed or updated|playwright install/.test(result.stderr ?? "");
}

test("chart visual harness renders every scenario without console errors", { timeout: 180_000 }, () => {
  let result = runVisualHarness();
  if (result.status !== 0 && missingPlaywrightBrowser(result)) {
    const install = installChromium();
    assert.equal(
      install.status,
      0,
      `failed to install Playwright Chromium for chart visual harness\nSTDOUT:\n${install.stdout}\nSTDERR:\n${install.stderr}`,
    );
    result = runVisualHarness();
  }
  assert.equal(
    result.status,
    0,
    `chart-visual.mjs failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
});
