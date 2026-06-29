type ServerAuthSession = {
  authenticated?: boolean;
  organization?: {
    id: string;
    name: string;
    slug: string;
    plan_tier?: string;
    seat_limit?: number;
    storage_choice?: string;
    storage_state?: string;
  };
  user?: { primary_email: string; display_name?: string | null; avatar_url?: string | null };
  membership?: { role: string; status: string };
  memberships?: Array<{ org_id: string; role: string; status: string }>;
};

const hostedApiBases = Object.freeze({
  prod: "https://api.instantml.ai",
  staging: "https://staging.api.instantml.ai",
});

export async function serverAuthSession(cookieHeader: string): Promise<ServerAuthSession | null> {
  if (!cookieHeader.includes("instantml_session=")) return null;
  try {
    const response = await fetch(`${resolveControlApiBase()}/api/auth/session`, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.authenticated ? payload as ServerAuthSession : null;
  } catch {
    return null;
  }
}

function resolveControlApiBase() {
  const webApiEnv = resolveWebApiEnv();
  const hostedDefault = hostedApiBases[webApiEnv || "prod"];
  const useHostedDefault = Boolean(webApiEnv) && !isTruthy(process.env.INSTANTML_WEB_EXPLICIT_API_BASES);
  const raw = useHostedDefault
    ? hostedDefault
    : process.env.INSTANTML_CONTROL_API_BASE
      ?? process.env.INSTANTML_API_BASE
      ?? process.env.NEXT_PUBLIC_INSTANTML_API_BASE
      ?? hostedDefault;
  return normalizeApiBase(raw);
}

function resolveWebApiEnv() {
  const raw = (process.env.INSTANTML_WEB_API_ENV ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "prod" || raw === "production") return "prod";
  if (raw === "stage" || raw === "staging") return "staging";
  return "";
}

function normalizeApiBase(rawBase: string) {
  try {
    const url = new URL(rawBase);
    if (!["http:", "https:"].includes(url.protocol)) return hostedApiBases.prod;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return hostedApiBases.prod;
  }
}

function isTruthy(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}
