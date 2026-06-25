export const EMBED_TOKEN_PATTERN = /^instantml_embed_[A-Za-z0-9_-]{43}$/;

const FORBIDDEN_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "access_token",
  "bearer",
  "embed_token",
  "instantml_token",
  "jwt",
  "token",
]);

export function parseEmbedTokenLocation(locationLike) {
  const pathname = typeof locationLike?.pathname === "string" && locationLike.pathname
    ? locationLike.pathname
    : "/";
  const cleanUrl = pathname;
  if (forbiddenEmbedQueryKeys(locationLike?.search ?? "").length > 0) {
    return {
      token: "",
      cleanUrl,
      error: "Embed links cannot include tokens in the query string.",
    };
  }

  const rawHash = String(locationLike?.hash ?? "").startsWith("#")
    ? String(locationLike.hash).slice(1)
    : "";
  const params = new URLSearchParams(rawHash);
  const keys = [...params.keys()];
  const token = params.get("token") ?? "";
  if (keys.length !== 1 || keys[0] !== "token" || !EMBED_TOKEN_PATTERN.test(token)) {
    return {
      token: "",
      cleanUrl,
      error: "This embed link is missing or has an invalid token.",
    };
  }
  return { token, cleanUrl, error: "" };
}

export function forbiddenEmbedQueryKeys(search) {
  const params = new URLSearchParams(search);
  return [...params.keys()].filter((key) => FORBIDDEN_QUERY_KEYS.has(normalizeQueryKey(key)));
}

function normalizeQueryKey(key) {
  return String(key).trim().toLowerCase().replace(/[-.\s]/g, "_");
}
