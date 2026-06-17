import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "..");
const sourcePath = resolve(repoRoot, "apps/rust-server/openapi.generated.json");
const outputPath = resolve(repoRoot, "apps/docs/openapi.json");

export const publicOpenApiPaths = [
  "/health",
  "/readyz",
  "/projects",
  "/runs",
  "/runs/{run_id}",
  "/runs/{run_id}/metrics",
  "/runs/{run_id}/rank-metrics",
  "/api/overview",
  "/api/runs/summary",
  "/api/runs/side-by-side",
  "/api/runs/stop",
  "/api/metrics/series",
  "/api/runs/{run_id}/rank-metrics/summary",
  "/api/runs/{run_id}/lineage",
  "/api/runs/{run_id}/forks",
  "/api/runs/{run_id}/stop",
  "/api/runs/{run_id}/stop-signal",
  "/api/runs/{run_id}/stop-ack",
  "/api/runs/{run_id}/attributes",
  "/api/runs/{run_id}/objects",
  "/api/runs/{run_id}/artifacts",
  "/api/runs/{run_id}/artifacts/upload",
  "/api/runs/{run_id}/logs",
  "/api/objects/{object_id}/rows",
  "/api/artifacts/{artifact_id}/download",
  "/api/export",
  "/api/imports",
  "/api/imports/jobs",
  "/api/imports/jobs/{import_id}",
  "/api/imports/jobs/{import_id}/chunks",
  "/api/imports/jobs/{import_id}/commit",
  "/api/imports/jobs/{import_id}/cancel",
  "/api/imports/wandb",
  "/api/imports/mlflow",
  "/api/imports/neptune",
  "/api/usage",
  "/api/usage/export",
  "/api/reports",
  "/api/reports/{report_id}",
  "/api/reports/{report_id}/share",
  "/api/reports/share/{share_token}",
  "/api/reports/panels",
  "/api/reports/{report_id}/markdown",
  "/api/dashboard/preferences",
  "/api/workspace-view-data",
  "/api/workspace-views",
  "/api/workspace-views/import",
  "/api/workspace-views/{view_id}",
  "/api/workspace-views/{view_id}/export",
];

const defaultServers = [
  {
    url: "https://api.instantml.ai",
    description: "InstantML hosted API",
  },
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function collectComponentRefs(value, refs) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (typeof value.$ref === "string") {
    const match = value.$ref.match(/^#\/components\/([^/]+)\/(.+)$/);
    if (match) {
      refs.add(`${match[1]}/${match[2]}`);
    }
  }
  for (const child of Object.values(value)) {
    collectComponentRefs(child, refs);
  }
}

function collectSecuritySchemes(value, schemes) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value.security)) {
    for (const requirement of value.security) {
      if (requirement && typeof requirement === "object") {
        for (const name of Object.keys(requirement)) {
          schemes.add(name);
        }
      }
    }
  }
  for (const child of Object.values(value)) {
    collectSecuritySchemes(child, schemes);
  }
}

function pruneComponents(source, filteredPaths) {
  const refs = new Set();
  const copied = new Set();
  const components = {};

  collectComponentRefs(filteredPaths, refs);

  while (refs.size > 0) {
    const [ref] = refs;
    refs.delete(ref);
    if (copied.has(ref)) {
      continue;
    }
    const slash = ref.indexOf("/");
    const section = ref.slice(0, slash);
    const name = ref.slice(slash + 1);
    const sourceComponent = source.components?.[section]?.[name];
    if (!sourceComponent) {
      continue;
    }
    copied.add(ref);
    components[section] ??= {};
    components[section][name] = clone(sourceComponent);
    collectComponentRefs(sourceComponent, refs);
  }

  const securitySchemes = new Set();
  collectSecuritySchemes(filteredPaths, securitySchemes);
  for (const name of securitySchemes) {
    const scheme = source.components?.securitySchemes?.[name];
    if (scheme) {
      components.securitySchemes ??= {};
      components.securitySchemes[name] = clone(scheme);
    }
  }

  return components;
}

function collectUsedTags(paths) {
  const tags = new Set();
  for (const pathItem of Object.values(paths)) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (operation && typeof operation === "object" && Array.isArray(operation.tags)) {
        for (const tag of operation.tags) {
          tags.add(tag);
        }
      }
    }
  }
  return tags;
}

export function buildDocsOpenApi(source, options = {}) {
  const publicPaths = options.publicPaths ?? publicOpenApiPaths;
  const missing = publicPaths.filter((path) => !source.paths?.[path]);
  if (missing.length > 0) {
    throw new Error(
      `Rust OpenAPI spec is missing public docs paths: ${missing.join(", ")}. Run npm run codegen:api or update the docs allowlist.`,
    );
  }

  const paths = {};
  for (const path of publicPaths) {
    paths[path] = clone(source.paths[path]);
  }

  const info = clone(source.info ?? {});
  info.description =
    "Public InstantML API reference for hosted SDK, dashboard, import, export, usage, artifact, and metric workflows.";
  if (info.license && !info.license.name) {
    delete info.license;
  }

  const usedTags = collectUsedTags(paths);
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((tag) => tag?.name && usedTags.has(tag.name)).map(clone)
    : undefined;

  const docsSpec = {
    openapi: source.openapi,
    info,
    servers: clone(options.servers ?? defaultServers),
    paths,
  };

  if (tags?.length) {
    docsSpec.tags = tags;
  }

  const components = pruneComponents(source, paths);
  if (Object.keys(components).length > 0) {
    docsSpec.components = components;
  }

  return docsSpec;
}

export function serializeDocsOpenApi(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Unable to read ${path}: ${err.message}`);
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const source = await readJson(sourcePath);
  const output = serializeDocsOpenApi(buildDocsOpenApi(source));

  if (checkOnly) {
    let current = "";
    try {
      current = await readFile(outputPath, "utf8");
    } catch {
      throw new Error(
        `${outputPath} is missing. Run npm run docs:sync-openapi before validating docs.`,
      );
    }
    if (current !== output) {
      throw new Error(
        `${outputPath} is stale. Run npm run docs:sync-openapi and commit the updated file.`,
      );
    }
    process.stderr.write("[docs:openapi] OK: docs OpenAPI copy is in sync.\n");
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  process.stderr.write(`[docs:openapi] wrote ${outputPath}\n`);
}

if (process.argv[1] === thisFile) {
  main().catch((err) => {
    process.stderr.write(`[docs:openapi] ${err.message ?? err}\n`);
    process.exit(1);
  });
}
