import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { LandingPage } from "../components/landing/LandingPage";
import { postAuthRedirectPath } from "../src/routes.js";
import { serverAuthSession } from "./server-auth";

const LANDING_TITLE = "InstantML — Experiment tracking that keeps up with training";
const LANDING_DESCRIPTION =
  "Log runs, compare metrics, inspect artifacts, and export experiment data without waiting on the dashboard.";

export const metadata: Metadata = {
  title: {
    absolute: LANDING_TITLE,
  },
  description: LANDING_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "https://instantml.ai/",
    siteName: "InstantML",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
  },
};

async function clerkUserIdOrNull() {
  try {
    const { userId } = await auth();
    return userId;
  } catch {
    return null;
  }
}

/**
 * Home route — auth-aware server component.
 *
 * Routing:
 *   Visitor has an active InstantML session → /dashboard/runs
 *     (or /onboarding when org storage setup is pending), via the
 *     same postAuthRedirectPath used by /signin. The InstantML
 *     session is checked first because it is what the dashboard
 *     actually runs on — it can outlive the Clerk session.
 *
 *   Clerk session only → /signin
 *     The /signin page handles the "Clerk-authenticated but no
 *     InstantML session" handshake and redirects onward once both
 *     sessions are active.
 *
 *   Neither session → render the landing page.
 *
 * See docs/design/2026-05-17-landing-merge-into-web.md.
 */
export default async function Home() {
  const session = await serverAuthSession((await headers()).get("cookie") ?? "");
  if (session?.authenticated) {
    redirect(postAuthRedirectPath(session));
  }
  const userId = await clerkUserIdOrNull();
  if (userId) {
    redirect("/signin");
  }
  return <LandingPage />;
}
