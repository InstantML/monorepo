import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("MCP Dockerfile runs the http MCP server with only the SDK dependency", () => {
  const dockerfile = read("tools/mcp.Dockerfile");
  assert.match(dockerfile, /FROM node:22-bookworm-slim/);
  assert.match(dockerfile, /@modelcontextprotocol\/sdk/);
  // Must not pull the web dependency tree (next/react/clerk) into the image.
  assert.doesNotMatch(dockerfile, /npm ci\b/);
  assert.match(dockerfile, /CMD \["node", "tools\/mcp-server\.mjs", "--transport", "http"\]/);
});

test("Cloud Build config builds the MCP Dockerfile, not the root Rust Dockerfile", () => {
  const cloudbuild = read("tools/cloudbuild.mcp.yaml");
  assert.match(cloudbuild, /-f", "tools\/mcp\.Dockerfile/);
  assert.match(cloudbuild, /\$\{_IMAGE\}/);
  assert.match(cloudbuild, /logging: CLOUD_LOGGING_ONLY/);
});

test("deploy:mcp script is wired into package.json", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["deploy:mcp"], "node tools/deploy-mcp.mjs");
  assert.match(pkg.scripts["deploy:mcp:staging"], /--environment=staging/);
});

test("deploy-mcp workflow targets instantml-mcp via Workload Identity Federation", () => {
  const workflow = read(".github/workflows/deploy-mcp.yml");
  assert.match(workflow, /name: Deploy MCP Server/);
  assert.match(workflow, /google-github-actions\/auth@v2/);
  assert.match(workflow, /workload_identity_provider: \$\{\{ vars\.GCP_WIF_PROVIDER \}\}/);
  assert.match(workflow, /instantml-mcp/);
  assert.match(workflow, /run deploy/);
  assert.match(workflow, /INSTANTML_MCP_OAUTH_AUTH_SERVER=/);
  // Reuses the CI-green gate before any deploy mutation.
  assert.match(workflow, /workflows\/ci\.yml\/runs/);
});
