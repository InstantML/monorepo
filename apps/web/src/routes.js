export const DEFAULT_DASHBOARD_TAB = "runs";

export const DASHBOARD_TAB_IDS = [
  "runs",
  "metrics",
  "distributed",
  "advanced",
  "detail",
  "compare",
  "alerts",
  "insights",
  "datasets",
  "artifacts",
  "models",
  "reports",
  "settings",
  "integrations",
  "api",
];

const DASHBOARD_TABS = new Set(DASHBOARD_TAB_IDS);
const SAFE_NEXT_PREFIXES = ["/dashboard", "/onboarding"];
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const STRIPE_REDIRECT_ORIGINS = new Set(["https://checkout.stripe.com", "https://billing.stripe.com"]);

export function normalizeDeviceUserCode(value) {
  const raw = String(value ?? "").trim();
  if (!raw || CONTROL_CHAR_PATTERN.test(raw)) return "";
  const normalized = raw.toUpperCase();
  if (!/^(?:[A-Z0-9]{8}|[A-Z0-9]{4}-[A-Z0-9]{4})$/.test(normalized)) return "";
  const compact = normalized.replace("-", "");
  if (!/^[A-Z0-9]{8}$/.test(compact)) return "";
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function isDashboardTab(value) {
  return DASHBOARD_TABS.has(String(value ?? ""));
}

export function tabToPath(tab) {
  return `/dashboard/${isDashboardTab(tab) ? tab : DEFAULT_DASHBOARD_TAB}`;
}

export function tabFromPath(pathname) {
  const urlPath = String(pathname ?? "").split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  const match = urlPath.match(/^\/dashboard(?:\/([^/]+))?$/);
  if (!match) return DEFAULT_DASHBOARD_TAB;
  return isDashboardTab(match[1]) ? match[1] : DEFAULT_DASHBOARD_TAB;
}

export function canonicalDashboardPath(pathname) {
  return tabToPath(tabFromPath(pathname));
}

export function pathFromLegacyHash(hash) {
  const value = String(hash ?? "").replace(/^#/, "");
  return isDashboardTab(value) ? tabToPath(value) : "";
}

export function sanitizeNextPath(value, fallback = "/dashboard/runs") {
  const raw = String(value ?? "").trim();
  if (!raw || CONTROL_CHAR_PATTERN.test(raw)) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw === "/") return raw;
  const devicePath = sanitizeDeviceAuthPath(raw);
  if (devicePath) return devicePath;
  if (SAFE_NEXT_PREFIXES.some((prefix) => raw === prefix || raw.startsWith(`${prefix}/`))) return raw;
  return fallback;
}

function sanitizeDeviceAuthPath(raw) {
  try {
    const url = new URL(raw, "http://instantml.local");
    if (url.origin !== "http://instantml.local" || url.pathname !== "/auth/device" || url.hash) return "";
    const keys = [...url.searchParams.keys()];
    if (!keys.length) return "/auth/device";
    if (keys.length !== 1 || keys[0] !== "code") return "";
    const normalized = normalizeDeviceUserCode(url.searchParams.get("code"));
    return normalized ? `/auth/device?code=${normalized}` : "";
  } catch {
    return "";
  }
}

export function safeSameOriginInviteUrl(value, baseOrigin = globalThis.location?.origin ?? "http://localhost") {
  const raw = String(value ?? "").trim();
  if (!raw || CONTROL_CHAR_PATTERN.test(raw)) return "";
  try {
    const url = new URL(raw, baseOrigin);
    if (url.origin !== baseOrigin) return "";
    if (url.pathname !== "/invite") return "";
    if (!url.hash.startsWith("#t=")) return "";
    return `${url.origin}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "";
  }
}

export function safeStripeRedirectUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || CONTROL_CHAR_PATTERN.test(raw)) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    if (!STRIPE_REDIRECT_ORIGINS.has(url.origin)) return "";
    return url.href;
  } catch {
    return "";
  }
}
