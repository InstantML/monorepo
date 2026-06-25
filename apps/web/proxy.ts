import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

const clerkProxy = clerkMiddleware();
const hostedApiBases = Object.freeze({
  prod: "https://api.instantml.ai",
  staging: "https://staging.api.instantml.ai",
});
const EMBED_ROUTE = /^\/embed\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const EMBED_FRAME_TIMEOUT_MS = 1500;

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (isEmbedPath(request.nextUrl.pathname)) {
    return embedResponse(request);
  }
  if (usesExplicitLocalApiBases(request) && !hasClerkRuntimeConfig()) {
    return NextResponse.next();
  }
  return clerkProxy(request, event);
}

async function embedResponse(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-instantml-embed-route", "1");
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  const sessionId = embedSessionId(request.nextUrl.pathname);
  const allowedParentOrigin = sessionId ? await activeAllowedParentOrigin(sessionId) : "";
  response.headers.set("Content-Security-Policy", embedContentSecurityPolicy(allowedParentOrigin));
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.headers.delete("X-Frame-Options");
  return response;
}

function isEmbedPath(pathname: string) {
  return pathname === "/embed" || pathname.startsWith("/embed/");
}

function embedSessionId(pathname: string) {
  return EMBED_ROUTE.exec(pathname)?.[1] ?? "";
}

async function activeAllowedParentOrigin(sessionId: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBED_FRAME_TIMEOUT_MS);
  try {
    const response = await fetch(`${resolveControlApiBase()}/api/embed/sessions/${sessionId}/frame-policy`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return "";
    const payload = await response.json();
    const framePolicy = payload?.frame_policy;
    const origin = typeof framePolicy?.allowed_parent_origin === "string"
      ? framePolicy.allowed_parent_origin
      : "";
    return typeof framePolicy?.status === "string" && framePolicy.status && isHttpOrigin(origin) ? origin : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function embedContentSecurityPolicy(allowedParentOrigin: string) {
  const frameAncestors = allowedParentOrigin || "'none'";
  const devScript = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";
  const devConnect = process.env.NODE_ENV === "production"
    ? ""
    : " http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
    "img-src 'self' data: blob:",
    `connect-src 'self'${devConnect}`,
    `script-src 'self' 'unsafe-inline'${devScript}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; ");
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

function isHttpOrigin(rawOrigin: string) {
  try {
    const url = new URL(rawOrigin);
    return ["http:", "https:"].includes(url.protocol) && rawOrigin === url.origin;
  } catch {
    return false;
  }
}

function usesExplicitLocalApiBases(request: NextRequest) {
  return isTruthy(process.env.INSTANTML_WEB_EXPLICIT_API_BASES)
    && isLoopbackHostname(request.nextUrl.hostname)
    && configuredApiBasesAreLoopback();
}

function isTruthy(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function configuredApiBasesAreLoopback() {
  const bases = [
    process.env.INSTANTML_API_BASE,
    process.env.INSTANTML_CONTROL_API_BASE,
    process.env.INSTANTML_DATA_API_BASE,
  ].flatMap((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed ? [trimmed] : [];
  });
  return bases.length > 0 && bases.every(isLoopbackUrl);
}

function isLoopbackUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return ["http:", "https:"].includes(url.protocol) && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function hasClerkRuntimeConfig() {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
      || process.env.CLERK_PUBLISHABLE_KEY
      || process.env.CLERK_SECRET_KEY,
  );
}

export const config = {
  matcher: [
    "/((?!_next|api|trpc|docs|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|txt|xml|webmanifest)).*)",
    "/__clerk/(.*)",
  ],
};
