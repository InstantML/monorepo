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

  async request(path, options = {}) {
    const response = await fetch(this.baseUrl + path, options);
    const payload = await readPayload(response);
    if (!response.ok) throw new ApiError(clientSafeError(response.status, payload), {
      code: typeof payload?.code === "string" ? payload.code : "",
      requestId: typeof payload?.request_id === "string" ? payload.request_id : "",
      status: response.status,
    });
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ApiError("Server returned malformed payload");
    }
    return payload;
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
  constructor(message, { code = "", requestId = "", status = 0 } = {}) {
    super(requestId ? `${message} Request ${requestId}.` : message);
    this.name = "ApiError";
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export function isTransientApiError(error) {
  if (error instanceof ApiError) return error.status === 408 || error.status === 429 || error.status >= 500;
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

export function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
