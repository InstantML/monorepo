import {
  Activity,
  AlertTriangle,
  BarChart3,
  Code2,
  Database,
  FileBarChart,
  GitCompare,
  LayoutDashboard,
  Network,
  Package,
  Settings,
  Telescope,
  UploadCloud,
} from "lucide-react";

import { tabFromPath, tabToPath } from "../src/routes.js";
import type { TabId } from "./dashboard-types";

// "overview" is a shell-level surface (route /dashboard/overview) that is not
// part of the canonical TabId set in src/routes.js. The shell widens the tab
// id space locally; routes.js stays the source of truth for the legacy ids.
export type ShellTabId = TabId | "overview";

export const OVERVIEW_PATH = "/dashboard/overview";

// Rail groups follow the reimagine mocks (docs/design/reimagine/shell.js):
// OPERATE leads with Overview, DATA holds the corpus surfaces, SYSTEM holds
// health/reporting/admin. Ids are unchanged; only grouping and order moved.
export const navGroups = [
  {
    id: "operate",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
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

// Canonical routes.js tabs only — excludes "overview", which routes through
// its own static segment (app/dashboard/overview/page.tsx), so the [[...tab]]
// catch-all never needs to resolve it.
export function isTabId(value: string): value is TabId {
  return value !== "overview" && tabIds.has(value);
}

export function isShellTabId(value: string): value is ShellTabId {
  return tabIds.has(value);
}

export function isOverviewPath(pathname: string): boolean {
  const urlPath = String(pathname ?? "").split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  return urlPath === OVERVIEW_PATH || urlPath.startsWith(`${OVERVIEW_PATH}/`);
}

export function shellTabPath(tab: ShellTabId): string {
  return tab === "overview" ? OVERVIEW_PATH : tabToPath(tab);
}

export function shellTabFromPath(pathname: string): ShellTabId {
  if (isOverviewPath(pathname)) return "overview";
  const resolved = tabFromPath(pathname);
  return isTabId(resolved) ? resolved : "runs";
}
