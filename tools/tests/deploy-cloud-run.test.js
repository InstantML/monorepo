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
    INSTANTML_CLOUD_RUN_CONTROL_MAX_INSTANCES: "2",
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

test("deploy helper requires hosted frontend base for Resend invites", () => {
  const result = runDeploy(["--topology=split"], {
    RESEND_API_KEY: "re_test_key",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set INSTANTML_FRONTEND_BASE_URL/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper requires a verified sender for Resend invites", () => {
  const result = runDeploy(["--topology=split"], {
    RESEND_API_KEY: "re_test_key",
    INSTANTML_FRONTEND_BASE_URL: "https://staging.instantml.ai",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set INSTANTML_EMAIL_FROM/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper requires a matching Clerk publishable key for managed Clerk", () => {
  const result = runDeploy(["--topology=split"], {
    CLERK_SECRET_KEY: "sk_test_example",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_JWT_ISSUER: "",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper rejects Clerk issuer and publishable key mismatches", () => {
  const result = runDeploy(["--topology=split"], {
    CLERK_SECRET_KEY: "sk_test_example",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"),
    CLERK_JWT_ISSUER: "https://other-clerk-instance.clerk.accounts.dev",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper rejects mismatched Clerk publishable key sources", () => {
  const result = runDeploy(["--topology=split"], {
    CLERK_SECRET_KEY: "sk_test_example",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"),
    CLERK_PUBLISHABLE_KEY: clerkPublishableKey("other-clerk-instance.clerk.accounts.dev"),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use one Clerk publishable key/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper rejects Clerk secret and publishable environment mismatches", () => {
  const result = runDeploy(["--topology=split"], {
    CLERK_SECRET_KEY: "sk_live_example",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use keys from the same Clerk environment/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper rejects unsafe Clerk API base before validating secrets", () => {
  const result = runDeploy(["--topology=split"], {
    CLERK_SECRET_KEY: "sk_test_example",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"),
    CLERK_API_BASE: "http://api.clerk.com",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLERK_API_BASE must be an https origin/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper rejects custom Clerk API base without explicit override", () => {
  const result = runDeploy(["--topology=split"], {
    CLERK_SECRET_KEY: "sk_test_example",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey("modern-mustang-72.clerk.accounts.dev"),
    CLERK_API_BASE: "https://api.example.com",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLERK_API_BASE must be https:\/\/api\.clerk\.com/);
  assert.deepEqual(result.gcloudCalls, [
    "config get-value project",
    "--quiet --project instantml-test-project config get-value account",
  ]);
});

test("deploy helper pins Cloud Run Clerk issuer from the frontend publishable key", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  assert.match(source, /const webFileEnv = loadDotenv\(webEnvFile\)/);
  assert.match(source, /function clerkApiBaseForDeployment/);
  assert.match(source, /INSTANTML_CLOUD_RUN_ALLOW_CUSTOM_CLERK_API_BASE/);
  assert.match(source, /function clerkIssuerFromPublishableKey/);
  assert.match(source, /function validateClerkSecretMatchesPublishableKey/);
  assert.match(source, /\/v1\/domains/);
  assert.match(source, /frontend_api_url/);
  assert.match(source, /function validateClerkDeploymentConfig/);
  assert.match(source, /CLERK_JWT_ISSUER: clerkJwtIssuer/);
  assert.match(source, /Use the public and secret keys from the same Clerk application/);
  assert.match(source, /managed Clerk must be enabled in Cloud Run/);
  assert.match(source, /data-plane auth config must not expose managed Clerk/);
  assert.match(source, /only control-plane auth config may expose clerk_jwt_issuer/);
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

test("deploy helper scopes provider secrets to the service planes that need them", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  assert.match(source, /function cloudflareR2AccountId/);
  assert.match(source, /CLOUDFLARE_R2_ACCOUNT_ID/);
  assert.match(source, /function runtimeEnvForTarget/);
  assert.match(source, /function secretEnvForTarget/);
  assert.match(source, /target\.servicePlane === "control"/);
  assert.match(source, /target\.servicePlane === "data"/);
  assert.match(source, /!mapping\.startsWith\("CLOUDFLARE_"\)/);
  assert.match(source, /!mapping\.startsWith\("RESEND_API_KEY="/);
});

test("deploy helper keeps prod warm and staging bounded to one auto instance", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  assert.match(source, /const stagingScaleToZero = deploymentEnv === "staging"/);
  assert.match(source, /scalingFor\("INSTANTML_CLOUD_RUN", stagingScaleToZero \? "auto" : "manual", "1"\)/);
  assert.match(source, /scalingFor\("INSTANTML_CLOUD_RUN_CONTROL", stagingScaleToZero \? "auto" : "manual", "1"\)/);
  assert.match(source, /scalingFor\("INSTANTML_CLOUD_RUN_DATA", stagingScaleToZero \? "auto" : "manual", "1"/);
  assert.match(source, /function isSingleInstanceBounded/);
  assert.match(source, /--max-instances/);
  assert.match(source, /--min-instances/);
  assert.match(source, /function appendStartupProbeArgs/);
  assert.match(source, /httpGet\.path=\/readyz/);
  assert.match(source, /--startup-probe/);
});

test("deploy helper has cost-aware static egress knobs", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  assert.match(source, /INSTANTML_CLOUD_RUN_VPC_EGRESS/);
  assert.match(source, /function normalizeVpcEgress/);
  assert.match(source, /private-ranges-only/);
  assert.match(source, /const enableNatLogging = boolValue\("INSTANTML_CLOUD_RUN_NAT_LOGGING", false\)/);
  assert.match(source, /if \(enableNatLogging\) args\.push\("--enable-logging", "--log-filter", "ERRORS_ONLY"\)/);
  assert.match(source, /"--vpc-egress", vpcEgress/);
});

test("deploy helper defaults hosted ClickHouse provisioning to database mode", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  assert.match(source, /function normalizeClickHouseProvisioner/);
  assert.match(source, /value\("INSTANTML_CLICKHOUSE_PROVISIONER"\) \|\| "database"/);
  assert.match(source, /INSTANTML_CLICKHOUSE_PROVISIONER: clickhouseProvisioner/);
  assert.match(source, /clickhouseProvisioner === "cloud-service"/);
  assert.doesNotMatch(source, /INSTANTML_CLICKHOUSE_PROVISIONER: "cloud-service"/);
});

test("deploy helper keeps public router control paths and backend timeout complete", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  for (const path of [
    "/api/auth/*",
    "/api/invitations/*",
    "/api/billing/*",
    "/api/dashboard/preferences",
    "/api/users/*",
    "/api/orgs/*",
    "/api/workspace-views/*",
  ]) {
    assert.match(source, new RegExp(path.replaceAll("/", "\\/").replaceAll("*", "\\*")));
  }
  assert.match(source, /function backendServiceTimeout/);
  assert.match(source, /--timeout", backendServiceTimeout\(\)/);
  assert.match(source, /Timeout sec is not supported for a backend service with Serverless network endpoint groups/);
  assert.match(source, /function resetPreAttachTimeoutForServerlessBackend/);
});

test("deploy helper has isolated staging defaults", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

  assert.match(source, /normalizeDeploymentEnv/);
  assert.match(source, /instantml-staging/);
  assert.match(source, /staging\.api\.instantml\.ai/);
  assert.match(source, /INSTANTML_STAGING_USER_DATA_DATABASE/);
  assert.match(source, /function scopedSecret/);
  assert.match(source, /instantml_user_data_staging/);
  assert.match(pkg.scripts["deploy:cloud-run:staging"], /--environment=staging --public-router/);
});

test("deploy helper supports --from-secret-manager for CI deploys", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  // CLI flag, process env, and CI auto-detection all reach the same resolver.
  assert.match(source, /--from-secret-manager/);
  assert.match(source, /INSTANTML_FROM_SECRET_MANAGER/);
  assert.match(source, /function resolveFromSecretManager/);
  assert.match(source, /GITHUB_ACTIONS/);
  // Hydration calls Secret Manager up front so the Clerk consistency check
  // (which already saved a deploy from a stale publishable key) keeps running
  // against the live secret store, not a stale .env on a laptop.
  assert.match(source, /function hydrateEnvFromSecretManager/);
  assert.match(source, /secrets", "versions", "access", "latest"/);
  assert.match(source, /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  // syncSecrets must not push a duplicate version when CI hydrated the value
  // from the same secret; otherwise every deploy creates a no-op version.
  assert.match(source, /Skipping versions add for \$\{scopedSecretName\}/);
});

test("deploy helper keeps writing the local frontend env off in CI mode", () => {
  const source = fs.readFileSync(path.join(repo, "tools", "deploy-cloud-run.mjs"), "utf8");

  assert.match(
    source,
    /boolValue\("INSTANTML_WRITE_LOCAL_FRONTEND_ENV", !fromSecretManager\)/,
  );
});

test("GitHub Actions deploy workflow gates on stable quality gates and uses WIF", () => {
  const workflowPath = path.join(repo, ".github", "workflows", "deploy-cloud-run.yml");
  const source = fs.readFileSync(workflowPath, "utf8");

  // Workflow surface: manual button + tag push.
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /tags:[\s\S]*deploy-\*/);
  assert.match(source, /tags:[\s\S]*release-\*/);
  // Gate on the existing CI workflow before promoting any image. We use the
  // GitHub REST API to look up the latest ci.yml run for the deploy SHA
  // rather than `workflow_run`, which cannot be combined with
  // workflow_dispatch/push and would not trigger on a tag push.
  assert.match(source, /Require Stable Quality Gates/);
  assert.match(source, /actions\/workflows\/ci\.yml\/runs/);
  // No static GCP service-account JSON — workload identity federation only.
  assert.match(source, /google-github-actions\/auth/);
  assert.match(source, /workload_identity_provider:/);
  assert.match(source, /vars\.GCP_WIF_PROVIDER/);
  assert.match(source, /vars\.GCP_DEPLOY_SERVICE_ACCOUNT/);
  assert.doesNotMatch(source, /credentials_json:/);
  // Production environment gate (manual reviewers attached via repo settings).
  // The job-level `environment.name` must reference the dispatch input with a
  // 'prod' default so the GitHub Environment with required reviewers is the
  // gate for any GCP mutation. The comment regex allows interleaved lines.
  assert.match(
    source,
    /name: \$\{\{ github\.event\.inputs\.environment \|\| 'prod' \}\}/,
  );
  // Reuse the existing deploy logic — don't reimplement it in YAML.
  assert.match(source, /tools\/deploy-cloud-run\.mjs/);
  assert.match(source, /--from-secret-manager/);
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
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GCP_PROJECT: "",
    INSTANTML_CLOUD_RUN_TOPOLOGY: "",
    INSTANTML_CLOUD_RUN_UNSAFE_DATA_MULTI_WRITER: "",
    CLERK_SECRET_KEY: "",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_JWT_ISSUER: "",
    // The deploy helper auto-enables --from-secret-manager when running under
    // GitHub Actions (CI=true && GITHUB_ACTIONS=true). These unit tests stub
    // gcloud to a single `config get-value project` call and would otherwise
    // panic on the unexpected `gcloud secrets versions access` hydration
    // calls. Force the local code path so the tests stay deterministic in CI.
    CI: "",
    GITHUB_ACTIONS: "",
    INSTANTML_FROM_SECRET_MANAGER: "",
    ...env,
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

function clerkPublishableKey(host) {
  const encoded = Buffer.from(`${host}$`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `pk_test_${encoded}`;
}
