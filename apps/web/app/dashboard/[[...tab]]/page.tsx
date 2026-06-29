import { DashboardShell } from "../dashboard-shell";
import { isTabId } from "../../dashboard-config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { postAuthRedirectPath, sanitizeNextPath, tabFromPath } from "../../../src/routes.js";
import { serverAuthSession } from "../../server-auth";
import type { TabId } from "../../dashboard-types";

type DashboardPageProps = {
  params: Promise<{ tab?: string[] }>;
};

function requestedDashboardPath(tab: string[]) {
  const suffix = tab.filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
  return suffix ? `/dashboard/${suffix}` : "/dashboard/runs";
}

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { tab = [] } = await params;
  // routes.js is the single source of truth for tab ids and aliases
  // (models/checkpoints → detail), so SSR and the client resolve identically.
  const requestedPath = requestedDashboardPath(tab);
  const session = await serverAuthSession((await headers()).get("cookie") ?? "");
  if (!session?.authenticated) {
    redirect(`/signin?next=${encodeURIComponent(sanitizeNextPath(requestedPath))}`);
  }
  const destination = postAuthRedirectPath(session, requestedPath);
  if (destination.startsWith("/onboarding")) {
    redirect(destination);
  }
  const resolved = tabFromPath(`/dashboard/${tab[0] ?? ""}`);
  const initialTab: TabId = isTabId(resolved) ? resolved : "runs";
  return <DashboardShell initialTab={initialTab} initialSession={session} />;
}
