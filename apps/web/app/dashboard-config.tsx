import {
  Activity,
  AlertTriangle,
  BarChart3,
  Box,
  Code2,
  Database,
  FileBarChart,
  GitCompare,
  Network,
  Package,
  Settings,
  Telescope,
  UploadCloud,
} from "lucide-react";

import type { TabId } from "./dashboard-types";

export const navGroups = [
  {
    id: "core",
    items: [
      { id: "runs", label: "Runs", icon: Activity },
      { id: "metrics", label: "Metrics", icon: BarChart3 },
      { id: "distributed", label: "Distributed", icon: Network },
      { id: "compare", label: "Compare", icon: GitCompare },
    ],
  },
  {
    id: "workspace",
    items: [
      { id: "insights", label: "Insights", icon: Telescope },
      { id: "artifacts", label: "Artifacts", icon: Package },
      { id: "reports", label: "Reports", icon: FileBarChart },
    ],
  },
  // Adoption and health surfaces users visit occasionally, grouped below the
  // daily-loop tabs so the rail leads with analysis. Ids and routes unchanged.
  {
    id: "more",
    items: [
      { id: "alerts", label: "Run health", icon: AlertTriangle },
      { id: "datasets", label: "Datasets", icon: Database },
      { id: "imports", label: "Imports", icon: UploadCloud },
      { id: "checkpoints", label: "Checkpoints", icon: Box },
    ],
  },
  {
    id: "admin",
    items: [
      { id: "settings", label: "Settings", icon: Settings },
      { id: "api", label: "API", icon: Code2 },
    ],
  },
] as const;

export const tabs = navGroups.flatMap((group) => [...group.items]);

// `detail` is intentionally not a nav item (reached by clicking a run), but it
// is still a valid tab/route — keep it in the id set so isTabId stays correct.
const tabIds = new Set<TabId>([...tabs.map((tab) => tab.id), "detail"]);

export function isTabId(value: string): value is TabId {
  return tabIds.has(value as TabId);
}
