import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../../..");
const configUrl = pathToFileURL(path.join(repo, "apps", "web", "next.config.mjs")).href;

test("Next API rewrites use staging when INSTANTML_WEB_API_ENV requests staging", () => {
  const rewrites = loadRewrites({
    INSTANTML_WEB_API_ENV: "staging",
    INSTANTML_API_BASE: "https://api.instantml.ai",
    INSTANTML_CONTROL_API_BASE: "https://api.instantml.ai",
    INSTANTML_DATA_API_BASE: "https://api.instantml.ai",
  });
  assertRewriteDestinations(rewrites, "https://staging.api.instantml.ai");
});

test("Next API rewrites default pushed frontend target to prod when env selects prod", () => {
  const rewrites = loadRewrites({
    INSTANTML_WEB_API_ENV: "prod",
    INSTANTML_API_BASE: "https://staging.api.instantml.ai",
    INSTANTML_CONTROL_API_BASE: "https://staging.api.instantml.ai",
    INSTANTML_DATA_API_BASE: "https://staging.api.instantml.ai",
  });
  assertRewriteDestinations(rewrites, "https://api.instantml.ai");
});

test("Next API rewrites reject unknown hosted API environments", () => {
  const result = importConfig({
    INSTANTML_WEB_API_ENV: "qa",
    INSTANTML_API_BASE: "https://api.instantml.ai",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /INSTANTML_WEB_API_ENV must be prod or staging/);
});

function loadRewrites(extraEnv) {
  const result = importConfig(extraEnv);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function importConfig(extraEnv) {
  const script = `
    const config = (await import(${JSON.stringify(`${configUrl}?case=${Date.now()}-${Math.random()}`)})).default;
    const rewrites = await config.rewrites();
    console.log(JSON.stringify(rewrites));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "production",
      ...extraEnv,
    },
  });
}

function assertRewriteDestinations(rewrites, expectedBase) {
  assert.ok(rewrites.length > 0);
  for (const rewrite of rewrites) {
    assert.ok(
      rewrite.destination.startsWith(expectedBase),
      `${rewrite.source} routed to ${rewrite.destination}`,
    );
  }
}
