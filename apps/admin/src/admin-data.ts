import { randomUUID } from "node:crypto";

import type { components } from "../../web/src/types/api.generated";

export type AdminOverview = components["schemas"]["AdminOverviewResponse"];
export type AdminOrganization = components["schemas"]["AdminOrganizationSummary"];
export type AdminUser = components["schemas"]["AdminUserSummary"];
export type AdminApiKey = components["schemas"]["AdminApiKeySummary"];
export type AdminRisk = components["schemas"]["AdminRiskItem"];

type FetchArgs = {
  q?: string;
};

type AdminLoadResult =
  | {
      ok: true;
      data: AdminOverview;
      apiBase: string;
      environment: string;
    }
  | {
      ok: false;
      message: string;
      apiBase: string;
      environment: string;
    };

const DEFAULT_API_BASE = "http://127.0.0.1:8000";

export async function fetchAdminOverview({ q }: FetchArgs): Promise<AdminLoadResult> {
  const apiBase = normalizeApiBase(
    process.env.INSTANTML_ADMIN_API_BASE ?? process.env.INSTANTML_API_BASE ?? DEFAULT_API_BASE,
  );
  const environment = process.env.INSTANTML_ADMIN_ENVIRONMENT ?? "Local";
  const requestId = adminRequestId();
  const token = process.env.INSTANTML_ADMIN_BOOTSTRAP_TOKEN ?? process.env.INSTANTML_BOOTSTRAP_TOKEN;
  if (!token) {
    return {
      ok: false,
      message:
        "Set INSTANTML_ADMIN_BOOTSTRAP_TOKEN or INSTANTML_BOOTSTRAP_TOKEN before starting the admin app.",
      apiBase,
      environment,
    };
  }

  const url = new URL("/api/admin/overview", apiBase);
  url.searchParams.set("limit", "100");
  if (q?.trim()) url.searchParams.set("q", q.trim());

  const startedAt = Date.now();
  let responseStatus = 0;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "x-instantml-bootstrap-token": token,
        "x-request-id": requestId,
      },
    });
    responseStatus = response.status;
    const finalRequestId = responseRequestId(response, requestId);
    if (!response.ok) {
      logAdminApiRequest("failure", {
        requestId: finalRequestId,
        status: response.status,
        durationMs: elapsedMs(startedAt),
        code: `http_${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      });
      return {
        ok: false,
        message: `Rust admin API returned ${response.status}. Request ${finalRequestId}. Check the API base and bootstrap token.`,
        apiBase,
        environment,
      };
    }
    const data = (await response.json()) as AdminOverview;
    logAdminApiRequest("success", {
      requestId: finalRequestId,
      status: response.status,
      durationMs: elapsedMs(startedAt),
      code: "ok",
      retryable: false,
    });
    return {
      ok: true,
      data,
      apiBase,
      environment,
    };
  } catch (error) {
    const message = responseStatus > 0
      ? "Rust admin API returned malformed JSON."
      : "Could not reach the Rust admin API.";
    logAdminApiRequest("failure", {
      requestId,
      status: responseStatus,
      durationMs: elapsedMs(startedAt),
      code: "network_or_parse_error",
      retryable: responseStatus === 0 || responseStatus >= 500,
    });
    return {
      ok: false,
      message: `${error instanceof Error && responseStatus === 0 ? error.message : message} Request ${requestId}.`,
      apiBase,
      environment,
    };
  }
}

function normalizeApiBase(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("INSTANTML_ADMIN_API_BASE must be an http(s) URL.");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function adminRequestId(): string {
  return `admin-${randomUUID()}`;
}

function responseRequestId(response: Response, fallback: string): string {
  return safeRequestId(response.headers.get("x-request-id")) || fallback;
}

function safeRequestId(value: string | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return "";
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return "";
  return isSecretLikeRequestId(trimmed) ? "" : trimmed;
}

function isSecretLikeRequestId(value: string): boolean {
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

function logAdminApiRequest(
  outcome: "success" | "failure",
  detail: {
    requestId: string;
    status: number;
    durationMs: number;
    code: string;
    retryable: boolean;
  },
) {
  const event = {
    event: "instantml_admin_api_request",
    outcome,
    requestId: detail.requestId,
    traceId: detail.requestId,
    method: "GET",
    path: "/api/admin/overview",
    status: detail.status,
    durationMs: detail.durationMs,
    code: detail.code,
    retryable: detail.retryable,
  };
  if (outcome === "success") {
    console.info("instantml_admin_api_request", event);
  } else if (detail.status === 0 || detail.status >= 500) {
    console.error("instantml_admin_api_request", event);
  } else {
    console.warn("instantml_admin_api_request", event);
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
