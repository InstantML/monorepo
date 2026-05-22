export function clerkIssuerFromPublishableKey(rawKey) {
  const raw = String(rawKey || "").trim();
  const match = raw.match(/^pk_(test|live)_(.+)$/);
  if (!match) return "";
  try {
    let encoded = match[2].replace(/-/g, "+").replace(/_/g, "/");
    encoded += "=".repeat((4 - (encoded.length % 4)) % 4);
    const decoded = decodeBase64(encoded).trim().replace(/\$+$/, "");
    if (!decoded) return "";
    const parsed = decoded.startsWith("http://") || decoded.startsWith("https://")
      ? new URL(decoded)
      : new URL(`https://${decoded}`);
    return normalizeIssuer(parsed.origin);
  } catch {
    return "";
  }
}

export function clerkIssuerMismatchMessage(frontendPublishableKey, backendIssuer) {
  return clerkIssuerConfigError(frontendPublishableKey, backendIssuer).message;
}

export function clerkIssuerConfigError(frontendPublishableKey, backendIssuer) {
  const expected = normalizeIssuer(backendIssuer);
  const publicMessage = "Sign-in is temporarily unavailable because this environment's authentication settings do not match. Ask an admin to redeploy the matching Clerk configuration.";
  if (!expected) {
    return {
      message: publicMessage,
      diagnostic: "API /api/auth/config did not return a valid clerk_jwt_issuer.",
    };
  }
  const actual = clerkIssuerFromPublishableKey(frontendPublishableKey);
  if (!actual) {
    return {
      message: publicMessage,
      diagnostic: `Frontend NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is missing or invalid; API issuer is ${expected}.`,
    };
  }
  if (actual === expected) return { message: "", diagnostic: "" };
  return {
    message: publicMessage,
    diagnostic: `Frontend issuer ${actual} does not match API issuer ${expected}. Rebuild the frontend with the matching NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.`,
  };
}

function decodeBase64(encoded) {
  if (typeof atob === "function") return atob(encoded);
  if (typeof Buffer !== "undefined") return Buffer.from(encoded, "base64").toString("utf8");
  return "";
}

function normalizeIssuer(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    if (parsed.pathname && parsed.pathname !== "/") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}
