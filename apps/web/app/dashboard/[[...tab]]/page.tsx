import { DashboardShell } from "../dashboard-shell";
import type { TabId } from "../../dashboard-types";

type DashboardPageProps = {
  params: Promise<{ tab?: string[] }>;
};

const tabIds = new Set([
  "runs",
  "metrics",
  "distributed",
  "advanced",
  "detail",
  "compare",
  "alerts",
  "datasets",
  "insights",
  "artifacts",
  "models",
  "reports",
  "settings",
  "integrations",
  "api",
]);

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { tab = [] } = await params;
  const initialTab = tabIds.has(tab[0] ?? "") ? (tab[0] as TabId) : "runs";
  return <DashboardShell initialTab={initialTab} />;
}
