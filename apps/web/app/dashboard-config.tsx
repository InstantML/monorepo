import {
  Activity,
  AlertTriangle,
  BarChart3,
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

import { tabFromPath, tabToPath } from "../src/routes.js";
import type { TabId } from "./dashboard-types";

// ShellTabId once widened the canonical TabId set with the "overview" cockpit
// surface; that page was removed, so the shell id space is now exactly TabId.
// The alias is kept so call sites don't churn.
export type ShellTabId = TabId;

// Rail groups follow the reimagine mocks (docs/design/reimagine/shell.js):
// OPERATE leads with Runs, DATA holds the corpus surfaces, SYSTEM holds
// health/reporting/admin. Ids are unchanged; only grouping and order moved.
export const navGroups = [
  {
    id: "operate",
    items: [
      { id: "runs", label: "Runs", icon: Activity },
      { id: "metrics", label: "Metrics", icon: BarChart3 },
      { id: "compare", label: "Compare", icon: GitCompare },
      { id: "distributed", label: "Distributed", icon: Network },
    ],
  },
  {
    id: "data",
    items: [
      { id: "datasets", label: "Datasets", icon: Database },
      { id: "artifacts", label: "Artifacts", icon: Package },
      { id: "imports", label: "Imports", icon: UploadCloud },
      { id: "insights", label: "Insights", icon: Telescope },
    ],
  },
  {
    id: "system",
    items: [
      { id: "alerts", label: "Run Health", icon: AlertTriangle },
      { id: "reports", label: "Reports", icon: FileBarChart },
      { id: "settings", label: "Settings", icon: Settings },
      { id: "api", label: "API", icon: Code2 },
    ],
  },
] as const;

export const tabs = navGroups.flatMap((group) => [...group.items]);

// `detail` is intentionally not a nav item (reached by clicking a run), but it
// is still a valid tab/route — keep it in the id set so isTabId stays correct.
const tabIds = new Set<string>([...tabs.map((tab) => tab.id), "detail"]);

export function isTabId(value: string): value is TabId {
  return tabIds.has(value);
}

export function isShellTabId(value: string): value is ShellTabId {
  return tabIds.has(value);
}

export function shellTabPath(tab: ShellTabId): string {
  return tabToPath(tab);
}

export function shellTabFromPath(pathname: string): ShellTabId {
  const resolved = tabFromPath(pathname);
  return isTabId(resolved) ? resolved : "runs";
}
