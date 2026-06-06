import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LandingPage } from "../components/landing/LandingPage";

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
 *   Visitor has a Clerk session → /signin
 *     The /signin page checks for an active InstantML session and
 *     redirects to /dashboard/runs when both sessions are present
 *     and org storage is ready; otherwise it sends the user back to
 *     /onboarding to finish storage setup.
 *     This reuses existing logic without duplicating the InstantML
 *     session check here.
 *
 *   No Clerk session → render the landing page.
 *
 * Follow-up: a direct /dashboard/runs redirect for visitors with a
 * warm InstantML session cookie can be added once the server-side
 * InstantML session check is confirmed reliable in RSC context.
 * See docs/design/2026-05-17-landing-merge-into-web.md.
 */
export default async function Home() {
  const userId = await clerkUserIdOrNull();
  if (userId) {
    redirect("/signin");
  }
  return <LandingPage />;
}
