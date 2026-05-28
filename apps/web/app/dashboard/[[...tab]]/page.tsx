import { DashboardShell } from "../dashboard-shell";
import type { TabId } from "../../dashboard-types";

type DashboardPageProps = {
  params: Promise<{ tab?: string[] }>;
};

const tabIds = new Set([
  "runs",
  "metrics",
  "distributed",
  "detail",
  "compare",
  "alerts",
  "datasets",
  "insights",
  "artifacts",
  "checkpoints",
  "reports",
  "settings",
  "api",
]);

export default async function DashboardPage({ params }: DashboardPageProps) {
  const { tab = [] } = await params;
  const requestedTab = tab[0] === "models" ? "checkpoints" : (tab[0] ?? "");
  const initialTab = tabIds.has(requestedTab) ? (requestedTab as TabId) : "runs";
  return <DashboardShell initialTab={initialTab} />;
}
