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

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "x-instantml-bootstrap-token": token,
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `Rust admin API returned ${response.status}. Check the API base and bootstrap token.`,
        apiBase,
        environment,
      };
    }
    return {
      ok: true,
      data: (await response.json()) as AdminOverview,
      apiBase,
      environment,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not reach the Rust admin API.",
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
