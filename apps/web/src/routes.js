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
  if (SAFE_NEXT_PREFIXES.some((prefix) => raw === prefix || raw.startsWith(`${prefix}/`))) return raw;
  return fallback;
}
