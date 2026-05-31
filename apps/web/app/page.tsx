import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LandingPage } from "../components/landing/LandingPage";

const LANDING_TITLE = "InstantML — Training observability that keeps up with your loop";
const LANDING_DESCRIPTION =
  "Training observability with fast run comparison, predictable pricing, and clearer control over experiment data for lean ML teams.";

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
  const { userId } = await auth();
  if (userId) {
    redirect("/signin");
  }
  return <LandingPage />;
}
