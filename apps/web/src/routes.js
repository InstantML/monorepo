export const DEFAULT_DASHBOARD_TAB = "runs";
export const ONBOARDING_PATH = "/onboarding";
export const STORAGE_READY_STATES = new Set(["storage_ready", "storage_locked"]);

export const DASHBOARD_TAB_IDS = [
  "runs",
  "metrics",
  "distributed",
  "traces",
  "detail",
  "compare",
  "alerts",
  "insights",
  "datasets",
  "artifacts",
  "reports",
  "settings",
  "agent",
];

const DASHBOARD_TABS = new Set(DASHBOARD_TAB_IDS);
const DASHBOARD_TAB_ALIASES = new Map([
  // CK2: the standalone Checkpoints tab merged into Run Detail (which owns
  // download/resume/fork and the lineage rows). Old links keep working.
  ["models", "detail"],
  ["checkpoints", "detail"],
  // The standalone Compare page collapsed into the Runs → Table view: select a
  // set of runs and the comparison renders inline. Old /dashboard/compare links
  // (and the run-detail "Compare" action) canonicalize to the Runs tab.
  ["compare", "runs"],
  // The Alerts tab is labelled "Run Health" in the rail, so the friendly slug
  // a user would guess from that label resolves to the same page.
  ["run-health", "alerts"],
  ["health", "alerts"],
  // The old API tab became the agent-first surface. API keys and route
  // reference now live under Workspace settings -> API.
  ["api", "agent"],
]);
const SAFE_NEXT_PREFIXES = ["/dashboard", "/onboarding"];
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const STRIPE_REDIRECT_ORIGINS = new Set(["https://checkout.stripe.com", "https://billing.stripe.com"]);
const LOCAL_CHECKOUT_SESSION_PATTERN = /^cs_(?:test|live)_[A-Za-z0-9_=-]{8,}$/;

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
  const tab = String(value ?? "");
  return DASHBOARD_TABS.has(tab) || DASHBOARD_TAB_ALIASES.has(tab);
}

function canonicalDashboardTab(value) {
  const tab = String(value ?? "");
  return DASHBOARD_TAB_ALIASES.get(tab) ?? tab;
}

export function tabToPath(tab) {
  const canonical = canonicalDashboardTab(tab);
  return `/dashboard/${DASHBOARD_TABS.has(canonical) ? canonical : DEFAULT_DASHBOARD_TAB}`;
}

export function tabFromPath(pathname) {
  const urlPath = String(pathname ?? "").split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  const match = urlPath.match(/^\/dashboard(?:\/([^/]+))?(?:\/.*)?$/);
  if (!match) return DEFAULT_DASHBOARD_TAB;
  const tab = canonicalDashboardTab(match[1]);
  return DASHBOARD_TABS.has(tab) ? tab : DEFAULT_DASHBOARD_TAB;
}

export function canonicalDashboardPath(pathname) {
  const urlPath = String(pathname ?? "").split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  const match = urlPath.match(/^\/dashboard(?:\/([^/]+))?(\/.*)?$/);
  if (!match) return tabToPath(DEFAULT_DASHBOARD_TAB);
  const tab = canonicalDashboardTab(match[1]);
  const safeTab = DASHBOARD_TABS.has(tab) ? tab : DEFAULT_DASHBOARD_TAB;
  if (safeTab === "reports" && match[2]) return `/dashboard/reports${match[2]}`;
  return tabToPath(safeTab);
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

export function isStorageReadyState(value) {
  return STORAGE_READY_STATES.has(String(value ?? ""));
}

export function organizationRequiresStorageOnboarding(organization) {
  if (!organization?.id) return false;
  if (isStorageReadyState(organization.storage_state)) return false;
  if (Object.prototype.hasOwnProperty.call(organization, "storage_state")) return true;
  return organization.storage_choice === "customer-clickhouse";
}

export function sessionRequiresStorageOnboarding(session) {
  if (!session?.authenticated) return false;
  return organizationRequiresStorageOnboarding(session.organization);
}

export function onboardingRedirectPath(requestedPath = "/dashboard/runs") {
  const nextPath = sanitizeNextPath(requestedPath);
  if (nextPath === ONBOARDING_PATH || nextPath.startsWith(`${ONBOARDING_PATH}/`)) return ONBOARDING_PATH;
  return `${ONBOARDING_PATH}?next=${encodeURIComponent(nextPath)}`;
}

export function postAuthRedirectPath(session, requestedPath = "/dashboard/runs") {
  return sessionRequiresStorageOnboarding(session)
    ? onboardingRedirectPath(requestedPath)
    : sanitizeNextPath(requestedPath);
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

export function safeCheckoutRedirectUrl(value, baseOrigin = globalThis.location?.origin ?? "http://localhost") {
  const raw = String(value ?? "").trim();
  if (!raw || CONTROL_CHAR_PATTERN.test(raw)) return "";
  try {
    const url = new URL(raw, baseOrigin);
    if (url.origin === baseOrigin) {
      if (url.pathname !== "/billing/return" || url.hash) return "";
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== "session_id") return "";
      return LOCAL_CHECKOUT_SESSION_PATTERN.test(url.searchParams.get("session_id") ?? "") ? url.href : "";
    }
    if (url.protocol !== "https:" || !STRIPE_REDIRECT_ORIGINS.has(url.origin)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export const safeStripeRedirectUrl = safeCheckoutRedirectUrl;
