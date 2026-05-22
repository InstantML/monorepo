#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = process.cwd();
const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
  console.log(`Usage:
  npm run deploy:cloud-run
  npm run deploy:cloud-run:single
  npm run deploy:cloud-run:multi
  node tools/deploy-cloud-run.mjs --topology=single|split [--public-router] [--data-instances=N]

Environment:
  GCP_PROJECT                         Google Cloud project id.
  GCP_REGION                          Deployment region. Default: us-central1.
  INSTANTML_CLOUD_RUN_TOPOLOGY         single or split. Default: split.
  INSTANTML_CLOUD_RUN_SERVICE          Combined service name. Default: instantml-rust-api.
  INSTANTML_CLOUD_RUN_SERVICE_PREFIX   Split service name prefix. Default: instantml.
  INSTANTML_CLOUD_RUN_CONTROL_SERVICE  Split control service name. Default: instantml-control.
  INSTANTML_CLOUD_RUN_DATA_SERVICE     Split data service name. Default: instantml-data-<region>-a.
  INSTANTML_CLOUD_RUN_CONTROL_SCALING  auto or manual. Default: manual.
  INSTANTML_CLOUD_RUN_DATA_SCALING     auto or manual. Default: manual.
  INSTANTML_CLOUD_RUN_DATA_INSTANCES   Manual data instances. Default: 1.
  INSTANTML_CLOUD_RUN_UNSAFE_DATA_MULTI_WRITER=1  Permit data scaling above one instance for controlled tests only.
  INSTANTML_CLOUD_RUN_UNSAFE_CONTROL_MULTI_INSTANCE=1  Permit control scaling above one instance for controlled tests only.
  INSTANTML_CLOUD_RUN_DATA_SESSION_AFFINITY  Enable Cloud Run session affinity for data as an optimization, not correctness.
  INSTANTML_CLOUD_RUN_PUBLIC_ROUTER    Create/update a global HTTPS Application Load Balancer for split deploys.
  INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN  Required HTTPS DNS name for the public router, for example api.instantml.ai.
  INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_NAME  Public router resource name prefix. Default: instantml-public-api.
  INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_CERTIFICATE  Managed SSL certificate name. Default: <router-name>-cert.
  INSTANTML_PUBLIC_API_BASE            Optional public LB/router URL written to local frontend env.
  INSTANTML_SIGNUP_ALLOWED_EMAILS      Comma-separated hosted signup allowlist.
  INSTANTML_ALLOWED_FRONTEND_ORIGINS   Comma-separated browser origins allowed for session mutations.
  INSTANTML_ARTIFACT_BACKEND            local or r2. Defaults to r2 when Cloudflare R2 credentials are present.
  CLOUDFLARE_ACCOUNT_ID                 Cloudflare account id for R2 buckets.
  CLOUDFLARE_R2_API_KEY                 Cloudflare API token with Workers R2 Storage read/write permissions.
  CLOUDFLARE_R2_ACCESS_KEY_ID           Optional R2 S3 access key id; API-token id is derived when omitted.
  CLOUDFLARE_R2_SECRET_ACCESS_KEY       Optional R2 S3 secret; API-token SHA-256 is used when omitted.
  STRIPE_SECRET_KEY                      Optional Stripe Billing secret key for Checkout and Portal.
  STRIPE_WEBHOOK_SECRET                  Optional Stripe webhook signing secret.
  STRIPE_PRO_PRICE_ID                    Optional Stripe monthly Pro price id.
  STRIPE_PREMIUM_PRICE_ID                Optional Stripe monthly Premium price id.
  STRIPE_EXTRA_SEAT_PRICE_ID             Optional Stripe monthly extra-seat price id.
  STRIPE_STORAGE_OVERAGE_PRICE_ID        Optional Stripe metered storage overage price id.
  STRIPE_STORAGE_METER_ID                Optional Stripe Billing Meter id for storage overage.
  INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME Optional Stripe meter event name for retained-storage overage.
  INSTANTML_CLOUD_RUN_STATIC_EGRESS=0  Disable static egress setup and manual ClickHouse allowlisting.
  INSTANTML_CLICKHOUSE_ALLOWLIST_SERVICES=none  Skip service access-list updates.
  INSTANTML_CLICKHOUSE_ALLOWLIST_KEYS=none      Skip Cloud API-key access-list updates.
`);
  process.exit(0);
}
const envFile = path.join(repo, ".env");
const webEnvFile = path.join(repo, "apps", "web", ".env.local");
const fileEnv = loadDotenv(envFile);
const env = { ...fileEnv, ...process.env };

const configuredProject = spawnSync("gcloud", ["config", "get-value", "project"], {
  cwd: repo,
  encoding: "utf8",
});
const project = value("GCP_PROJECT") || configuredProject.stdout.trim();
if (!project || project === "(unset)") fail("Set GCP_PROJECT or run `gcloud config set project <project-id>`.");

const region = value("GCP_REGION") || value("CLOUDSDK_RUN_REGION") || value("GOOGLE_CLOUD_REGION") || "us-central1";
const topology = normalizeTopology(cli.topology || value("INSTANTML_CLOUD_RUN_TOPOLOGY") || "split");
const service = value("INSTANTML_CLOUD_RUN_SERVICE") || "instantml-rust-api";
const servicePrefix = value("INSTANTML_CLOUD_RUN_SERVICE_PREFIX") || "instantml";
const controlService = value("INSTANTML_CLOUD_RUN_CONTROL_SERVICE") || `${servicePrefix}-control`;
const dataCellId = value("INSTANTML_CLOUD_RUN_DATA_CELL") || `${region}-a`;
const dataService = value("INSTANTML_CLOUD_RUN_DATA_SERVICE") || `${servicePrefix}-data-${slug(dataCellId)}`;
const repository = value("INSTANTML_ARTIFACT_REPOSITORY") || "instantml";
const network = value("INSTANTML_CLOUD_RUN_NETWORK") || "instantml-cloud-run";
const subnet = value("INSTANTML_CLOUD_RUN_SUBNET") || `instantml-cloud-run-${region}`;
const subnetRange = value("INSTANTML_CLOUD_RUN_SUBNET_RANGE") || "10.90.0.0/24";
const addressName = value("INSTANTML_CLOUD_RUN_EGRESS_ADDRESS") || `instantml-cloud-run-egress-${region}`;
const routerName = value("INSTANTML_CLOUD_RUN_ROUTER") || `instantml-cloud-run-router-${region}`;
const natName = value("INSTANTML_CLOUD_RUN_NAT") || `instantml-cloud-run-nat-${region}`;
const serviceAccountName = value("INSTANTML_CLOUD_RUN_SERVICE_ACCOUNT") || "instantml-rust-api";
const activeAccount = capture(["config", "get-value", "account"]).trim();
const imageTag = value("INSTANTML_IMAGE_TAG") || gitShortSha() || timestampTag();
const imageName = value("INSTANTML_IMAGE_NAME") || (topology === "split" ? "instantml-rust-server" : service);
const image = `${region}-docker.pkg.dev/${project}/${repository}/${imageName}:${imageTag}`;
const useStaticEgress = boolValue("INSTANTML_CLOUD_RUN_STATIC_EGRESS", true);
const updateClickHouseServiceAllowlist = value("INSTANTML_CLICKHOUSE_ALLOWLIST_SERVICES") !== "none";
const updateClickHouseKeyAllowlist = value("INSTANTML_CLICKHOUSE_ALLOWLIST_KEYS") !== "none";
const writeLocalEnv = boolValue("INSTANTML_WRITE_LOCAL_FRONTEND_ENV", true);
const publicRouterEnabled = topology === "split"
  && (cli.publicRouter ?? boolValue("INSTANTML_CLOUD_RUN_PUBLIC_ROUTER", false));
const publicRouterName = slug(value("INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_NAME") || `${servicePrefix}-public-api`);
const allowUnsafeDataMultiWriter = boolValue("INSTANTML_CLOUD_RUN_UNSAFE_DATA_MULTI_WRITER", false);
const allowUnsafeControlMultiInstance = boolValue("INSTANTML_CLOUD_RUN_UNSAFE_CONTROL_MULTI_INSTANCE", false);
const deploymentPlan = deploymentTargets();
validateDeploymentTargets(deploymentPlan);
validatePublicRouterConfig();
validateExplicitPublicApiBaseConfig();

preflightBuildContext();
ensureGcloudAuth();
enableServices();
ensureArtifactRepository();
const serviceAccountEmail = ensureServiceAccount();
ensureCloudBuildServiceAccount();
const staticEgressIp = useStaticEgress ? ensureStaticEgress() : "";
const secretEnv = syncSecrets(serviceAccountEmail);
const baseEnvVars = buildRuntimeEnv(staticEgressIp, activeAccount);
if (staticEgressIp && (updateClickHouseServiceAllowlist || updateClickHouseKeyAllowlist)) {
  await updateClickHouseAccessLists(staticEgressIp);
}
buildImage();
const deployments = [];
for (const target of deploymentPlan) {
  const envVars = {
    ...baseEnvVars,
    INSTANTML_SERVICE_PLANE: target.servicePlane,
  };
  if (target.cellId) envVars.INSTANTML_CELL_ID = target.cellId;
  const url = deployService(
    target,
    serviceAccountEmail,
    staticEgressIp,
    runtimeEnvForTarget(envVars, target),
    secretEnvForTarget(secretEnv, target),
  );
  await verifyService(url, target);
  deployments.push({ ...target, url });
}
const publicRouter = publicRouterEnabled ? await ensurePublicRouter(deployments) : null;
const explicitPublicApiBase = publicRouterEnabled
  ? ""
  : normalizedPublicApiBase(value("INSTANTML_PUBLIC_API_BASE"));
const publicApiBase = publicRouter?.url
  || explicitPublicApiBase
  || (topology === "single" ? deployments[0]?.url : "");
if (writeLocalEnv) {
  const controlDeployment = deployments.find((target) => target.servicePlane === "control");
  const dataDeployment = deployments.find((target) => target.servicePlane === "data");
  if (publicApiBase) {
    const localFrontendEnv = {
      INSTANTML_API_BASE: publicApiBase,
      INSTANTML_CONTROL_API_BASE: publicApiBase,
      INSTANTML_DATA_API_BASE: publicApiBase,
      INSTANTML_API_ALLOWED_ORIGINS: publicApiBase,
    };
    updateDotenv(envFile, localFrontendEnv);
    updateDotenv(webEnvFile, localFrontendEnv);
  } else if (topology === "split" && controlDeployment?.url && dataDeployment?.url) {
    const localFrontendEnv = {
      INSTANTML_CONTROL_API_BASE: controlDeployment.url,
      INSTANTML_DATA_API_BASE: dataDeployment.url,
      INSTANTML_API_ALLOWED_ORIGINS: uniqueOrigins([controlDeployment.url, dataDeployment.url]).join(","),
    };
    updateDotenv(envFile, localFrontendEnv);
    updateDotenv(webEnvFile, localFrontendEnv);
  } else {
    console.warn("Split deployment did not update local frontend env; set INSTANTML_PUBLIC_API_BASE to your load balancer/router URL.");
  }
}

console.log(JSON.stringify({
  status: "ok",
  project,
  region,
  topology,
  image,
  service_account: serviceAccountEmail,
  static_egress_ip: staticEgressIp || null,
  deployments: deployments.map(({ service, servicePlane, scaling, url, cellId }) => ({
    service,
    service_plane: servicePlane,
    scaling,
    cell_id: cellId || null,
    url,
  })),
  public_router: publicRouter,
  public_api_base: publicApiBase || null,
  local_frontend: topology === "split" && !value("INSTANTML_PUBLIC_API_BASE") && !publicRouter
    ? "npm run web:dev (uses INSTANTML_CONTROL_API_BASE and INSTANTML_DATA_API_BASE)"
    : "npm run web:dev",
}, null, 2));

function parseArgs(args) {
  const output = { help: false, topology: "", publicRouter: undefined, dataInstances: "" };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") output.help = true;
    if (arg.startsWith("--topology=")) output.topology = arg.slice("--topology=".length);
    if (arg === "--public-router") output.publicRouter = true;
    if (arg === "--no-public-router") output.publicRouter = false;
    if (arg.startsWith("--data-instances=")) output.dataInstances = arg.slice("--data-instances=".length);
  }
  return output;
}

function value(key) {
  const raw = env[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

function normalizeTopology(raw) {
  const value = raw.trim().toLowerCase();
  if (["single", "combined"].includes(value)) return "single";
  if (["split", "multi", "multi-instance", "multi_instance"].includes(value)) return "split";
  fail("INSTANTML_CLOUD_RUN_TOPOLOGY must be single or split.");
}

function deploymentTargets() {
  if (topology === "single") {
    return [{
      service,
      servicePlane: "combined",
      scaling: automaticScaling("INSTANTML_CLOUD_RUN", "1"),
    }];
  }
  return [
    {
      service: controlService,
      servicePlane: "control",
      scaling: scalingFor("INSTANTML_CLOUD_RUN_CONTROL", "manual", "1"),
    },
    {
      service: dataService,
      servicePlane: "data",
      cellId: dataCellId,
      scaling: scalingFor("INSTANTML_CLOUD_RUN_DATA", "manual", "1", { manualInstances: cli.dataInstances || "1" }),
    },
  ].map((target) => ({
    ...target,
    sessionAffinity: sessionAffinityFor(target),
  }));
}

function sessionAffinityFor(target) {
  const explicit = value(`INSTANTML_CLOUD_RUN_${target.servicePlane.toUpperCase()}_SESSION_AFFINITY`);
  if (explicit) return boolValue(`INSTANTML_CLOUD_RUN_${target.servicePlane.toUpperCase()}_SESSION_AFFINITY`, false);
  return false;
}

function validateDeploymentTargets(targets) {
  for (const target of targets) {
    if (target.servicePlane === "control" && !allowUnsafeControlMultiInstance && !isSingleManualInstance(target)) {
      fail(`${target.service} requested control scaling ${JSON.stringify(target.scaling)}, but control-plane auth/org/API-key projections are single-writer until durable refresh/uniqueness gates land. Use INSTANTML_CLOUD_RUN_UNSAFE_CONTROL_MULTI_INSTANCE=1 only for controlled tests; do not deploy it for production traffic.`);
    }
    if (target.servicePlane === "data" && !allowUnsafeDataMultiWriter && !isSingleManualInstance(target)) {
      fail(`${target.service} requested data scaling ${JSON.stringify(target.scaling)}, but shared data cells are single-writer until durable multi-writer gates land. Use INSTANTML_CLOUD_RUN_UNSAFE_DATA_MULTI_WRITER=1 only for controlled tests; do not deploy it for production traffic.`);
    }
  }
}

function isSingleManualInstance(target) {
  return target.scaling.mode === "manual" && String(target.scaling.instances) === "1";
}

function validatePublicRouterConfig() {
  if (publicRouterEnabled) publicRouterDomain();
}

function validateExplicitPublicApiBaseConfig() {
  if (!value("INSTANTML_PUBLIC_API_BASE") || publicRouterEnabled) return;
  normalizedPublicApiBase(value("INSTANTML_PUBLIC_API_BASE"));
}

function normalizedPublicApiBase(raw) {
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("INSTANTML_PUBLIC_API_BASE must be an http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    fail("INSTANTML_PUBLIC_API_BASE must be an http(s) URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!loopback && url.protocol !== "https:") {
    fail("INSTANTML_PUBLIC_API_BASE must use https for non-loopback hosted APIs.");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function scalingFor(prefix, fallbackMode, fallbackMax, options = {}) {
  const mode = (value(`${prefix}_SCALING`) || fallbackMode).toLowerCase();
  if (mode === "manual") {
    return {
      mode: "manual",
      instances: value(`${prefix}_INSTANCES`) || options.manualInstances || "1",
    };
  }
  if (mode !== "auto" && mode !== "automatic") {
    fail(`${prefix}_SCALING must be auto or manual.`);
  }
  return automaticScaling(prefix, fallbackMax);
}

function automaticScaling(prefix, fallbackMax) {
  return {
    mode: "auto",
    min: value(`${prefix}_MIN_INSTANCES`) || "0",
    max: value(`${prefix}_MAX_INSTANCES`) || fallbackMax,
  };
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "cell";
}

function boolValue(key, fallback) {
  const raw = value(key);
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function loadDotenv(file) {
  if (!fs.existsSync(file)) return {};
  const output = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let raw = match[2].trim();
    if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    output[match[1]] = raw;
  }
  return output;
}

function updateDotenv(file, updates) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${val}`);
  }
  fs.writeFileSync(file, next.join("\n").replace(/\n*$/, "\n"));
}

function uniqueOrigins(urls) {
  return [...new Set(urls.map((url) => new URL(url).origin))];
}

function preflightBuildContext() {
  const dockerignorePath = path.join(repo, ".dockerignore");
  if (!fs.existsSync(dockerignorePath)) fail(".dockerignore is required before uploading a Cloud Build context.");
  const ignored = fs.readFileSync(dockerignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const required of [".git", ".env", ".instantml", "node_modules", "target", "apps/rust-server/target"]) {
    if (!ignored.includes(required)) {
      fail(`.dockerignore must exclude ${required} before Cloud Build upload.`);
    }
  }
}

function ensureGcloudAuth() {
  const auth = capture(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]).trim();
  if (!auth) fail("No active gcloud account. Run `gcloud auth login` first.");
  console.log(`Using gcloud account ${auth} in project ${project}.`);
}

function enableServices() {
  run(["services", "enable",
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
  ]);
}

function ensureArtifactRepository() {
  const exists = quiet(["artifacts", "repositories", "describe", repository, "--location", region]);
  if (exists) return;
  run(["artifacts", "repositories", "create", repository, "--location", region, "--repository-format", "docker", "--description", "InstantML Cloud Run images"]);
}

function ensureServiceAccount() {
  const email = `${serviceAccountName}@${project}.iam.gserviceaccount.com`;
  if (!quiet(["iam", "service-accounts", "describe", email])) {
    run(["iam", "service-accounts", "create", serviceAccountName, "--display-name", "InstantML Rust API"]);
  }
  run(["projects", "add-iam-policy-binding", project, "--member", `serviceAccount:${email}`, "--role", "roles/logging.logWriter"], { quietOutput: true });
  return email;
}

function ensureCloudBuildServiceAccount() {
  const projectNumber = capture(["projects", "describe", project, "--format=value(projectNumber)"]).trim();
  if (!projectNumber) fail("Could not resolve GCP project number for Cloud Build IAM setup.");
  const builderEmail = `${projectNumber}-compute@developer.gserviceaccount.com`;
  for (const role of [
    "roles/cloudbuild.builds.builder",
    "roles/storage.objectViewer",
    "roles/artifactregistry.writer",
    "roles/logging.logWriter",
  ]) {
    run(["projects", "add-iam-policy-binding", project, "--member", `serviceAccount:${builderEmail}`, "--role", role], { quietOutput: true });
  }
}

function ensureStaticEgress() {
  if (!quiet(["compute", "networks", "describe", network])) {
    run(["compute", "networks", "create", network, "--subnet-mode", "custom"]);
  }
  if (!quiet(["compute", "networks", "subnets", "describe", subnet, "--region", region])) {
    run(["compute", "networks", "subnets", "create", subnet, "--network", network, "--region", region, "--range", subnetRange]);
  }
  if (!quiet(["compute", "addresses", "describe", addressName, "--region", region])) {
    run(["compute", "addresses", "create", addressName, "--region", region]);
  }
  const ip = capture(["compute", "addresses", "describe", addressName, "--region", region, "--format=value(address)"]).trim();
  if (!ip) fail("Unable to resolve static egress IP.");
  if (!quiet(["compute", "routers", "describe", routerName, "--region", region])) {
    run(["compute", "routers", "create", routerName, "--network", network, "--region", region]);
  }
  if (!quiet(["compute", "routers", "nats", "describe", natName, "--router", routerName, "--region", region])) {
    run([
      "compute", "routers", "nats", "create", natName,
      "--router", routerName,
      "--region", region,
      "--nat-external-ip-pool", addressName,
      "--nat-custom-subnet-ip-ranges", subnet,
      "--enable-logging",
    ]);
  }
  return ip;
}

function syncSecrets(serviceAccountEmail) {
  const specs = [
    ["CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT", "instantml-clickhouse-user-data-endpoint", true],
    ["CLICKHOUSE_INSTANTML_USER_DATA_USERNAME", "instantml-clickhouse-user-data-username", true],
    ["CLICKHOUSE_INSTANTML_USER_DATA_PASSWORD", "instantml-clickhouse-user-data-password", true],
    ["CLICKHOUSE_INSTANTML_GENERAL_KEY_ID", "instantml-clickhouse-cloud-key-id", true],
    ["CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET", "instantml-clickhouse-cloud-key-secret", true],
    ["CLERK_SECRET_KEY", "instantml-clerk-secret-key", false],
    ["INSTANTML_BOOTSTRAP_TOKEN", "instantml-bootstrap-token", false],
    ["CLOUDFLARE_R2_API_KEY", "instantml-cloudflare-r2-api-key", false],
    ["CLOUDFLARE_API_TOKEN", "instantml-cloudflare-api-token", false],
    ["CLOUDFLARE_R2_ACCESS_KEY_ID", "instantml-cloudflare-r2-access-key-id", false],
    ["CLOUDFLARE_R2_SECRET_ACCESS_KEY", "instantml-cloudflare-r2-secret-access-key", false],
    ["STRIPE_SECRET_KEY", "instantml-stripe-secret-key", false],
    ["STRIPE_WEBHOOK_SECRET", "instantml-stripe-webhook-secret", false],
  ];
  const mappings = [];
  for (const [envName, secretName, required] of specs) {
    const secretValue = value(envName);
    if (!secretValue) {
      if (required) fail(`${envName} is required in .env or process env.`);
      continue;
    }
    if (!quiet(["secrets", "describe", secretName])) {
      run(["secrets", "create", secretName, "--replication-policy", "automatic"]);
    }
    run(["secrets", "versions", "add", secretName, "--data-file", "-"], { input: secretValue });
    run([
      "secrets", "add-iam-policy-binding", secretName,
      "--member", `serviceAccount:${serviceAccountEmail}`,
      "--role", "roles/secretmanager.secretAccessor",
    ], { quietOutput: true });
    mappings.push(`${envName}=${secretName}:latest`);
  }
  return mappings;
}

function buildRuntimeEnv(staticEgressIp, activeAccount) {
  const origins = value("INSTANTML_ALLOWED_FRONTEND_ORIGINS")
    || "http://127.0.0.1:3000,http://localhost:3000,https://instantml.ai";
  const allowedEmails = value("INSTANTML_SIGNUP_ALLOWED_EMAILS") || activeAccount;
  const cloudflareAccountId = cloudflareR2AccountId();
  const r2Configured = Boolean(
    cloudflareAccountId
      && (value("CLOUDFLARE_R2_API_KEY") || value("CLOUDFLARE_API_TOKEN"))
  );
  const output = {
    INSTANTML_BIND_ADDR: "0.0.0.0:8000",
    INSTANTML_AUTH_MODE: "api-key",
    INSTANTML_DEV_AUTH_ENABLED: "false",
    INSTANTML_LOG_FORMAT: "json",
    INSTANTML_HOSTED_CLICKHOUSE_ENABLED: "true",
    INSTANTML_CLICKHOUSE_PROVISIONER: "cloud-service",
    INSTANTML_CLICKHOUSE_CLOUD_PROVIDER: value("INSTANTML_CLICKHOUSE_CLOUD_PROVIDER") || "gcp",
    INSTANTML_CLICKHOUSE_CLOUD_REGION: value("INSTANTML_CLICKHOUSE_CLOUD_REGION") || region,
    INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB: value("INSTANTML_CLICKHOUSE_CLOUD_MIN_REPLICA_MEMORY_GB") || "12",
    INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB: value("INSTANTML_CLICKHOUSE_CLOUD_MAX_REPLICA_MEMORY_GB") || "12",
    INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS: value("INSTANTML_CLICKHOUSE_CLOUD_NUM_REPLICAS") || "1",
    INSTANTML_CLICKHOUSE_CLOUD_WAIT_SECONDS: value("INSTANTML_CLICKHOUSE_CLOUD_WAIT_SECONDS") || "600",
    INSTANTML_ALLOW_USER_DATA_STORED_TENANT_PASSWORDS: "true",
    INSTANTML_MANAGED_CLERK_ENABLED: value("CLERK_SECRET_KEY") ? "true" : "false",
    INSTANTML_ALLOWED_FRONTEND_ORIGINS: origins,
    INSTANTML_FRONTEND_BASE_URL: value("INSTANTML_FRONTEND_BASE_URL"),
    INSTANTML_SIGNUP_ALLOWED_EMAILS: allowedEmails,
    INSTANTML_SIGNUP_ALLOWED_DOMAINS: value("INSTANTML_SIGNUP_ALLOWED_DOMAINS"),
    INSTANTML_ARTIFACT_BACKEND: value("INSTANTML_ARTIFACT_BACKEND") || (r2Configured ? "r2" : "local"),
    INSTANTML_ARTIFACT_UPLOADS_ENABLED: value("INSTANTML_ARTIFACT_UPLOADS_ENABLED") || (r2Configured ? "true" : "false"),
    CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
    CLOUDFLARE_R2_BUCKET_PREFIX: value("CLOUDFLARE_R2_BUCKET_PREFIX") || "instantml-org",
    CLOUDFLARE_R2_ENDPOINT: value("CLOUDFLARE_R2_ENDPOINT"),
    INSTANTML_MAX_UPLOAD_BODY_BYTES: value("INSTANTML_MAX_UPLOAD_BODY_BYTES") || "50000000",
    INSTANTML_REQUEST_TIMEOUT_SECONDS: value("INSTANTML_REQUEST_TIMEOUT_SECONDS") || "900",
    INSTANTML_BILLING_ENABLED: value("INSTANTML_BILLING_ENABLED") || (value("STRIPE_SECRET_KEY") ? "true" : ""),
    STRIPE_API_VERSION: value("STRIPE_API_VERSION") || "2026-04-22.dahlia",
    STRIPE_PRO_PRICE_ID: value("STRIPE_PRO_PRICE_ID"),
    STRIPE_PREMIUM_PRICE_ID: value("STRIPE_PREMIUM_PRICE_ID"),
    STRIPE_EXTRA_SEAT_PRICE_ID: value("STRIPE_EXTRA_SEAT_PRICE_ID"),
    STRIPE_STORAGE_OVERAGE_PRICE_ID: value("STRIPE_STORAGE_OVERAGE_PRICE_ID"),
    STRIPE_STORAGE_METER_ID: value("STRIPE_STORAGE_METER_ID"),
    INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME: value("INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME"),
    INSTANTML_BILLING_SUCCESS_URL: value("INSTANTML_BILLING_SUCCESS_URL"),
    INSTANTML_BILLING_CANCEL_URL: value("INSTANTML_BILLING_CANCEL_URL"),
    INSTANTML_BILLING_PORTAL_RETURN_URL: value("INSTANTML_BILLING_PORTAL_RETURN_URL"),
    INSTANTML_BILLING_GRACE_DAYS: value("INSTANTML_BILLING_GRACE_DAYS"),
    CLERK_API_BASE: value("CLERK_API_BASE") || "https://api.clerk.com",
    CLERK_JWT_ISSUER: value("CLERK_JWT_ISSUER"),
    CLICKHOUSE_CLOUD_ENDPOINT: value("CLICKHOUSE_CLOUD_ENDPOINT") || "https://api.clickhouse.cloud",
  };
  if (staticEgressIp) {
    output.INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST = `${staticEgressIp}/32`;
  } else if (value("INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST")) {
    output.INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST = value("INSTANTML_CLICKHOUSE_CLOUD_IP_ACCESS_LIST");
  }
  return Object.fromEntries(Object.entries(output).filter(([, val]) => val !== ""));
}

function cloudflareR2AccountId() {
  return value("CLOUDFLARE_R2_ACCOUNT_ID") || value("CLOUDFLARE_ACCOUNT_ID");
}

function runtimeEnvForTarget(envVars, target) {
  if (target.servicePlane !== "control") return envVars;
  const output = { ...envVars };
  for (const key of [
    "INSTANTML_ARTIFACT_BACKEND",
    "INSTANTML_ARTIFACT_UPLOADS_ENABLED",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_R2_BUCKET_PREFIX",
    "CLOUDFLARE_R2_ENDPOINT",
  ]) {
    delete output[key];
  }
  return output;
}

function secretEnvForTarget(secretEnv, target) {
  if (target.servicePlane !== "control") return secretEnv;
  return secretEnv.filter((mapping) => !mapping.startsWith("CLOUDFLARE_"));
}

function buildImage() {
  run(["builds", "submit", "--tag", image, "."], { timeout: 30 * 60 * 1000 });
}

function deployService(target, serviceAccountEmail, staticEgressIp, envVars, secretEnv) {
  const envFilePath = writeTempEnvFile(envVars);
  const args = [
    "run", "deploy", target.service,
    "--image", image,
    "--region", region,
    "--platform", "managed",
    "--execution-environment", "gen2",
    "--allow-unauthenticated",
    "--service-account", serviceAccountEmail,
    "--port", "8000",
    "--cpu", value("INSTANTML_CLOUD_RUN_CPU") || "1",
    "--memory", value("INSTANTML_CLOUD_RUN_MEMORY") || "1Gi",
    "--concurrency", value("INSTANTML_CLOUD_RUN_CONCURRENCY") || "20",
    "--timeout", value("INSTANTML_CLOUD_RUN_TIMEOUT") || "900",
    "--env-vars-file", envFilePath,
  ];
  appendScalingArgs(args, target.scaling);
  args.push(target.sessionAffinity ? "--session-affinity" : "--no-session-affinity");
  if (secretEnv.length) {
    args.push("--set-secrets", secretEnv.join(","));
  }
  if (staticEgressIp) {
    args.push("--network", network, "--subnet", subnet, "--vpc-egress", "all-traffic");
  }
  try {
    run(args, { timeout: 20 * 60 * 1000 });
  } finally {
    fs.rmSync(envFilePath, { force: true });
  }
  const url = capture(["run", "services", "describe", target.service, "--region", region, "--format=value(status.url)"]).trim();
  if (!url) fail("Cloud Run deploy succeeded but service URL was not returned.");
  const description = JSON.parse(capture(["run", "services", "describe", target.service, "--region", region, "--format=json"]));
  verifyCloudRunScaling(target, description);
  verifyCloudRunSessionAffinity(target, description);
  return url;
}

function appendScalingArgs(args, scaling) {
  if (scaling.mode === "manual") {
    args.push("--scaling", scaling.instances);
    return;
  }
  args.push("--max-instances", scaling.max, "--min-instances", scaling.min);
}

function verifyCloudRunScaling(target, description) {
  const scaling = serviceScaling(description);
  if (target.scaling.mode === "manual") {
    if (scaling.mode !== "manual" || String(scaling.manualInstances) !== String(target.scaling.instances)) {
      fail(`${target.service} scaling verification failed; expected manual ${target.scaling.instances}, got ${JSON.stringify(scaling)}.`);
    }
    return;
  }
  if (String(scaling.maxInstances) !== String(target.scaling.max)) {
    fail(`${target.service} max instances verification failed; expected ${target.scaling.max}, got ${scaling.maxInstances ?? "unknown"}.`);
  }
}

function verifyCloudRunSessionAffinity(target, description) {
  const annotations = {
    ...(description?.metadata?.annotations || {}),
    ...(description?.spec?.template?.metadata?.annotations || {}),
    ...(description?.template?.metadata?.annotations || {}),
  };
  const raw = annotations["run.googleapis.com/sessionAffinity"];
  const enabled = String(raw).toLowerCase() === "true";
  if (enabled !== Boolean(target.sessionAffinity)) {
    fail(`${target.service} session-affinity verification failed; expected ${Boolean(target.sessionAffinity)}, got ${raw ?? "unset"}.`);
  }
}

function serviceScaling(description) {
  const annotations = {
    ...(description?.metadata?.annotations || {}),
    ...(description?.spec?.template?.metadata?.annotations || {}),
    ...(description?.template?.metadata?.annotations || {}),
  };
  const mode = annotations["run.googleapis.com/scalingMode"]
    || description?.scaling?.scalingMode
    || (annotations["run.googleapis.com/manualInstanceCount"] ? "manual" : "auto");
  return {
    mode: String(mode).toLowerCase(),
    manualInstances: annotations["run.googleapis.com/manualInstanceCount"]
      || description?.scaling?.manualInstanceCount,
    maxInstances: annotations["autoscaling.knative.dev/maxScale"]
      ?? description?.template?.scaling?.maxInstanceCount
      ?? description?.scaling?.maxInstanceCount,
  };
}

function writeTempEnvFile(envVars) {
  const file = path.join(os.tmpdir(), `instantml-cloud-run-env-${process.pid}-${Date.now()}.yaml`);
  const body = Object.entries(envVars)
    .map(([key, val]) => `${key}: ${JSON.stringify(String(val))}`)
    .join("\n") + "\n";
  fs.writeFileSync(file, body);
  return file;
}

async function verifyService(url, target) {
  for (const pathname of ["/health", "/readyz", "/api/auth/config", "/openapi.json"]) {
    const response = await fetch(`${url}${pathname}`);
    const text = await response.text();
    if (!response.ok) {
      fail(`${pathname} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    if (pathname === "/api/auth/config") {
      const config = JSON.parse(text);
      if (config.dev_auth_enabled !== false) {
        fail("/api/auth/config verification failed; dev auth must be disabled in Cloud Run.");
      }
      if (config.service_plane !== target.servicePlane) {
        fail(`${target.service} /api/auth/config verification failed; expected ${target.servicePlane}, got ${config.service_plane}.`);
      }
    }
    if (pathname === "/openapi.json") {
      const spec = JSON.parse(text);
      if (spec["x-instantml-service-plane"] !== target.servicePlane) {
        fail(`${target.service} /openapi.json verification failed; expected ${target.servicePlane}, got ${spec["x-instantml-service-plane"]}.`);
      }
    }
    console.log(`${target.service} ${pathname} ok`);
  }
}

async function ensurePublicRouter(deployments) {
  const control = deployments.find((target) => target.servicePlane === "control");
  const data = deployments.find((target) => target.servicePlane === "data");
  if (!control || !data) fail("Public router requires split control and data deployments.");
  const domain = publicRouterDomain();

  const names = publicRouterResourceNames();
  ensureGlobalAddress(names.address);
  const ip = capture(["compute", "addresses", "describe", names.address, "--global", "--format=value(address)"]).trim();
  if (!ip) fail("Public router address exists but has no IP.");
  rejectCleartextRouterResources(ip);
  ensureServerlessNeg(names.controlNeg, control.service);
  ensureServerlessNeg(names.dataNeg, data.service);
  ensureBackendService(names.controlBackend, names.controlNeg);
  ensureBackendService(names.dataBackend, names.dataNeg);
  ensureUrlMap(names);
  ensureManagedSslCertificate(names.certificate, domain);
  ensureTargetHttpsProxy(names.proxy, names.urlMap, names.certificate);
  ensureForwardingRule(names.forwardingRule, names.proxy, names.address);

  const url = `https://${domain}`;
  const dnsStatus = await publicRouterDnsStatus(domain, ip);
  if (!dnsStatus.ok) {
    return pendingPublicRouter(names, domain, ip, "pending-dns", dnsStatus.message);
  }
  const certificateStatus = managedSslCertificateStatus(names.certificate, domain);
  if (!certificateStatus.active) {
    return pendingPublicRouter(names, domain, ip, "pending-certificate", certificateStatus.message);
  }
  await verifyPublicRouter(url);
  return {
    type: "global-external-application-load-balancer",
    status: "active",
    name: publicRouterName,
    domain,
    address: names.address,
    forwarding_rule: names.forwardingRule,
    url_map: names.urlMap,
    certificate: names.certificate,
    control_backend: names.controlBackend,
    data_backend: names.dataBackend,
    ip,
    url,
  };
}

function pendingPublicRouter(names, domain, ip, status, message) {
  console.warn(`Public router ${publicRouterName} is ${status}: ${message}`);
  console.warn(`Point ${domain} at ${ip}, wait for the managed certificate to become ACTIVE, then rerun deploy to verify and write the public API base.`);
  return {
    type: "global-external-application-load-balancer",
    status,
    name: publicRouterName,
    domain,
    address: names.address,
    forwarding_rule: names.forwardingRule,
    url_map: names.urlMap,
    certificate: names.certificate,
    control_backend: names.controlBackend,
    data_backend: names.dataBackend,
    ip,
    url: null,
    message,
  };
}

function publicRouterResourceNames() {
  return {
    address: `${publicRouterName}-ip`,
    controlNeg: `${publicRouterName}-control-${slug(region)}`,
    dataNeg: `${publicRouterName}-data-${slug(region)}`,
    controlBackend: `${publicRouterName}-control`,
    dataBackend: `${publicRouterName}-data`,
    urlMap: publicRouterName,
    certificate: value("INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_CERTIFICATE") || `${publicRouterName}-cert`,
    proxy: `${publicRouterName}-https`,
    forwardingRule: `${publicRouterName}-https`,
  };
}

function publicRouterDomain() {
  const raw = value("INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN") || value("INSTANTML_PUBLIC_API_DOMAIN");
  if (!raw) {
    fail("Public router deployment requires INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN so the API uses HTTPS with a managed certificate. Do not expose auth/API-key traffic over http://<ip>.");
  }
  if (raw.includes("://") || raw.includes("/") || raw.includes(":")) {
    fail("INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN must be a DNS host only, for example api.instantml.ai.");
  }
  const parsed = new URL(`https://${raw}`);
  if (parsed.hostname !== raw.toLowerCase()) {
    fail("INSTANTML_CLOUD_RUN_PUBLIC_ROUTER_DOMAIN must be a lowercase DNS host without path or port.");
  }
  return parsed.hostname;
}

function ensureGlobalAddress(name) {
  if (!quiet(["compute", "addresses", "describe", name, "--global"])) {
    run(["compute", "addresses", "create", name, "--global", "--ip-version", "IPV4"]);
  }
}

function rejectCleartextRouterResources(ip) {
  const rules = JSON.parse(capture(["compute", "forwarding-rules", "list", "--global", "--format=json"]) || "[]");
  const cleartextRules = rules.filter((rule) => {
    if (rule.IPAddress !== ip) return false;
    return forwardingRuleAllowsPort(rule, 80) || rule.target?.includes("/targetHttpProxies/");
  });
  if (cleartextRules.length) {
    const ruleNames = cleartextRules.map((rule) => rule.name).join(", ");
    fail(`Public router IP ${ip} has cleartext forwarding rule(s): ${ruleNames}. Delete the port-80 rule(s) before deploying the HTTPS router.`);
  }
  const legacyProxy = `${publicRouterName}-http`;
  if (quiet(["compute", "target-http-proxies", "describe", legacyProxy])) {
    fail(`Legacy HTTP target proxy ${legacyProxy} still exists. Delete it before deploying the HTTPS router.`);
  }
  if (quiet(["compute", "forwarding-rules", "describe", `${publicRouterName}-http`, "--global"])) {
    fail(`Legacy HTTP forwarding rule ${publicRouterName}-http still exists. Delete it before deploying the HTTPS router.`);
  }
}

function ensureServerlessNeg(name, serviceName) {
  const existing = capture(["compute", "network-endpoint-groups", "describe", name, "--region", region, "--format=json"]);
  if (existing) {
    const parsed = JSON.parse(existing);
    const configuredService = parsed?.cloudRun?.service;
    if (configuredService === serviceName) return;
    fail(`Serverless NEG ${name} already targets ${configuredService || "unknown"}; expected ${serviceName}.`);
  }
  run([
    "compute", "network-endpoint-groups", "create", name,
    "--region", region,
    "--network-endpoint-type", "serverless",
    "--cloud-run-service", serviceName,
  ]);
}

function ensureBackendService(name, negName) {
  if (!quiet(["compute", "backend-services", "describe", name, "--global"])) {
    run([
      "compute", "backend-services", "create", name,
      "--load-balancing-scheme", "EXTERNAL_MANAGED",
      "--protocol", "HTTP",
      "--global",
    ]);
  }
  const service = JSON.parse(capture(["compute", "backend-services", "describe", name, "--global", "--format=json"]));
  if (service.loadBalancingScheme !== "EXTERNAL_MANAGED" || service.protocol !== "HTTP") {
    fail(`Backend service ${name} exists with scheme/protocol ${service.loadBalancingScheme}/${service.protocol}; expected EXTERNAL_MANAGED/HTTP.`);
  }
  run([
    "compute", "backend-services", "update", name,
    "--global",
    "--enable-logging",
  ]);
  const negLink = regionalNegSelfLink(negName);
  for (const backend of service.backends || []) {
    if (backend.group === negLink || backend.group?.endsWith(`/networkEndpointGroups/${negName}`)) continue;
    removeBackendServiceGroup(name, backend.group);
  }
  const refreshed = JSON.parse(capture(["compute", "backend-services", "describe", name, "--global", "--format=json"]));
  const hasBackend = (refreshed.backends || []).some((backend) => backend.group === negLink || backend.group?.endsWith(`/networkEndpointGroups/${negName}`));
  if (!hasBackend) {
    run([
      "compute", "backend-services", "add-backend", name,
      "--global",
      "--network-endpoint-group", negName,
      "--network-endpoint-group-region", region,
    ]);
  }
}

function backendServiceTimeout() {
  const seconds = value("INSTANTML_CLOUD_RUN_BACKEND_TIMEOUT_SECONDS")
    || value("INSTANTML_CLOUD_RUN_TIMEOUT")
    || value("INSTANTML_REQUEST_TIMEOUT_SECONDS")
    || "900";
  if (!/^[1-9][0-9]*$/.test(seconds)) {
    fail("INSTANTML_CLOUD_RUN_BACKEND_TIMEOUT_SECONDS must be a positive integer number of seconds.");
  }
  return `${seconds}s`;
}

function removeBackendServiceGroup(backendService, groupLink) {
  const ref = regionalNegFromSelfLink(groupLink);
  if (!ref) {
    fail(`Backend service ${backendService} has unexpected backend group ${groupLink}; remove it manually before rerunning deploy.`);
  }
  run([
    "compute", "backend-services", "remove-backend", backendService,
    "--global",
    "--network-endpoint-group", ref.name,
    "--network-endpoint-group-region", ref.region,
  ]);
}

function ensureUrlMap(names) {
  const file = path.join(os.tmpdir(), `instantml-url-map-${process.pid}-${Date.now()}.yaml`);
  try {
    fs.writeFileSync(file, publicRouterUrlMapYaml(names));
    if (!quiet(["compute", "url-maps", "describe", names.urlMap, "--global"])) {
      run(["compute", "url-maps", "create", names.urlMap, "--default-service", names.dataBackend, "--global"]);
    }
    run(["compute", "url-maps", "import", names.urlMap, "--source", file, "--global"]);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function publicRouterUrlMapYaml(names) {
  const controlBackend = globalBackendSelfLink(names.controlBackend);
  const dataBackend = globalBackendSelfLink(names.dataBackend);
  return `name: ${names.urlMap}
defaultService: ${dataBackend}
hostRules:
- hosts:
  - '*'
  pathMatcher: instantml-api
pathMatchers:
- name: instantml-api
  defaultService: ${dataBackend}
  pathRules:
  - paths:
    - /api/auth
    - /api/auth/*
    - /api/users
    - /api/users/*
    - /api/orgs
    - /api/orgs/*
    service: ${controlBackend}
tests:
- description: Auth routes use control plane
  host: instantml.local
  path: /api/auth/config
  service: ${controlBackend}
- description: Data routes use data plane
  host: instantml.local
  path: /runs
  service: ${dataBackend}
`;
}

function ensureManagedSslCertificate(certificateName, domain) {
  const existing = capture(["compute", "ssl-certificates", "describe", certificateName, "--global", "--format=json"]);
  if (existing) {
    const cert = JSON.parse(existing);
    const domains = cert?.managed?.domains || [];
    if (!domains.includes(domain)) {
      fail(`SSL certificate ${certificateName} exists for ${domains.join(",") || "no domains"}; expected ${domain}.`);
    }
    return;
  }
  run([
    "compute", "ssl-certificates", "create", certificateName,
    "--domains", domain,
    "--global",
  ]);
}

function managedSslCertificateStatus(certificateName, domain) {
  const existing = capture(["compute", "ssl-certificates", "describe", certificateName, "--global", "--format=json"]);
  if (!existing) return { active: false, message: `managed SSL certificate ${certificateName} does not exist` };
  const cert = JSON.parse(existing);
  const status = cert?.managed?.status || "UNKNOWN";
  const domainStatus = cert?.managed?.domainStatus?.[domain] || "UNKNOWN";
  return {
    active: status === "ACTIVE" && domainStatus === "ACTIVE",
    message: `managed SSL certificate ${certificateName} status=${status}, ${domain}=${domainStatus}`,
  };
}

function ensureTargetHttpsProxy(proxyName, urlMapName, certificateName) {
  if (quiet(["compute", "target-https-proxies", "describe", proxyName, "--global"])) {
    run([
      "compute", "target-https-proxies", "update", proxyName,
      "--global",
      "--url-map", urlMapName,
      "--global-url-map",
      "--ssl-certificates", certificateName,
      "--global-ssl-certificates",
    ]);
    return;
  }
  run([
    "compute", "target-https-proxies", "create", proxyName,
    "--global",
    "--url-map", urlMapName,
    "--global-url-map",
    "--ssl-certificates", certificateName,
    "--global-ssl-certificates",
  ]);
}

function ensureForwardingRule(ruleName, proxyName, addressName) {
  if (quiet(["compute", "forwarding-rules", "describe", ruleName, "--global"])) {
    verifyForwardingRule(ruleName, proxyName, addressName);
    return;
  }
  run([
    "compute", "forwarding-rules", "create", ruleName,
    "--global",
    "--load-balancing-scheme", "EXTERNAL_MANAGED",
    "--address", addressName,
    "--global-address",
    "--ports", "443",
    "--target-https-proxy", proxyName,
    "--global-target-https-proxy",
  ]);
}

function verifyForwardingRule(ruleName, proxyName, addressName) {
  const rule = JSON.parse(capture(["compute", "forwarding-rules", "describe", ruleName, "--global", "--format=json"]));
  const ip = capture(["compute", "addresses", "describe", addressName, "--global", "--format=value(address)"]).trim();
  const expectedTarget = globalHttpsProxySelfLink(proxyName);
  const ports = forwardingRulePorts(rule);
  const failures = [];
  if (rule.loadBalancingScheme !== "EXTERNAL_MANAGED") failures.push(`scheme=${rule.loadBalancingScheme}`);
  if (rule.IPProtocol && rule.IPProtocol !== "TCP") failures.push(`protocol=${rule.IPProtocol}`);
  if (rule.IPAddress !== ip) failures.push(`ip=${rule.IPAddress || "unset"}`);
  if (!forwardingRuleAllowsPort(rule, 443)) failures.push(`ports=${ports.join(",") || "unset"}`);
  if (rule.target !== expectedTarget && !rule.target?.endsWith(`/targetHttpsProxies/${proxyName}`)) {
    failures.push(`target=${rule.target || "unset"}`);
  }
  if (failures.length) {
    fail(`Forwarding rule ${ruleName} is not the expected HTTPS public router (${failures.join("; ")}). Delete or rename it before rerunning deploy.`);
  }
}

function forwardingRulePorts(rule) {
  if (Array.isArray(rule.ports)) return rule.ports;
  if (rule.portRange) return [rule.portRange];
  return [];
}

function forwardingRuleAllowsPort(rule, port) {
  return forwardingRulePorts(rule).some((spec) => {
    if (spec === String(port)) return true;
    const match = String(spec).match(/^([0-9]+)-([0-9]+)$/);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start <= port && port <= end;
  });
}

async function publicRouterDnsStatus(domain, ip) {
  let records;
  try {
    records = await dns.lookup(domain, { all: true });
  } catch (error) {
    return {
      ok: false,
      message: `DNS lookup for ${domain} failed: ${error.message}. Point the DNS A record at ${ip}.`,
    };
  }
  const addresses = records.map((record) => record.address);
  if (!addresses.includes(ip)) {
    return {
      ok: false,
      message: `DNS for ${domain} resolves to ${addresses.join(", ") || "no addresses"}, not reserved IP ${ip}.`,
    };
  }
  return { ok: true, message: `${domain} resolves to ${ip}` };
}

async function verifyPublicRouter(url) {
  const checks = [
    {
      path: "/api/auth/config",
      expect: (text) => JSON.parse(text).service_plane === "control",
      label: "control auth config",
    },
    {
      path: "/openapi.json",
      expect: (text) => JSON.parse(text)["x-instantml-service-plane"] === "data",
      label: "data OpenAPI default route",
    },
  ];
  for (const check of checks) {
    let lastError = "";
    for (let attempt = 1; attempt <= 36; attempt += 1) {
      try {
        const response = await fetch(`${url}${check.path}`);
        const text = await response.text();
        if (response.ok && check.expect(text)) {
          console.log(`public router ${check.path} ok`);
          lastError = "";
          break;
        }
        lastError = `${check.path} returned ${response.status}: ${text.slice(0, 300)}`;
      } catch (error) {
        lastError = `${check.path} failed: ${error.message}`;
      }
      await sleep(5000);
    }
    if (lastError) fail(`Public router ${check.label} verification failed: ${lastError}`);
  }
}

function globalBackendSelfLink(name) {
  return `https://www.googleapis.com/compute/v1/projects/${project}/global/backendServices/${name}`;
}

function globalHttpsProxySelfLink(name) {
  return `https://www.googleapis.com/compute/v1/projects/${project}/global/targetHttpsProxies/${name}`;
}

function regionalNegSelfLink(name) {
  return `https://www.googleapis.com/compute/v1/projects/${project}/regions/${region}/networkEndpointGroups/${name}`;
}

function regionalNegFromSelfLink(link) {
  if (!link || !link.includes("/networkEndpointGroups/")) return null;
  const parts = link.split("/");
  const regionIndex = parts.indexOf("regions");
  const groupIndex = parts.indexOf("networkEndpointGroups");
  if (regionIndex < 0 || groupIndex < 0 || !parts[regionIndex + 1] || !parts[groupIndex + 1]) {
    return null;
  }
  return { region: parts[regionIndex + 1], name: parts[groupIndex + 1] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateClickHouseAccessLists(staticIp) {
  const endpoint = value("CLICKHOUSE_INSTANTML_USER_DATA_ENDPOINT");
  const keyId = value("CLICKHOUSE_INSTANTML_GENERAL_KEY_ID");
  const keySecret = value("CLICKHOUSE_INSTANTML_GENERAL_KEY_SECRET");
  if (!endpoint || !keyId || !keySecret) return;
  const apiBase = (value("CLICKHOUSE_CLOUD_ENDPOINT") || "https://api.clickhouse.cloud").replace(/\/$/, "");
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  const orgId = value("INSTANTML_CLICKHOUSE_CLOUD_ORG_ID") || await discoverClickHouseOrg(apiBase, auth);
  if (!orgId) {
    console.warn("ClickHouse Cloud organization could not be discovered; skipped allowlist update.");
    return;
  }
  if (updateClickHouseServiceAllowlist) {
    await updateClickHouseServiceAccessLists(apiBase, auth, orgId, endpoint, staticIp);
  }
  if (updateClickHouseKeyAllowlist) {
    await updateClickHouseApiKeyAccessLists(apiBase, auth, orgId, staticIp);
  }
}

async function updateClickHouseApiKeyAccessLists(apiBase, auth, orgId, staticIp) {
  const keys = await listClickHouseApiKeys(apiBase, auth, orgId);
  for (const key of keys) {
    const next = clickHouseAccessListWithStaticIp(key.ipAccessList || [], staticIp);
    const ok = await patchClickHouseApiKeyAllowlist(apiBase, auth, orgId, key.id, next);
    if (ok) {
      console.log(`Updated ClickHouse API-key IP access list for ${key.name || key.id}.`);
    } else {
      console.warn(`Could not update ClickHouse API-key IP access list for ${key.name || key.id}; update it manually with ${staticIp}/32.`);
    }
  }
}

async function updateClickHouseServiceAccessLists(apiBase, auth, orgId, endpoint, staticIp) {
  const services = await listClickHouseServices(apiBase, auth, orgId);
  const mode = value("INSTANTML_CLICKHOUSE_ALLOWLIST_SERVICES") || "all";
  const userDataHost = new URL(endpoint).hostname;
  const selected = services.filter((serviceRow) => {
    if (mode === "all") return true;
    if (mode === "user-data") return serviceHasHost(serviceRow, userDataHost);
    return serviceHasHost(serviceRow, userDataHost)
      || serviceRow.name?.toLowerCase().includes("instantml")
      || (serviceRow.ipAccessList || []).some((item) => item.source === "0.0.0.0/0");
  });
  for (const serviceRow of selected) {
    const next = clickHouseAccessListWithStaticIp(serviceRow.ipAccessList || [], staticIp);
    const ok = await patchClickHouseServiceAllowlist(apiBase, auth, orgId, serviceRow.id, next, serviceRow.ipAccessList || []);
    if (ok) {
      console.log(`Updated ClickHouse IP access list for ${serviceRow.name || serviceRow.id}.`);
    } else {
      console.warn(`Could not update ClickHouse IP access list for ${serviceRow.name || serviceRow.id}; update it manually with ${staticIp}/32.`);
    }
  }
}

async function discoverClickHouseOrg(apiBase, auth) {
  const payload = await clickhouseApi(`${apiBase}/v1/organizations`, auth);
  const result = payload.result ?? payload;
  if (Array.isArray(result)) return result[0]?.id || "";
  if (result?.id) return result.id;
  for (const key of ["organizations", "data", "items"]) {
    if (Array.isArray(result?.[key])) return result[key][0]?.id || "";
  }
  return "";
}

async function listClickHouseServices(apiBase, auth, orgId) {
  const payload = await clickhouseApi(`${apiBase}/v1/organizations/${orgId}/services`, auth);
  const result = payload.result ?? payload;
  if (Array.isArray(result)) return result;
  for (const key of ["services", "data", "items"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

async function listClickHouseApiKeys(apiBase, auth, orgId) {
  const payload = await clickhouseApi(`${apiBase}/v1/organizations/${orgId}/keys`, auth);
  const result = payload.result ?? payload;
  if (Array.isArray(result)) return result;
  for (const key of ["keys", "data", "items"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

async function patchClickHouseApiKeyAllowlist(apiBase, auth, orgId, keyId, list) {
  const response = await fetch(`${apiBase}/v1/organizations/${orgId}/keys/${keyId}`, {
    method: "PATCH",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ ipAccessList: list }),
  });
  return response.ok;
}

async function patchClickHouseServiceAllowlist(apiBase, auth, orgId, serviceId, list, currentList = []) {
  const currentSources = new Set(list.map((item) => item.source));
  const removeSources = [
    "0.0.0.0/0",
    ...currentList.map((item) => item.source).filter(Boolean),
  ]
    .filter((source) => source === "0.0.0.0/0" || currentSources.has(source))
    .filter((source, index, sources) => sources.indexOf(source) === index)
    .map((source) => ({ source }));
  for (const body of [
    { ipAccessList: { add: list, remove: removeSources } },
    { ipAccessList: { add: list } },
  ]) {
    const response = await fetch(`${apiBase}/v1/organizations/${orgId}/services/${serviceId}`, {
      method: "PATCH",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return true;
  }
  return false;
}

function clickHouseAccessListWithStaticIp(list, staticIp) {
  const existing = (list || [])
    .filter((item) => item.source && item.source !== "0.0.0.0/0")
    .map((item) => ({ source: item.source, description: item.description || "Existing access" }));
  return dedupeBySource([...existing, { source: `${staticIp}/32`, description: "InstantML Cloud Run" }]);
}

async function clickhouseApi(url, auth) {
  const response = await fetch(url, { headers: { authorization: auth } });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse Cloud API ${url} failed with ${response.status}: ${text}`);
  return JSON.parse(text);
}

function serviceHasHost(serviceRow, host) {
  return (serviceRow.endpoints || []).some((endpoint) => endpoint.host === host);
}

function dedupeBySource(items) {
  const map = new Map();
  for (const item of items) map.set(item.source, item);
  return [...map.values()];
}

function gitShortSha() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function timestampTag() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function run(args, options = {}) {
  const result = spawnSync("gcloud", ["--quiet", "--project", project, ...args], {
    cwd: repo,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 10 * 60 * 1000,
  });
  if (!options.quietOutput) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    fail(`gcloud ${args.join(" ")} failed with status ${result.status}`);
  }
  return result.stdout;
}

function capture(args) {
  const result = spawnSync("gcloud", ["--quiet", "--project", project, ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout;
}

function quiet(args) {
  const result = spawnSync("gcloud", ["--quiet", "--project", project, ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
