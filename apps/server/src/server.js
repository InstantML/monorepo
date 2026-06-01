import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalArtifactStore } from "./artifact-store.js";
import { ConflictError, ForbiddenError, PlanLimitError, SearchValidationError, UnauthorizedError, defaultDbPath, exportPayloadToCsv, NotFoundError, openStore, ValidationError } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(__dirname, "..", "..", "web");
const MAX_BODY_BYTES = 1_000_000;
const MAX_UPLOAD_BODY_BYTES = 50_000_000;

class PayloadTooLargeError extends Error {}

export function createServer({
  dbPath = defaultDbPath(),
  webRoot = DEFAULT_WEB_ROOT,
  storageRoot = null,
  requireApiKey = process.env.INSTANTML_REQUIRE_API_KEY === "true",
  bootstrapToken = process.env.INSTANTML_BOOTSTRAP_TOKEN ?? "",
} = {}) {
  const store = openStore(dbPath);
  const artifactRoot = storageRoot ?? path.join(path.dirname(dbPath), "artifacts");
  const artifactStore = createLocalArtifactStore(artifactRoot);
  const server = http.createServer(async (req, res) => {
    try {
      const response = await route(req, store, webRoot, artifactStore, { requireApiKey, bootstrapToken });
      writeJsonOrStatic(res, response);
    } catch (error) {
      writeError(res, error);
    }
  });
  server.store = store;
  return server;
}

export async function route(req, store, webRoot = DEFAULT_WEB_ROOT, artifactStore = createLocalArtifactStore(path.join(".instantml", "artifacts")), options = {}) {
  const url = new URL(req.url, "http://localhost");
  const pathname = stripTrailingSlash(url.pathname);
  const method = req.method;
  const query = Object.fromEntries(url.searchParams.entries());

  if (method === "GET" && pathname === "/health") return json({ status: "ok" });
  if (method === "POST" && pathname === "/api/users") {
    requireBootstrap(req, options);
    return json({ user: store.createUser(await readJson(req)) });
  }
  if (method === "GET" && pathname === "/api/users") {
    requireBootstrap(req, options);
    return json({ users: store.listUsers() });
  }
  if (method === "POST" && pathname === "/api/orgs") {
    requireBootstrap(req, options);
    return json({ organization: store.createOrganization(await readJson(req)) });
  }
  if (method === "GET" && pathname === "/api/orgs") {
    requireBootstrap(req, options);
    return json({ organizations: store.listOrganizations() });
  }
  const apiKeyMatch = pathname.match(/^\/api\/orgs\/([^/]+)\/api-keys$/);
  if (apiKeyMatch && method === "POST") {
    requireBootstrap(req, options);
    return json(store.createApiKey(apiKeyMatch[1], await readJson(req)), 201);
  }
  if (apiKeyMatch && method === "GET") {
    requireBootstrap(req, options);
    return json({ api_keys: store.listApiKeys(apiKeyMatch[1]) });
  }

  const auth = authenticate(req, store, { requireApiKey: Boolean(options.requireApiKey && requiresTenantAuth(method, pathname)) });

  if (method === "GET" && pathname === "/api/usage") {
    requireScope(auth, "usage:read", options);
    return json(store.usageSummary(withOrg(query, auth)));
  }
  if (method === "GET" && pathname === "/api/usage/export") {
    requireScope(auth, "usage:read", options);
    return json(store.usageExport(withOrg(query, auth)));
  }

  if (method === "POST" && pathname === "/projects") {
    requireScope(auth, "sdk:ingest", options);
    return json({ project: store.createProject(withOrg(await readJson(req), auth)) });
  }
  if (method === "GET" && pathname === "/projects") return json({ projects: store.listProjects(withOrg(query, auth)) });
  if (method === "POST" && pathname === "/runs") {
    requireScope(auth, "sdk:ingest", options);
    return json({ run: store.createRun(withOrg(await readJson(req), auth)) });
  }
  if (method === "GET" && pathname === "/runs") {
    return json({ runs: store.listRuns(withOrg(query, auth)), limit: Number(query.limit ?? 100), offset: Number(query.offset ?? 0) });
  }

  const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    ensureRunAccess(store, runMatch[1], auth);
    return json({ run: store.getRun(runMatch[1]) });
  }
  if (runMatch && method === "PATCH") {
    requireScope(auth, "sdk:ingest", options);
    ensureRunAccess(store, runMatch[1], auth);
    return json({ run: store.updateRun(runMatch[1], await readJson(req)) });
  }

  const metricMatch = pathname.match(/^\/runs\/([^/]+)\/metrics$/);
  if (metricMatch && method === "POST") {
    requireScope(auth, "sdk:ingest", options);
    return json({ inserted: store.logMetrics(metricMatch[1], await readJson(req), { auth, idempotencyKey: req.headers["idempotency-key"] }) });
  }
  if (metricMatch && method === "GET") {
    ensureRunAccess(store, metricMatch[1], auth);
    return json({ metrics: store.getMetrics(metricMatch[1], query), limit: Number(query.limit ?? 1000) });
  }

  const attributeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/attributes$/);
  if (attributeMatch && method === "GET") {
    ensureRunAccess(store, attributeMatch[1], auth);
    return json({ attributes: store.listAttributes(attributeMatch[1], query) });
  }
  if (attributeMatch && method === "POST") {
    requireScope(auth, "sdk:ingest", options);
    ensureRunAccess(store, attributeMatch[1], auth);
    return json({ attributes: store.createAttributes(attributeMatch[1], await readJson(req)) });
  }

  const artifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
  if (artifactMatch && method === "GET") {
    ensureRunAccess(store, artifactMatch[1], auth);
    return json({ artifacts: store.listArtifacts(artifactMatch[1]) });
  }
  if (artifactMatch && method === "POST") {
    requireScope(auth, "artifacts:write", options);
    ensureRunAccess(store, artifactMatch[1], auth);
    const body = await readJson(req);
    return json({ artifact: store.createArtifact(artifactMatch[1], { ...body, storage_path: null }) });
  }

  const artifactUploadMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/upload$/);
  if (artifactUploadMatch && method === "POST") {
    requireScope(auth, "artifacts:write", options);
    ensureRunAccess(store, artifactUploadMatch[1], auth);
    return json({ artifact: createUploadedArtifact(store, artifactStore, artifactUploadMatch[1], await readJson(req, MAX_UPLOAD_BODY_BYTES)) });
  }

  const artifactDownloadMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/download$/);
  if (artifactDownloadMatch && method === "GET") return artifactDownload(store, artifactStore, artifactDownloadMatch[1], auth);

  if (method === "GET" && pathname === "/api/overview") return json({ overview: store.overview(withOrg(query, auth)) });
  if (method === "GET" && pathname === "/api/runs/summary") return json(store.runsSummary(withOrg(query, auth)));
  if (method === "GET" && pathname === "/api/runs/side-by-side") return json(store.sideBySide(withOrg(query, auth)));
  if (method === "GET" && pathname === "/api/export") {
    requireScope(auth, "export:read", options);
    const input = withOrg(query, auth);
    const format = input.format || "json";
    if (format === "csv") {
      const payload = store.exportData(input);
      return csv(exportPayloadToCsv(payload), 200, exportDownloadHeaders("instantml-export.csv", {
        "X-InstantML-Export-Truncated": payload.truncated ? "true" : "false",
      }));
    }
    if (format !== "json") throw new ValidationError("format must be json or csv");
    const payload = store.exportData(input);
    return json(payload, 200, exportDownloadHeaders("instantml-export.json", {
      "X-InstantML-Export-Truncated": payload.truncated ? "true" : "false",
    }));
  }
  if (method === "GET" && pathname === "/api/imports") return json({ imports: store.listImports(withOrg(query, auth)) });
  if (method === "POST" && pathname === "/api/imports/neptune") {
    requireScope(auth, "imports:write", options);
    const body = await readJson(req);
    const input = query.dry_run === undefined ? body : { ...body, dry_run: query.dry_run };
    return json(store.importNeptune(withOrg(input, auth)));
  }
  if (method === "POST" && pathname === "/api/imports/wandb") {
    requireScope(auth, "imports:write", options);
    const body = await readJson(req);
    const input = query.dry_run === undefined ? body : { ...body, dry_run: query.dry_run };
    return json(store.importWandb(withOrg(input, auth)));
  }
  if (method === "POST" && pathname === "/api/imports/mlflow") {
    requireScope(auth, "imports:write", options);
    const body = await readJson(req);
    const input = query.dry_run === undefined ? body : { ...body, dry_run: query.dry_run };
    return json(store.importMlflow(withOrg(input, auth)));
  }
  if (method === "POST" && pathname === "/api/demo/reset") {
    requireScope(auth, "sdk:ingest", options);
    return json(store.resetDemo(auth ? { org_id: auth.org_id } : {}));
  }

  if (method === "GET") return staticFile(webRoot, pathname);
  throw new NotFoundError("route not found");
}

export function listen(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8000;
  const server = createServer(options);
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Training Observability Node server listening on http://${host}:${address.port}`);
  });
  return server;
}

export async function readJson(req, maxBodyBytes = MAX_BODY_BYTES) {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new ValidationError("content-type must be application/json");
  }
  const length = Number(req.headers["content-length"] ?? 0);
  if (!Number.isInteger(length) || length < 0) throw new ValidationError("invalid content-length");
  if (length > maxBodyBytes) {
    req.resume();
    throw new PayloadTooLargeError("request body is too large");
  }
  const raw = await readBody(req, length);
  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("request body must be a JSON object");
    }
    return body;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("request body must be valid JSON");
  }
}

function readBody(req, expectedLength) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      chunks.push(chunk);
      /* node:coverage ignore next 5 */
      if (received > expectedLength) {
        reject(new PayloadTooLargeError("request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(body, status = 200, headers = {}) {
  return { type: "json", status, body, headers };
}

function csv(body, status = 200, headers = {}) {
  return { type: "csv", status, body, headers };
}

function exportDownloadHeaders(filename, headers = {}) {
  return {
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Pragma": "no-cache",
    "Content-Security-Policy": "sandbox",
    ...headers,
  };
}

function staticFile(webRoot, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(webRoot, `.${decodeURIComponent(requested)}`);
  /* node:coverage ignore next 3 */
  if (!resolved.startsWith(path.resolve(webRoot) + path.sep) && resolved !== path.resolve(webRoot)) {
    throw new NotFoundError("route not found");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new NotFoundError("route not found");
  }
  return {
    type: "static",
    status: 200,
    contentType: contentType(resolved),
    body: fs.readFileSync(resolved),
  };
}

function createUploadedArtifact(store, artifactStore, runId, input) {
  store.getRun(runId);
  store.prevalidateArtifact(runId, {
    type: input.type ?? "file",
    name: input.name,
    step: input.step ?? null,
    mime_type: input.mime_type ?? "application/octet-stream",
    metadata: input.metadata ?? {},
    path: input.path,
  });
  const stored = artifactStore.writeBase64(input);
  try {
    return store.createArtifact(runId, {
      type: input.type ?? "file",
      name: input.name,
      uri: stored.uri,
      step: input.step ?? null,
      size_bytes: stored.size_bytes,
      sha256: stored.sha256,
      mime_type: input.mime_type ?? "application/octet-stream",
      storage_path: stored.storage_path,
      metadata: input.metadata ?? {},
      path: input.path,
    });
  /* node:coverage ignore next 4 */
  } catch (error) {
    artifactStore.remove(stored.storage_path);
    throw error;
  }
}

function artifactDownload(store, artifactStore, artifactId, auth) {
  const artifact = store.getArtifact(artifactId);
  if (auth && artifact.org_id !== auth.org_id) throw new ForbiddenError("artifact belongs to a different organization");
  return {
    type: "static",
    status: 200,
    contentType: artifact.mime_type ?? "application/octet-stream",
    body: artifactStore.read(artifact),
  };
}

function authenticate(req, store, options) {
  const header = req.headers.authorization ?? "";
  if (!header) {
    if (options.requireApiKey) throw new UnauthorizedError("missing bearer token");
    return null;
  }
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (!match) throw new UnauthorizedError("authorization must use bearer token");
  try {
    return store.authenticateApiKey(match[1]);
  } catch (err) {
    if (!options.requireApiKey) return null;
    throw err;
  }
}

function requireBootstrap(req, options) {
  if (!options.requireApiKey) return;
  const configured = options.bootstrapToken ?? "";
  if (!configured) throw new UnauthorizedError("bootstrap token is not configured");
  if (req.headers["x-instantml-bootstrap-token"] !== configured) throw new UnauthorizedError("invalid bootstrap token");
}

function withOrg(input, auth) {
  return auth ? { ...input, org_id: auth.org_id } : input;
}

function requireScope(auth, scope, options) {
  if (!options.requireApiKey) return;
  if (!auth) throw new UnauthorizedError("missing bearer token");
  if (!auth.scopes.includes(scope)) throw new ForbiddenError(`api key requires ${scope}`);
}

function ensureRunAccess(store, runId, auth) {
  if (!auth) return;
  if (store.getRun(runId).org_id !== auth.org_id) throw new ForbiddenError("run belongs to a different organization");
}

function requiresTenantAuth(method, pathname) {
  if (pathname === "/api/demo/reset") return true;
  if (method === "GET") {
    return (
      pathname === "/projects" ||
      pathname === "/runs" ||
      /^\/runs\/[^/]+$/.test(pathname) ||
      /^\/runs\/[^/]+\/metrics$/.test(pathname) ||
      /^\/api\/runs\/[^/]+\/attributes$/.test(pathname) ||
      /^\/api\/runs\/[^/]+\/artifacts$/.test(pathname) ||
      /^\/api\/artifacts\/[^/]+\/download$/.test(pathname) ||
      pathname === "/api/overview" ||
      pathname === "/api/runs/summary" ||
      pathname === "/api/runs/side-by-side" ||
      pathname === "/api/usage" ||
      pathname === "/api/usage/export" ||
      pathname === "/api/export" ||
      pathname === "/api/imports"
    );
  }
  return (
    pathname === "/projects" ||
    pathname === "/runs" ||
    /^\/runs\/[^/]+$/.test(pathname) ||
    /^\/runs\/[^/]+\/metrics$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/attributes$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/artifacts$/.test(pathname) ||
    /^\/api\/runs\/[^/]+\/artifacts\/upload$/.test(pathname) ||
    pathname === "/api/imports/neptune" ||
    pathname === "/api/imports/wandb" ||
    pathname === "/api/imports/mlflow"
  );
}

function writeJsonOrStatic(res, response) {
  if (response.type === "csv") {
    const body = Buffer.from(response.body);
    res.writeHead(response.status, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"instantml-export.csv\"",
      "Content-Length": body.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Pragma": "no-cache",
      "Content-Security-Policy": "sandbox",
      ...response.headers,
    });
    res.end(body);
    return;
  }
  if (response.type === "static") {
    res.writeHead(response.status, {
      "Content-Type": response.contentType,
      "Content-Length": response.body.length,
    });
    res.end(response.body);
    return;
  }
  const body = Buffer.from(JSON.stringify(response.body));
  res.writeHead(response.status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    ...response.headers,
  });
  res.end(body);
}

function writeError(res, error) {
  const status =
    error instanceof ValidationError
      ? 400
      : error instanceof PayloadTooLargeError
        ? 413
        : error instanceof UnauthorizedError
          ? 401
          : error instanceof ForbiddenError
            ? 403
            : error instanceof NotFoundError
              ? 404
              : error instanceof ConflictError
                ? 409
                : error instanceof PlanLimitError
                  ? 402
                  : 500;
  const message = status === 500 ? "internal server error" : error.message;
  const payload = { error: message };
  if (error instanceof PlanLimitError) payload.code = "plan_limit_exceeded";
  if (error instanceof SearchValidationError) {
    payload.code = error.code;
    payload.field = error.field;
    if (Number.isInteger(error.position)) payload.position = error.position;
  }
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  res.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  /* node:coverage ignore next */
  return "application/octet-stream";
}

function stripTrailingSlash(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}

/* node:coverage ignore next 9 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  listen({
    dbPath: args.get("--db") ?? defaultDbPath(),
    host: args.get("--host") ?? "127.0.0.1",
    port: Number(args.get("--port") ?? 8000),
  });
}
