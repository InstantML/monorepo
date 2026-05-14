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
  FileText,
  GitCompare,
  HardDrive,
  Package,
  Plug,
  Server,
  Settings,
} from "lucide-react";

import type { IntegrationRow, TabId } from "./dashboard-types";

export const navGroups = [
  {
    id: "core",
    items: [
      { id: "runs", label: "Runs", icon: Activity },
      { id: "metrics", label: "Metrics", icon: BarChart3 },
      { id: "detail", label: "Run Detail", icon: FileText },
      { id: "compare", label: "Compare", icon: GitCompare },
    ],
  },
  {
    id: "workspace",
    items: [
      { id: "alerts", label: "Alerts", icon: AlertTriangle },
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

const tabIds = new Set<TabId>(tabs.map((tab) => tab.id));

export function isTabId(value: string): value is TabId {
  return tabIds.has(value as TabId);
}

export function buildIntegrationRows(): IntegrationRow[] {
  return [
    { name: "Python SDK", status: "available", tone: "good", icon: Cpu, detail: "init, log, artifacts, buffering, flush, and offline replay." },
    { name: "Node API", status: "available", tone: "good", icon: Server, detail: "Primary local API for runs, metrics, artifacts, side-by-side, and demo data." },
    { name: "Local storage", status: "available", tone: "good", icon: HardDrive, detail: "File-backed development store plus local artifact metadata." },
    { name: "Neptune import", status: "available", tone: "live", icon: Archive, detail: "Neptune Exporter-shaped JSON import path in the Node server." },
    { name: "W&B import", status: "planned", tone: "neutral", icon: Boxes, detail: "Planned migration path after the typed ingestion workflow hardens." },
    { name: "MLflow import", status: "planned", tone: "neutral", icon: Database, detail: "Planned importer using the same typed attribute path." },
  ];
}
