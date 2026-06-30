#!/usr/bin/env node
/**
 * Build and deploy the hosted InstantML MCP server (tools/mcp-server.mjs) to
 * Cloud Run. This is the reproducible replacement for the out-of-band image
 * build that originally shipped `instantml-mcp`.
 *
 * It builds tools/mcp.Dockerfile via Cloud Build (no local Docker needed) and
 * deploys it to the `instantml-mcp` Cloud Run service with the env the server
 * needs, including the OAuth authorization-server discovery setting.
 *
 * Usage:
 *   node tools/deploy-mcp.mjs [--environment=prod|staging]
 *                             [--oauth-auth-server=https://clerk.instantml.ai | --no-oauth]
 *                             [--image-tag=<tag>] [--dry-run]
 *
 * Config (env or repo defaults):
 *   GCP_PROJECT                 GCP project id. Default: gcloud config project.
 *   GCP_REGION                  Region. Default: us-central1.
 *   INSTANTML_ARTIFACT_REPOSITORY  Artifact Registry repo. Default: instantml.
 *   INSTANTML_MCP_SERVICE       Cloud Run service. Default: instantml-mcp
 *                               (staging: instantml-staging-mcp).
 *   INSTANTML_API_URL           Consumer API base the MCP forwards to.
 *                               Default: https://api.instantml.ai.
 *   INSTANTML_MCP_OAUTH_AUTH_SERVER  OAuth issuer to advertise. Defaults per env.
 *
 * The GitHub Action .github/workflows/deploy-mcp.yml runs the same build/deploy
 * steps with Workload Identity Federation.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "Usage: node tools/deploy-mcp.mjs [--environment=prod|staging] " +
      "[--oauth-auth-server=<url> | --no-oauth] [--image-tag=<tag>] [--dry-run]",
  );
  process.exit(0);
}

function flag(name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function has(name) {
  return argv.includes(`--${name}`);
}
function value(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}
function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
function capture(args) {
  const result = spawnSync("gcloud", args, { cwd: repo, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}
const dryRun = has("dry-run");
function run(args) {
  console.log(`+ gcloud ${args.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync("gcloud", args, { cwd: repo, stdio: "inherit" });
  if (result.status !== 0) fail(`gcloud ${args[0]} failed (exit ${result.status}).`);
}

const environment = (flag("environment") || value("INSTANTML_DEPLOY_ENV") || "prod").toLowerCase();
if (environment !== "prod" && environment !== "staging") {
  fail(`--environment must be prod or staging (got ${environment}).`);
}

const project = value("GCP_PROJECT") || capture(["config", "get-value", "project"]);
if (!project || project === "(unset)") {
  fail("Set GCP_PROJECT or run `gcloud config set project <project-id>`.");
}
const region = value("GCP_REGION") || value("CLOUDSDK_RUN_REGION") || "us-central1";
const repository = value("INSTANTML_ARTIFACT_REPOSITORY") || "instantml";
const service =
  value("INSTANTML_MCP_SERVICE") ||
  (environment === "staging" ? "instantml-staging-mcp" : "instantml-mcp");

const gitSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" });
const imageTag =
  flag("image-tag") ||
  value("INSTANTML_IMAGE_TAG") ||
  (gitSha.status === 0 ? gitSha.stdout.trim() : "") ||
  `mcp-${Date.now()}`;
const image = `${region}-docker.pkg.dev/${project}/${repository}/instantml-mcp:${imageTag}`;

const defaultIssuer =
  environment === "staging"
    ? "https://modern-mustang-72.clerk.accounts.dev"
    : "https://clerk.instantml.ai";
const oauthAuthServer = has("no-oauth")
  ? ""
  : flag("oauth-auth-server") || value("INSTANTML_MCP_OAUTH_AUTH_SERVER") || defaultIssuer;
const apiUrl = value("INSTANTML_API_URL") || "https://api.instantml.ai";

const envPairs = [
  `INSTANTML_API_URL=${apiUrl}`,
  "INSTANTML_MCP_TRANSPORT=http",
  "NODE_ENV=production",
];
if (oauthAuthServer) envPairs.push(`INSTANTML_MCP_OAUTH_AUTH_SERVER=${oauthAuthServer}`);

console.log(
  `Deploying MCP server:\n` +
    `  project   ${project}\n` +
    `  region    ${region}\n` +
    `  service   ${service}\n` +
    `  image     ${image}\n` +
    `  oauth     ${oauthAuthServer || "(disabled)"}\n`,
);

run([
  "--quiet",
  "--project",
  project,
  "builds",
  "submit",
  "--config",
  "tools/cloudbuild.mcp.yaml",
  `--substitutions=_IMAGE=${image}`,
  ".",
]);

run([
  "--quiet",
  "--project",
  project,
  "run",
  "deploy",
  service,
  "--region",
  region,
  "--platform",
  "managed",
  "--image",
  image,
  "--allow-unauthenticated",
  "--max-instances",
  "3",
  "--cpu-boost",
  `--set-env-vars=${envPairs.join(",")}`,
]);

console.log(
  `\nDone. Verify:\n` +
    `  curl https://mcp.instantml.ai/.well-known/oauth-protected-resource\n` +
    `  (expect JSON with "authorization_servers": ["${oauthAuthServer || "<disabled>"}"])`,
);
