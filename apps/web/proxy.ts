import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

const clerkProxy = clerkMiddleware();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.nextUrl.pathname === "/" && process.env.INSTANTML_WEB_EXPLICIT_API_BASES === "1") {
    return NextResponse.next();
  }
  return clerkProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|api|trpc|docs|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|txt|xml|webmanifest)).*)",
    "/__clerk/(.*)",
  ],
};
