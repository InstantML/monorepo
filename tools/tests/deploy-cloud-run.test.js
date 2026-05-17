import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../..");

test("deploy helper rejects unsafe data replicas before cloud mutation", () => {
  const result = runDeploy(["--topology=split", "--data-instances=3"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared data cells are single-writer/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper rejects unsafe control scaling before cloud mutation", () => {
  const result = runDeploy(["--topology=split"], {
    INSTANTML_CLOUD_RUN_CONTROL_SCALING: "auto",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /control-plane auth\/org\/API-key projections are single-writer/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper requires an HTTPS DNS name before creating a public router", () => {
  const result = runDeploy(["--topology=split"], {
    INSTANTML_CLOUD_RUN_PUBLIC_ROUTER: "1",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper rejects cleartext hosted public API bases", () => {
  const result = runDeploy(["--topology=split"], {
    INSTANTML_PUBLIC_API_BASE: "http://203.0.113.10",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /INSTANTML_PUBLIC_API_BASE must use https/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper keeps public routing HTTPS-only", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  assert.match(source, /target-https-proxies/);
  assert.match(source, /publicRouterDnsStatus/);
  assert.match(source, /pendingPublicRouter/);
  assert.match(source, /forwardingRuleAllowsPort/);
  assert.match(source, /rejectCleartextRouterResources/);
  assert.doesNotMatch(source, /target-http-proxies", "create/);
  assert.doesNotMatch(source, /--ports", "80/);
});

function runDeploy(args, env = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-deploy-test-"));
  const binDir = path.join(tempDir, "bin");
  const logFile = path.join(tempDir, "gcloud.log");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "gcloud"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const logFile = ${JSON.stringify(logFile)};
const args = process.argv.slice(2);
fs.appendFileSync(logFile, args.join(" ") + "\\n");
if (args.join(" ") === "config get-value project") {
  console.log("instantml-test-project");
  process.exit(0);
}
console.error("unexpected gcloud call: " + args.join(" "));
process.exit(2);
`,
  );
  fs.chmodSync(path.join(binDir, "gcloud"), 0o755);
  const childEnv = {
    ...process.env,
    ...env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GCP_PROJECT: "",
    INSTANTML_CLOUD_RUN_TOPOLOGY: "",
    INSTANTML_CLOUD_RUN_UNSAFE_DATA_MULTI_WRITER: "",
  };
  delete childEnv.NODE_V8_COVERAGE;
  const result = spawnSync(process.execPath, ["tools/deploy-cloud-run.mjs", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: childEnv,
  });
  const gcloudCalls = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { ...result, gcloudCalls };
}
