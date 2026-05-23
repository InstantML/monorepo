import {
  Activity,
  AlertTriangle,
  Archive,
  BarChart3,
  Box,
  Boxes,
  Code2,
  Cpu,
  Database,
  FileBarChart,
  GitCompare,
  HardDrive,
  Network,
  Package,
  Plug,
  Server,
  Settings,
  Telescope,
} from "lucide-react";

import type { IntegrationRow, TabId } from "./dashboard-types";

export const navGroups = [
  {
    id: "core",
    items: [
      { id: "runs", label: "Runs", icon: Activity },
      { id: "metrics", label: "Metrics", icon: BarChart3 },
      { id: "distributed", label: "Distributed", icon: Network },
      { id: "advanced", label: "Advanced", icon: Telescope },
      { id: "compare", label: "Compare", icon: GitCompare },
    ],
  },
  {
    id: "workspace",
    items: [
      { id: "alerts", label: "Alerts", icon: AlertTriangle },
      { id: "insights", label: "Insights", icon: Telescope },
      { id: "datasets", label: "Datasets", icon: Database },
      { id: "artifacts", label: "Artifacts", icon: Package },
      { id: "models", label: "Models", icon: Box },
      { id: "reports", label: "Reports", icon: FileBarChart },
    ],
  },
  {
    id: "admin",
    items: [
      { id: "settings", label: "Settings", icon: Settings },
      { id: "integrations", label: "Integrations", icon: Plug },
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

export function buildIntegrationRows(): IntegrationRow[] {
  return [
    { name: "Python SDK", status: "available", tone: "good", icon: Cpu, detail: "init, log, artifacts, buffering, flush, and offline replay." },
    { name: "Node API", status: "available", tone: "good", icon: Server, detail: "Primary local API for runs, metrics, artifacts, side-by-side, and demo data." },
    { name: "Local storage", status: "available", tone: "good", icon: HardDrive, detail: "File-backed development store plus local artifact metadata." },
    { name: "Neptune import", status: "available", tone: "live", icon: Archive, detail: "JSON · CLI. Neptune Exporter-shaped JSON via tools/import-neptune-json.mjs." },
    { name: "W&B import", status: "available", tone: "live", icon: Boxes, detail: "JSON · CLI. W&B export JSON via tools/import-wandb-json.mjs." },
    { name: "MLflow import", status: "available", tone: "live", icon: Database, detail: "JSON · CLI. MLflow run JSON via tools/import-mlflow-json.mjs." },
  ];
}
