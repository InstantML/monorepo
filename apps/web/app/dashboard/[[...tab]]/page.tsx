import { DashboardShell } from "../dashboard-shell";
import { isTabId } from "../../dashboard-config";
import { tabFromPath } from "../../../src/routes.js";
import type { TabId } from "../../dashboard-types";

type DashboardPageProps = {
  params: Promise<{ tab?: string[] }>;
};

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { tab = [] } = await params;
  // routes.js is the single source of truth for tab ids and aliases
  // (models/checkpoints → detail), so SSR and the client resolve identically.
  const resolved = tabFromPath(`/dashboard/${tab[0] ?? ""}`);
  const initialTab: TabId = isTabId(resolved) ? resolved : "runs";
  return <DashboardShell initialTab={initialTab} />;
}
