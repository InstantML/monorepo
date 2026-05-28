import type {
  WorkspacePanel,
  WorkspacePanelLayout,
  WorkspacePanelSettings,
  WorkspaceSection,
  WorkspaceView,
} from "../../dashboard-types";

export function resolveWorkspaceSettings(
  view: WorkspaceView,
  section: WorkspaceSection,
  panel: WorkspacePanel,
): WorkspacePanelSettings {
  return {
    xMode: panel.settings?.xMode ?? section.settings?.xMode ?? view.settings.xMode,
    smoothing: panel.settings?.smoothing ?? section.settings?.smoothing ?? view.settings.smoothing,
    groupBy: panel.settings?.groupBy ?? section.settings?.groupBy ?? view.settings.groupBy,
    groupAverage: panel.settings?.groupAverage ?? section.settings?.groupAverage ?? view.settings.groupAverage,
    maxRuns: panel.settings?.maxRuns ?? section.settings?.maxRuns ?? view.settings.maxRuns,
  };
}

export function normalizedPanelLayout(layout?: WorkspacePanelLayout): WorkspacePanelLayout {
  return {
    w: typeof layout?.w === "number" && Number.isFinite(layout.w) ? Math.max(3, Math.min(12, Math.round(layout.w))) : 6,
    h: typeof layout?.h === "number" && Number.isFinite(layout.h) ? Math.max(3, Math.min(10, Math.round(layout.h))) : 4,
  };
}
