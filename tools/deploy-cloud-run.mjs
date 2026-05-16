#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = process.cwd();
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: npm run deploy:cloud-run

Environment:
  GCP_PROJECT                         Google Cloud project id.
  GCP_REGION                          Deployment region. Default: us-central1.
  INSTANTML_CLOUD_RUN_SERVICE          Cloud Run service name. Default: instantml-rust-api.
  INSTANTML_SIGNUP_ALLOWED_EMAILS      Comma-separated hosted signup allowlist.
  INSTANTML_ALLOWED_FRONTEND_ORIGINS   Comma-separated browser origins allowed for session mutations.
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
const service = value("INSTANTML_CLOUD_RUN_SERVICE") || "instantml-rust-api";
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
const image = `${region}-docker.pkg.dev/${project}/${repository}/${service}:${imageTag}`;
const useStaticEgress = boolValue("INSTANTML_CLOUD_RUN_STATIC_EGRESS", true);
const updateClickHouseServiceAllowlist = value("INSTANTML_CLICKHOUSE_ALLOWLIST_SERVICES") !== "none";
const updateClickHouseKeyAllowlist = value("INSTANTML_CLICKHOUSE_ALLOWLIST_KEYS") !== "none";
const writeLocalEnv = boolValue("INSTANTML_WRITE_LOCAL_FRONTEND_ENV", true);

preflightBuildContext();
ensureGcloudAuth();
enableServices();
ensureArtifactRepository();
const serviceAccountEmail = ensureServiceAccount();
ensureCloudBuildServiceAccount();
const staticEgressIp = useStaticEgress ? ensureStaticEgress() : "";
const secretEnv = syncSecrets(serviceAccountEmail);
const envVars = buildRuntimeEnv(staticEgressIp, activeAccount);
if (staticEgressIp && (updateClickHouseServiceAllowlist || updateClickHouseKeyAllowlist)) {
  await updateClickHouseAccessLists(staticEgressIp);
}
buildImage();
const url = deployService(serviceAccountEmail, staticEgressIp, envVars, secretEnv);
await verifyService(url);
if (writeLocalEnv) {
  const localFrontendEnv = {
    INSTANTML_API_BASE: url,
    INSTANTML_API_ALLOWED_ORIGINS: url,
  };
  updateDotenv(envFile, localFrontendEnv);
  updateDotenv(webEnvFile, localFrontendEnv);
}

console.log(JSON.stringify({
  status: "ok",
  project,
  region,
  service,
  url,
  image,
  service_account: serviceAccountEmail,
  static_egress_ip: staticEgressIp || null,
  local_frontend: "npm run web:dev",
}, null, 2));

function value(key) {
  const raw = env[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
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
    INSTANTML_SIGNUP_ALLOWED_EMAILS: allowedEmails,
    INSTANTML_SIGNUP_ALLOWED_DOMAINS: value("INSTANTML_SIGNUP_ALLOWED_DOMAINS"),
    INSTANTML_ARTIFACT_UPLOADS_ENABLED: "false",
    INSTANTML_MAX_UPLOAD_BODY_BYTES: value("INSTANTML_MAX_UPLOAD_BODY_BYTES") || "50000000",
    INSTANTML_REQUEST_TIMEOUT_SECONDS: value("INSTANTML_REQUEST_TIMEOUT_SECONDS") || "30",
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

function buildImage() {
  run(["builds", "submit", "--tag", image, "."], { timeout: 30 * 60 * 1000 });
}

function deployService(serviceAccountEmail, staticEgressIp, envVars, secretEnv) {
  const envFilePath = writeTempEnvFile(envVars);
  const args = [
    "run", "deploy", service,
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
    "--max-instances", "1",
    "--min-instances", value("INSTANTML_CLOUD_RUN_MIN_INSTANCES") || "0",
    "--env-vars-file", envFilePath,
  ];
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
  const url = capture(["run", "services", "describe", service, "--region", region, "--format=value(status.url)"]).trim();
  if (!url) fail("Cloud Run deploy succeeded but service URL was not returned.");
  const description = JSON.parse(capture(["run", "services", "describe", service, "--region", region, "--format=json"]));
  const maxScale = description?.spec?.template?.metadata?.annotations?.["autoscaling.knative.dev/maxScale"]
    ?? description?.template?.metadata?.annotations?.["autoscaling.knative.dev/maxScale"]
    ?? description?.template?.scaling?.maxInstanceCount;
  if (String(maxScale) !== "1") {
    fail(`Cloud Run max instances verification failed; expected 1, got ${maxScale ?? "unknown"}.`);
  }
  return url;
}

function writeTempEnvFile(envVars) {
  const file = path.join(os.tmpdir(), `instantml-cloud-run-env-${process.pid}-${Date.now()}.yaml`);
  const body = Object.entries(envVars)
    .map(([key, val]) => `${key}: ${JSON.stringify(String(val))}`)
    .join("\n") + "\n";
  fs.writeFileSync(file, body);
  return file;
}

async function verifyService(url) {
  for (const pathname of ["/health", "/readyz", "/api/auth/config"]) {
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
    }
    console.log(`${pathname} ok`);
  }
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
