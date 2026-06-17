export class ApiClient {
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
  }

  async get(path, options = {}) {
    return this.request(path, { ...options, method: "GET" });
  }

  async post(path, body = {}, options = {}) {
    return this.request(path, {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  async patch(path, body = {}, options = {}) {
    return this.request(path, {
      ...options,
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  async put(path, body = {}, options = {}) {
    return this.request(path, {
      ...options,
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  async delete(path, body = {}, options = {}) {
    return this.request(path, {
      ...options,
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  async download(path, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const { headers, requestId } = headersWithRequestId(options.headers);
    const url = this.baseUrl + path;
    const safePath = safeApiPathForLogs(path);
    const startedAt = nowMs();
    let response = null;
    let payload = null;
    let finalRequestId = requestId;
    try {
      response = await fetch(url, { ...options, method, headers });
      finalRequestId = responseRequestId(response, payload, requestId);
      if (!response.ok) {
        payload = await readPayload(response);
        finalRequestId = responseRequestId(response, payload, requestId);
        const error = new ApiError(clientSafeError(response.status, payload), {
          code: typeof payload?.code === "string" ? payload.code : "",
          field: typeof payload?.field === "string" ? payload.field : "",
          position: Number.isInteger(payload?.position) ? payload.position : null,
          requestId: finalRequestId,
          status: response.status,
        });
        logApiRequest("failure", {
          requestId: finalRequestId,
          method,
          path: safePath,
          status: response.status,
          durationMs: elapsedMs(startedAt),
          code: error.code,
          retryable: isTransientApiError(error),
        });
        throw error;
      }
      const blob = await response.blob();
      finalRequestId = responseRequestId(response, payload, requestId);
      logApiRequest("success", {
        requestId: finalRequestId,
        method,
        path: safePath,
        status: response.status,
        durationMs: elapsedMs(startedAt),
        code: "ok",
        retryable: false,
      });
      return { blob, headers: response.headers, requestId: finalRequestId, status: response.status };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError) throw error;
      const networkError = new ApiError("Network request failed. Check your connection and try again.", {
        code: "network_error",
        requestId: finalRequestId,
        status: 0,
      });
      logApiRequest("failure", {
        requestId: finalRequestId,
        method,
        path: safePath,
        status: 0,
        durationMs: elapsedMs(startedAt),
        code: "network_error",
        retryable: true,
      });
      throw networkError;
    }
  }

  async request(path, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const { headers, requestId } = headersWithRequestId(options.headers);
    const url = this.baseUrl + path;
    const safePath = safeApiPathForLogs(path);
    const startedAt = nowMs();
    let response = null;
    let payload = null;
    let finalRequestId = requestId;
    try {
      response = await fetch(url, { ...options, headers });
      finalRequestId = responseRequestId(response, payload, requestId);
      payload = await readPayload(response);
      finalRequestId = responseRequestId(response, payload, requestId);
      if (!response.ok) {
        const error = new ApiError(clientSafeError(response.status, payload), {
          code: typeof payload?.code === "string" ? payload.code : "",
          field: typeof payload?.field === "string" ? payload.field : "",
          position: Number.isInteger(payload?.position) ? payload.position : null,
          requestId: finalRequestId,
          status: response.status,
        });
        logApiRequest("failure", {
          requestId: finalRequestId,
          method,
          path: safePath,
          status: response.status,
          durationMs: elapsedMs(startedAt),
          code: error.code,
          retryable: isTransientApiError(error),
        });
        throw error;
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ApiError("Server returned malformed payload", {
          requestId: finalRequestId,
          status: response.status,
        });
      }
      logApiRequest("success", {
        requestId: finalRequestId,
        method,
        path: safePath,
        status: response.status,
        durationMs: elapsedMs(startedAt),
        code: "ok",
        retryable: false,
      });
      return payload;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError) {
        const traced = error.requestId ? error : new ApiError(error.safeMessage, {
          code: error.code,
          field: error.field,
          position: error.position,
          requestId: finalRequestId,
          status: error.status,
        });
        if (response?.ok) {
          logApiRequest("failure", {
            requestId: traced.requestId,
            method,
            path: safePath,
            status: traced.status || response.status,
            durationMs: elapsedMs(startedAt),
            code: traced.code || "malformed_response",
            retryable: false,
          });
        }
        throw traced;
      }
      const networkError = new ApiError("Network request failed. Check your connection and try again.", {
        code: "network_error",
        requestId: finalRequestId,
        status: 0,
      });
      logApiRequest("failure", {
        requestId: finalRequestId,
        method,
        path: safePath,
        status: 0,
        durationMs: elapsedMs(startedAt),
        code: "network_error",
        retryable: true,
      });
      throw networkError;
    }
  }
}

async function readPayload(response) {
  try {
    if (typeof response.text === "function") {
      const raw = await response.text();
      return raw ? JSON.parse(raw) : null;
    }
    return await response.json();
  } catch {
    if (!response.ok) return null;
    throw new ApiError("Server returned invalid JSON");
  }
}

export class ApiError extends Error {
  constructor(message, { code = "", field = "", position = null, requestId = "", status = 0 } = {}) {
    super(requestId ? `${message} Request ${requestId}.` : message);
    this.name = "ApiError";
    this.code = code;
    this.field = field;
    this.position = position;
    this.requestId = requestId;
    this.status = status;
    this.safeMessage = message;
  }
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export function isTransientApiError(error) {
  if (error instanceof ApiError) return error.code === "network_error" || error.status === 408 || error.status === 429 || error.status >= 500;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /fetch failed|network|timeout|timed out|etimedout|econnreset|server is unavailable/i.test(message);
}

export async function retryTransientRequest(request, options = {}) {
  const delays = Array.isArray(options.delays) ? options.delays : [250, 700, 1500];
  const sleep = typeof options.sleep === "function" ? options.sleep : sleepWithAbort;
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted || !isTransientApiError(error) || attempt === delays.length) {
        throw error;
      }
      lastError = error;
      await sleep(delays[attempt], options.signal);
    }
  }
  throw lastError;
}

export function sleepWithAbort(ms, signal) {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      globalThis.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function clientSafeError(status, payload) {
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (isSafeSearchValidationError(status, payload)) return payload.error;
  if (code === "validation_error" || status === 400) return "Request was invalid. Check the current filters and try again.";
  if (code === "warehouse_unavailable") return "Starting data warehouse. Your runs will load once the warehouse is awake.";
  if (code === "payment_required" || status === 402) return "Payment is required before this workspace can accept new writes.";
  if (code === "clerk_email_unverified") return "Verify your email address in Clerk before continuing.";
  if (code === "invite_already_member") return "That email is already an active workspace member.";
  if (code === "invite_already_pending") return "That email already has a pending invitation.";
  if (code === "invite_email_mismatch") return "This invitation belongs to a different email address.";
  if (code === "invite_expired") return "This invitation has expired.";
  if (code === "invite_revoked") return "This invitation was revoked.";
  if (code === "invite_seat_limit_reached") return "The workspace is already using all included seats.";
  if (code === "service_unavailable" || status === 503) return "InstantML API is starting. Try again shortly.";
  if (status === 401) return "Sign in required.";
  if (status === 403) return "You do not have access to this workspace.";
  if (status === 404) return "Requested data was not found.";
  if (status === 409) return "Request conflicted with current data.";
  if (status === 429) return "Too many requests. Try again shortly.";
  if (status >= 500) return "Server is unavailable. Try again shortly.";
  return "Request failed.";
}

function isSafeSearchValidationError(status, payload) {
  if (status !== 400) return false;
  const code = typeof payload?.code === "string" ? payload.code : "";
  const field = typeof payload?.field === "string" ? payload.field : "";
  if (field !== "q") return false;
  if (code !== "run_search_invalid" && code !== "run_search_regex_unsupported") return false;
  return typeof payload?.error === "string" && payload.error.length > 0 && payload.error.length <= 240;
}

function headersWithRequestId(input) {
  const headers = new Headers(input ?? {});
  const existing = safeRequestId(headers.get("x-request-id"));
  if (existing) {
    if (headers.get("x-request-id") !== existing) headers.set("x-request-id", existing);
    return { headers, requestId: existing };
  }
  const requestId = generateRequestId();
  headers.set("x-request-id", requestId);
  return { headers, requestId };
}

function responseRequestId(response, payload, fallback) {
  const headerValue = typeof response?.headers?.get === "function"
    ? response.headers.get("x-request-id")
    : "";
  return safeRequestId(headerValue)
    || safeRequestId(payload?.request_id)
    || safeRequestId(fallback)
    || generateRequestId();
}

function generateRequestId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `web-${cryptoApi.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `web-${Date.now().toString(36)}-${random}`;
}

function safeRequestId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return "";
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return "";
  return isSecretLikeRequestId(trimmed) ? "" : trimmed;
}

function isSecretLikeRequestId(value) {
  const lower = value.toLowerCase();
  return lower.startsWith("bearer:")
    || lower.startsWith("bearer.")
    || lower.startsWith("instantml_")
    || lower.startsWith("instantml_live_")
    || lower.startsWith("instantml_test_")
    || lower.startsWith("sk-live-")
    || lower.startsWith("sk-test-")
    || lower.startsWith("sk_live_")
    || lower.startsWith("sk_test_")
    || lower.startsWith("rk_live_")
    || lower.startsWith("rk_test_")
    || lower.startsWith("whsec_")
    || lower.startsWith("gho_")
    || lower.startsWith("ghp_")
    || lower.startsWith("github_pat_")
    || lower.startsWith("xoxb-")
    || lower.startsWith("xoxp-");
}

function safeApiPathForLogs(path) {
  let pathname = "/";
  try {
    pathname = new URL(String(path), "https://instantml.local").pathname;
  } catch {
    pathname = String(path || "/").split("?")[0].split("#")[0] || "/";
  }
  return safeRoutePathname(pathname);
}

function safeRoutePathname(pathname) {
  const segments = String(pathname || "/")
    .split("/")
    .filter(Boolean);
  const known = safeKnownRouteSegments(segments);
  return joinSafePath(known ?? segments.map(redactUnknownPathSegment));
}

function safeKnownRouteSegments(segments) {
  if (segments.length === 0) return [];
  if (segments[0] === "runs") {
    if (segments.length === 2) return ["runs", ":run_id"];
    if (segments.length === 3 && (segments[2] === "metrics" || segments[2] === "rank-metrics")) {
      return ["runs", ":run_id", segments[2]];
    }
  }
  if (segments[0] !== "api") return null;
  if (STATIC_API_ROUTE_KEYS.has(segments.slice(1).join("/"))) return segments;

  if (segments[1] === "workspace-views" && segments.length === 3) {
    return ["api", "workspace-views", ":view_id"];
  }
  if (segments[1] === "workspace-views" && segments.length === 4 && segments[3] === "export") {
    return ["api", "workspace-views", ":view_id", "export"];
  }
  if (segments[1] === "reports") {
    if (segments.length === 2) return ["api", "reports"];
    if (segments.length === 3 && segments[2] === "panels") return ["api", "reports", "panels"];
    if (segments.length === 4 && segments[2] === "share") {
      return ["api", "reports", "share", ":share_token"];
    }
    if (segments.length === 4 && (segments[3] === "share" || segments[3] === "markdown")) {
      return ["api", "reports", ":report_id", segments[3]];
    }
    if (segments.length === 6 && segments[3] === "blocks" && segments[5] === "refresh") {
      return ["api", "reports", ":report_id", "blocks", ":block_index", "refresh"];
    }
    if (segments.length === 3) return ["api", "reports", ":report_id"];
  }
  if (segments[1] === "orgs") {
    if (segments.length === 4 && ["api-keys", "seats", "invitations"].includes(segments[3])) {
      return ["api", "orgs", ":org_id", segments[3]];
    }
    if (segments.length === 6 && segments[3] === "api-keys" && segments[5] === "revoke") {
      return ["api", "orgs", ":org_id", "api-keys", ":api_key_id", "revoke"];
    }
    if (segments.length === 6 && segments[3] === "invitations" && ["resend", "revoke"].includes(segments[5])) {
      return ["api", "orgs", ":org_id", "invitations", ":invitation_id", segments[5]];
    }
    if (segments.length === 6 && segments[3] === "service-accounts" && segments[5] === "disable") {
      return ["api", "orgs", ":org_id", "service-accounts", ":service_account_id", "disable"];
    }
  }
  if (segments[1] === "runs") {
    if (segments.length === 3 && segments[2] === "stop") {
      return ["api", "runs", "stop"];
    }
    if (segments.length === 3 && ["summary", "side-by-side"].includes(segments[2])) {
      return ["api", "runs", segments[2]];
    }
    if (segments.length === 4 && ["stop", "stop-ack", "stop-signal"].includes(segments[3])) {
      return ["api", "runs", ":run_id", segments[3]];
    }
    if (segments.length === 4 && segments[2] !== "rank-metrics" && ["forks", "lineage", "logs", "attributes", "objects", "artifacts", "artifact-uploads", "artifact-inputs", "artifact-edges"].includes(segments[3])) {
      return ["api", "runs", ":run_id", segments[3]];
    }
    if (segments.length === 5 && segments[3] === "artifacts" && segments[4] === "upload") {
      return ["api", "runs", ":run_id", "artifacts", "upload"];
    }
    if (segments.length === 5 && segments[3] === "rank-metrics" && segments[4] === "summary") {
      return ["api", "runs", ":run_id", "rank-metrics", "summary"];
    }
  }
  if (segments[1] === "imports" && segments[2] === "jobs") {
    if (segments.length === 4) return ["api", "imports", "jobs", ":job_id"];
    if (segments.length === 5 && ["chunks", "commit", "cancel"].includes(segments[4])) {
      return ["api", "imports", "jobs", ":job_id", segments[4]];
    }
  }
  if (segments.length === 4 && segments[1] === "objects" && segments[3] === "rows") {
    return ["api", "objects", ":object_id", "rows"];
  }
  if (segments.length === 4 && segments[1] === "artifacts" && segments[3] === "download") {
    return ["api", "artifacts", ":artifact_id", "download"];
  }
  if (segments[1] === "artifact-collections") {
    if (segments.length === 3) return ["api", "artifact-collections", ":collection_id"];
    if (segments.length === 4 && segments[3] === "versions") {
      return ["api", "artifact-collections", ":collection_id", "versions"];
    }
    if (segments.length === 5 && segments[3] === "aliases") {
      return ["api", "artifact-collections", ":collection_id", "aliases", ":alias"];
    }
  }
  if (segments[1] === "artifact-versions") {
    if (segments.length === 3) return ["api", "artifact-versions", ":version_id"];
    if (segments.length === 4 && ["manifest", "lineage", "retention"].includes(segments[3])) {
      return ["api", "artifact-versions", ":version_id", segments[3]];
    }
  }
  if (segments.length === 4 && segments[1] === "artifact-entries" && segments[3] === "download") {
    return ["api", "artifact-entries", ":entry_id", "download"];
  }
  if (segments.length === 4 && segments[1] === "artifact-uploads" && ["renew", "complete", "abort"].includes(segments[3])) {
    return ["api", "artifact-uploads", ":upload_session_id", segments[3]];
  }
  return null;
}

const STATIC_API_ROUTE_KEYS = new Set([
  "admin/overview",
  "auth/config",
  "auth/dev/google",
  "auth/clerk",
  "auth/session",
  "auth/logout",
  "auth/switch-organization",
  "auth/device-code/start",
  "auth/device-code/poll",
  "auth/device-code/confirm",
  "invitations/preview",
  "invitations/accept",
  "billing/status",
  "billing/checkout",
  "billing/checkout/sync",
  "billing/portal",
  "billing/change-plan",
  "billing/add-seat",
  "billing/cancel",
  "billing/storage-overage/report",
  "billing/usage-overage/report",
  "billing/webhook",
  "dashboard/preferences",
  "workspace-view-data",
  "workspace-views",
  "workspace-views/import",
  "reports",
  "reports/panels",
  "users",
  "orgs",
  "orgs/current-user",
  "orgs/memberships",
  "orgs/name-availability",
  "metrics/series",
  "overview",
  "runs/summary",
  "runs/side-by-side",
  "artifact-collections",
  "artifact-versions/resolve",
  "export",
  "usage",
  "usage/export",
  "storage/clickhouse-connections/current",
  "storage/clickhouse-connections/validate",
  "storage/clickhouse-connections",
  "storage/clickhouse-connections/rotate-credentials",
  "demo/reset",
  "imports",
  "imports/jobs",
  "imports/jobs/:id",
  "imports/jobs/:id/chunks",
  "imports/jobs/:id/commit",
  "imports/jobs/:id/cancel",
  "imports/neptune",
  "imports/wandb",
  "imports/mlflow",
]);

function redactUnknownPathSegment(segment) {
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment)) {
    return ":id";
  }
  if (segment.length > 16 || /[=@%:]/.test(segment) || isSecretLikeRequestId(segment)) return ":token";
  return segment;
}

function joinSafePath(segments) {
  return segments.length ? `/${segments.join("/")}` : "/";
}

function logApiRequest(outcome, detail) {
  const event = {
    event: "instantml_api_request",
    outcome,
    requestId: detail.requestId,
    traceId: detail.requestId,
    method: detail.method,
    path: detail.path,
    status: detail.status,
    durationMs: detail.durationMs,
    code: detail.code || "",
    retryable: Boolean(detail.retryable),
  };
  if (outcome === "success") {
    if (frontendApiLogsEnabled()) console.info?.("instantml_api_request", event);
    return;
  }
  if (detail.status >= 500 || detail.status === 0) {
    console.error?.("instantml_api_request", event);
  } else {
    console.warn?.("instantml_api_request", event);
  }
}

function frontendApiLogsEnabled() {
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_INSTANTML_API_LOGS === "1") return true;
  try {
    return globalThis.localStorage?.getItem("instantml:api-logs") === "1";
  } catch {
    return false;
  }
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

export function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// Bounded text reads for inline artifact previews (AR4). Streams at most
// `maxBytes` from a same-origin download route and cancels the rest — a
// preview must never pull a multi-gigabyte file. Lives here so raw fetch()
// stays inside the instrumented API boundary.
/**
 * @param {string} path
 * @param {{ signal?: AbortSignal, maxBytes?: number }} [options]
 */
export async function fetchBoundedText(path, { signal, maxBytes = 16_384 } = {}) {
  const response = await fetch(path, {
    signal,
    // Honored by range-aware servers; harmless otherwise (the reader cap
    // below still bounds the transfer).
    headers: { Range: `bytes=0-${maxBytes - 1}` },
  });
  // A range-aware server answers 416 for an empty file (no satisfiable byte).
  if (response.status === 416) return { text: "", capped: false };
  if (!response.ok && response.status !== 206) {
    throw new ApiError(clientSafeError(response.status, null), { status: response.status });
  }
  // When the server honors the Range (206), the body is exactly the slice we
  // asked for and the reader cap below can't see the truncation. Content-Range
  // ("bytes 0-16383/100000") carries the real size; without it, assume capped.
  let rangeCapped = false;
  if (response.status === 206) {
    const total = Number(/\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "")?.[1]);
    rangeCapped = Number.isFinite(total) ? total > maxBytes : true;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), capped: rangeCapped || text.length > maxBytes };
  }
  const chunks = [];
  let received = 0;
  while (received <= maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
    }
  }
  const capped = rangeCapped || received > maxBytes;
  if (received > maxBytes) await reader.cancel().catch(() => {});
  const merged = new Uint8Array(Math.min(received, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.slice(0, Math.max(0, merged.length - offset));
    merged.set(slice, offset);
    offset += slice.length;
    if (offset >= merged.length) break;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), capped };
}
