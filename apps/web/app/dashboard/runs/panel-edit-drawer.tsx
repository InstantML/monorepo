"use client";

import { useLayoutEffect, useState } from "react";
import { X } from "lucide-react";

import { workspacePanelTypeLabel } from "../../dashboard-models";
import { CustomSelect } from "../ui/select";
import { useFocusTrap } from "../ui/use-focus-trap";
import type { WorkspacePanel, WorkspacePanelLayout, WorkspacePanelSettings, WorkspacePanelType, WorkspaceSection, WorkspaceView } from "../../dashboard-types";

export function resolveWorkspaceSettings(view: WorkspaceView, section: WorkspaceSection, panel: WorkspacePanel): WorkspacePanelSettings {
  return {
    xMode: panel.settings?.xMode ?? section.settings?.xMode ?? view.settings.xMode,
    smoothing: panel.settings?.smoothing ?? section.settings?.smoothing ?? view.settings.smoothing,
    groupBy: panel.settings?.groupBy ?? section.settings?.groupBy ?? view.settings.groupBy,
    groupAverage: panel.settings?.groupAverage ?? section.settings?.groupAverage ?? view.settings.groupAverage,
    maxRuns: panel.settings?.maxRuns ?? section.settings?.maxRuns ?? view.settings.maxRuns,
  };
}

function workspacePanelTypesFromValue(value: string): WorkspacePanelType {
  return value === "bar" || value === "histogram" || value === "dot" ? value : "line";
}

export function normalizedPanelLayout(layout?: WorkspacePanelLayout): WorkspacePanelLayout {
  return {
    w: typeof layout?.w === "number" && Number.isFinite(layout.w) ? Math.max(3, Math.min(12, Math.round(layout.w))) : 6,
    h: typeof layout?.h === "number" && Number.isFinite(layout.h) ? Math.max(3, Math.min(10, Math.round(layout.h))) : 4,
  };
}

export function PanelEditDrawer({
  metricOptions,
  onClose,
  onUpdate,
  panel,
  section,
  view,
}: {
  metricOptions: string[];
  onClose: () => void;
  onUpdate: (patch: { title?: string; type?: WorkspacePanelType; metricKey?: string; settings?: Partial<WorkspacePanelSettings> }) => void;
  panel: WorkspacePanel;
  section: WorkspaceSection;
  view: WorkspaceView;
}) {
  const settings = resolveWorkspaceSettings(view, section, panel);
  const drawerRef = useFocusTrap<HTMLElement>(true, onClose, "input, button[aria-label='Close edit panel']");
  const side = useDrawerSide(panel.id);
  return (
    <aside className="panel-drawer edit-drawer" data-side={side} role="dialog" aria-modal="true" aria-label="Edit panel" ref={drawerRef} tabIndex={-1}>
      <div className="drawer-head">
        <h2>{workspacePanelTypeLabel(panel.type)} panel</h2>
        <button className="icon-button" type="button" aria-label="Close edit panel" onClick={onClose}><X size={16} /></button>
      </div>
      <CustomSelect
        className="full"
        id="edit-panel-type"
        label="Chart type"
        onChange={(type) => onUpdate({ type: workspacePanelTypesFromValue(type) })}
        options={[
          { value: "line", label: "Line" },
          { value: "bar", label: "Bar" },
          { value: "histogram", label: "Histogram" },
          { value: "dot", label: "Dot plot" },
        ]}
        value={panel.type}
      />
      <label className="control full">
        Title
        <input value={panel.title} onChange={(event) => onUpdate({ title: event.target.value })} />
      </label>
      <CustomSelect
        className="full"
        id="edit-panel-metric"
        label="Y"
        onChange={(metricKey) => onUpdate({ metricKey })}
        options={metricOptions.length ? metricOptions.map((metric) => ({ value: metric, label: metric })) : [{ value: panel.metricKey, label: panel.metricKey }]}
        value={panel.metricKey}
      />
      <CustomSelect
        className="full"
        id="edit-panel-x"
        label="X axis"
        onChange={(xMode) => onUpdate({ settings: { xMode: xMode === "time" ? "time" : "step" } })}
        options={[{ value: "step", label: "Step" }, { value: "time", label: "Logged time" }]}
        value={settings.xMode}
      />
      <CustomSelect
        className="full"
        id="edit-panel-group"
        label="Group"
        onChange={(groupBy) => onUpdate({ settings: { groupBy } })}
        options={[
          { value: "", label: "None" },
          { value: "seed", label: "Seed" },
          { value: "tag", label: "First tag" },
          { value: "config:algo", label: "Config: algo" },
          { value: "config:policy", label: "Config: policy" },
        ]}
        value={settings.groupBy}
      />
      <label className="control full">
        Max runs to show
        <input type="number" min="1" max="25" value={settings.maxRuns} onChange={(event) => onUpdate({ settings: { maxRuns: Number(event.target.value) } })} />
      </label>
      <label className="control full">
        Smoothing
        <input type="range" min="0" max="90" step="10" value={settings.smoothing} onChange={(event) => onUpdate({ settings: { smoothing: Number(event.target.value) } })} />
      </label>
      <label className="toggle-control drawer-toggle">
        <span>Show group average</span>
        <input type="checkbox" checked={settings.groupAverage} onChange={(event) => onUpdate({ settings: { groupAverage: event.target.checked } })} />
      </label>
    </aside>
  );
}

const DRAWER_WIDTH = 410;
const DRAWER_MARGIN = 18;

function useDrawerSide(panelId: string): "left" | "right" {
  const [side, setSide] = useState<"left" | "right">("right");
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const compute = () => {
      const card = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`);
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const drawerSpan = DRAWER_WIDTH + DRAWER_MARGIN * 2;
      const overlapsRight = rect.right > window.innerWidth - drawerSpan;
      const overlapsLeft = rect.left < drawerSpan;
      if (overlapsRight && !overlapsLeft) setSide("left");
      else setSide("right");
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [panelId]);
  return side;
}
