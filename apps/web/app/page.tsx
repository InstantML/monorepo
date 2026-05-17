import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { LandingPage } from "../components/landing/LandingPage";

/**
 * Home route — auth-aware server component.
 *
 * Routing:
 *   Visitor has a Clerk session → /signin
 *     The /signin page checks for an active InstantML session and
 *     redirects to /dashboard/runs when both sessions are present.
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
