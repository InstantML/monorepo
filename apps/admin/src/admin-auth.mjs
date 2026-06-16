export const DEFAULT_ADMIN_ALLOWED_EMAILS = ["instantml.ai@gmail.com"];
export const DEFAULT_CLERK_DOMAIN = "instantml.ai";

export function normalizeAdminEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function parseAdminAllowedEmails(raw) {
  const source = raw == null || String(raw).trim() === ""
    ? DEFAULT_ADMIN_ALLOWED_EMAILS.join(",")
    : String(raw);
  const emails = source
    .split(",")
    .map(normalizeAdminEmail)
    .filter(Boolean);
  return Array.from(new Set(emails));
}

export function isAdminEmailAllowed(email, allowedEmails) {
  const normalized = normalizeAdminEmail(email);
  if (!normalized) return false;
  return allowedEmails.map(normalizeAdminEmail).includes(normalized);
}

export function adminAllowedEmailLabel(allowedEmails) {
  return allowedEmails.length === 1 ? allowedEmails[0] : `${allowedEmails.length} configured emails`;
}

export function hostnameFromRequest(host) {
  return String(host ?? "").split(":")[0]?.trim().toLowerCase() ?? "";
}

export function isInstantMlHost(host) {
  const normalized = hostnameFromRequest(host);
  return normalized === "instantml.ai" || normalized.endsWith(".instantml.ai");
}

export function isProductionClerkKey(publishableKey) {
  return String(publishableKey ?? "").startsWith("pk_live_");
}

export function canLoadClerkForRequest(publishableKey, host, protocol) {
  if (!publishableKey) return false;
  if (!isProductionClerkKey(publishableKey)) return true;
  return isInstantMlHost(host) && String(protocol ?? "") === "https";
}

export function adminClerkDomain(raw = process.env.NEXT_PUBLIC_CLERK_DOMAIN ?? process.env.CLERK_DOMAIN) {
  const configured = String(raw ?? "").trim().toLowerCase();
  if (!configured) return DEFAULT_CLERK_DOMAIN;

  const withoutProtocol = configured.replace(/^https?:\/\//, "");
  const host = withoutProtocol.split("/")[0]?.split(":")[0] ?? "";
  if (!host) return DEFAULT_CLERK_DOMAIN;
  return host.startsWith("clerk.") ? host.slice("clerk.".length) : host;
}
