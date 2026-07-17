import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../../..");
const configUrl = pathToFileURL(path.join(repo, "apps", "web", "next.config.mjs")).href;

test("Next API rewrites use staging when INSTANTML_WEB_API_ENV requests staging", () => {
  const rewrites = loadConfigList("rewrites", {
    INSTANTML_WEB_API_ENV: "staging",
    INSTANTML_API_BASE: "https://api.instantml.ai",
    INSTANTML_CONTROL_API_BASE: "https://api.instantml.ai",
    INSTANTML_DATA_API_BASE: "https://api.instantml.ai",
  });
  assertRewriteDestinations(apiProxyRewrites(rewrites), "https://staging.api.instantml.ai");
});

test("Next API rewrites default pushed frontend target to prod when env selects prod", () => {
  const rewrites = loadConfigList("rewrites", {
    INSTANTML_WEB_API_ENV: "prod",
    INSTANTML_API_BASE: "https://staging.api.instantml.ai",
    INSTANTML_CONTROL_API_BASE: "https://staging.api.instantml.ai",
    INSTANTML_DATA_API_BASE: "https://staging.api.instantml.ai",
  });
  assertRewriteDestinations(apiProxyRewrites(rewrites), "https://api.instantml.ai");
});

test("Next API rewrites allow explicit staging split bases for hosted frontend smoke", () => {
  const controlBase = "https://instantml-staging-control.example.run.app";
  const dataBase = "https://instantml-staging-data.example.run.app";
  const rewrites = loadConfigList("rewrites", {
    INSTANTML_WEB_API_ENV: "staging",
    INSTANTML_WEB_EXPLICIT_API_BASES: "1",
    INSTANTML_API_BASE: controlBase,
    INSTANTML_CONTROL_API_BASE: controlBase,
    INSTANTML_DATA_API_BASE: dataBase,
    INSTANTML_API_ALLOWED_ORIGINS: `${controlBase},${dataBase}`,
  });
  assertRewriteDestinations(rewrites.filter((rewrite) => rewrite.source.startsWith("/api/auth")), controlBase);
  assertRewriteDestinations(rewrites.filter((rewrite) => rewrite.source.startsWith("/api/reports")), dataBase);
  assertRewriteDestinations(rewrites.filter((rewrite) => rewrite.source === "/api/:path*" || rewrite.source === "/projects"), dataBase);
});

test("Next rewrites proxy the bare /runs collection route to the data plane", () => {
  const rewrites = loadConfigList("rewrites", {
    INSTANTML_WEB_API_ENV: "prod",
    INSTANTML_API_BASE: "https://api.instantml.ai",
  });
  // The wildcard "/runs/:path*" rule alone compiles an empty ":path*" to
  // "/runs/" in the deployed rewrite layer, which the API 404s. Reports
  // runset queries depend on an exact "/runs" rule.
  const exact = rewrites.find((rewrite) => rewrite.source === "/runs");
  assert.ok(exact, "missing exact /runs rewrite");
  assert.equal(exact.destination, "https://api.instantml.ai/runs");
});

test("Next API rewrites reject unknown hosted API environments", () => {
  const result = importConfig("rewrites", {
    INSTANTML_WEB_API_ENV: "qa",
    INSTANTML_API_BASE: "https://api.instantml.ai",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /INSTANTML_WEB_API_ENV must be prod or staging/);
});

test("Next docs route is owned by the app router, not config redirects", () => {
  const redirects = loadOptionalConfigList("redirects", {
    INSTANTML_WEB_API_ENV: "prod",
    INSTANTML_API_BASE: "https://api.instantml.ai",
  });
  assert.deepEqual(redirects.filter((redirect) => redirect.source.startsWith("/docs")), []);
});

test("production security headers do not allow eval", () => {
  const headers = loadConfigList("headers", {
    INSTANTML_WEB_API_ENV: "prod",
    INSTANTML_API_BASE: "https://api.instantml.ai",
  });
  const csp = headers
    .flatMap((entry) => entry.headers ?? [])
    .find((header) => header.key === "Content-Security-Policy")?.value ?? "";
  assert.match(csp, /script-src/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
});

function loadConfigList(method, extraEnv) {
  const result = importConfig(method, extraEnv);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function loadOptionalConfigList(method, extraEnv) {
  const result = importConfig(method, extraEnv, { optional: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function importConfig(method, extraEnv, options = {}) {
  const script = `
    const config = (await import(${JSON.stringify(`${configUrl}?case=${Date.now()}-${Math.random()}`)})).default;
    const method = config[${JSON.stringify(method)}];
    const result = typeof method === "function" ? await method() : ${options.optional ? "[]" : "undefined"};
    console.log(JSON.stringify(result));
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

function apiProxyRewrites(rewrites) {
  return rewrites.filter((rewrite) => /^https?:\/\//.test(rewrite.destination));
}
