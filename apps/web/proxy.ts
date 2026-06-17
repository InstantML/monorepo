import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

const clerkProxy = clerkMiddleware();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (usesExplicitLocalApiBases(request) && !hasClerkRuntimeConfig()) {
    return NextResponse.next();
  }
  return clerkProxy(request, event);
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
