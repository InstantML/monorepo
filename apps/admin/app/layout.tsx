import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { canLoadClerkForRequest } from "../src/admin-auth.mjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "InstantML Admin",
  description: "Internal InstantML operator console.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  const requestHeaders = await headers();
  const requestHost = requestHeaders.get("host");
  const requestProtocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const shouldLoadClerk = canLoadClerkForRequest(publishableKey, requestHost, requestProtocol);
  const body = shouldLoadClerk ? (
    <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>
  ) : (
    children
  );

  return (
    <html lang="en">
      <body>{body}</body>
    </html>
  );
}
