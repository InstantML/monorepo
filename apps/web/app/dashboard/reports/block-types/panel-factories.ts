import type {
  InRunsetCandidate,
  PanelData,
  PanelInventoryEntry,
  PanelType,
} from "./types";
import { defaultPanel } from "./types";

/**
 * Clone a panel spec into a local PanelGrid. The donor and recipient grids can
 * have different runset topology, so the cloned panel starts on runset 0.
 */
export function cloneInventoryPanel(entry: PanelInventoryEntry): PanelData {
  return clonePanelForFirstRunset(entry.panel_spec);
}

/** Clone a panel from a sibling PanelGrid into the first local runset. */
export function cloneInReportPanel(candidate: InRunsetCandidate): PanelData {
  return clonePanelForFirstRunset(candidate.panel);
}

export function defaultPanelWithMetric(type: PanelType, metricKey?: string): PanelData {
  const panel = defaultPanel(type);
  if (!metricKey) return panel;
  if ("metric_key" in panel) {
    (panel as { metric_key: string }).metric_key = metricKey;
  } else if (panel.type === "scatter") {
    panel.x_metric = metricKey;
  }
  return panel;
}

function clonePanelForFirstRunset(panel: PanelData): PanelData {
  const next = JSON.parse(JSON.stringify(panel)) as PanelData;
  if ("runset_index" in next) {
    (next as { runset_index: number }).runset_index = 0;
  }
  return next;
}
