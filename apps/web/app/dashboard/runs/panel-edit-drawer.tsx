"use client";

import { useLayoutEffect, useState } from "react";
import { X } from "lucide-react";

import { categoricalFieldLabel, defaultDistributionFields, defaultScatterFields, fieldLabel, parseCategoricalFieldId, parseFieldId } from "../../../src/dashboard-panels.js";
import { WORKSPACE_PANEL_TYPES, workspacePanelTypeLabel } from "../../dashboard-models";
import { CustomSelect } from "../ui/select";
import type { SelectOption } from "../ui/select";
import { useFocusTrap } from "../ui/use-focus-trap";
import { resolveWorkspaceSettings } from "./panel-settings";
import type { WorkspaceCategoricalFieldOption, WorkspaceFieldOption, WorkspacePanel, WorkspacePanelSettings, WorkspacePanelType, WorkspaceSection, WorkspaceView } from "../../dashboard-types";

function workspacePanelTypesFromValue(value: string): WorkspacePanelType {
  return WORKSPACE_PANEL_TYPES.includes(value as WorkspacePanelType) ? value as WorkspacePanelType : "line";
}

export function PanelEditDrawer({
  categoricalFieldOptions,
  fieldOptions,
  metricOptions,
  onClose,
  onUpdate,
  panel,
  section,
  view,
}: {
  categoricalFieldOptions: WorkspaceCategoricalFieldOption[];
  fieldOptions: WorkspaceFieldOption[];
  metricOptions: string[];
  onClose: () => void;
  onUpdate: (patch: {
    title?: string;
    type?: WorkspacePanelType;
    metricKey?: string;
    xField?: string;
    yField?: string;
    valueField?: string;
    groupField?: string;
    replicateField?: string;
    objectKey?: string;
    settings?: Partial<WorkspacePanelSettings>;
  }) => void;
  panel: WorkspacePanel;
  section: WorkspaceSection;
  view: WorkspaceView;
}) {
  const settings = resolveWorkspaceSettings(view, section, panel);
  const drawerRef = useFocusTrap<HTMLElement>(true, onClose, "input, button[aria-label='Close edit panel']");
  const side = useDrawerSide(panel.id);
  const isValidField = (value: string | undefined): value is string => Boolean(value && parseFieldId(value));
  const isValidCategoricalField = (value: string | undefined): value is string => Boolean(value && parseCategoricalFieldId(value));
  const fallbackScatterFields = defaultScatterFields(panel.metricKey, fieldOptions);
  const defaultXField = isValidField(panel.xField) ? panel.xField : fallbackScatterFields.xField;
  const defaultYField = isValidField(panel.yField) ? panel.yField : fallbackScatterFields.yField;
  const fallbackDistributionFields = defaultDistributionFields(panel.metricKey, fieldOptions, categoricalFieldOptions);
  const defaultValueField = panel.type === "distribution" && isValidField(panel.valueField) ? panel.valueField : fallbackDistributionFields.valueField;
  const defaultGroupField = panel.type === "distribution" && isValidCategoricalField(panel.groupField) ? panel.groupField : fallbackDistributionFields.groupField;
  const defaultReplicateField = panel.type === "distribution" && isValidCategoricalField(panel.replicateField) ? panel.replicateField : fallbackDistributionFields.replicateField;
  const fieldSelectOptionMap = new Map<string, SelectOption>();
  for (const field of fieldOptions) {
    const runWord = field.availableCount === 1 ? "run" : "runs";
    fieldSelectOptionMap.set(field.id, {
      value: field.id,
      label: field.label,
      description: `${field.availableCount} ${runWord} available`,
    });
  }
  for (const fieldId of [panel.xField, panel.yField]) {
    if (isValidField(fieldId) && !fieldSelectOptionMap.has(fieldId)) {
      fieldSelectOptionMap.set(fieldId, { value: fieldId, label: fieldLabel(fieldId), description: "Saved field not present in loaded runs" });
    }
  }
  const fieldSelectOptions = [...fieldSelectOptionMap.values()];
  const categoricalSelectOptionMap = new Map<string, SelectOption>();
  categoricalSelectOptionMap.set("", { value: "", label: "None", description: "Do not group by a categorical field" });
  for (const field of categoricalFieldOptions) {
    const runWord = field.availableCount === 1 ? "run" : "runs";
    categoricalSelectOptionMap.set(field.id, {
      value: field.id,
      label: field.label,
      description: `${field.groupCount} groups across ${field.availableCount} ${runWord}`,
    });
  }
  for (const fieldId of [panel.type === "distribution" ? panel.groupField : undefined, panel.type === "distribution" ? panel.replicateField : undefined]) {
    if (isValidCategoricalField(fieldId) && !categoricalSelectOptionMap.has(fieldId)) {
      categoricalSelectOptionMap.set(fieldId, { value: fieldId, label: categoricalFieldLabel(fieldId), description: "Saved field not present in loaded runs" });
    }
  }
  const categoricalSelectOptions = [...categoricalSelectOptionMap.values()];
  function updateType(value: string) {
    const type = workspacePanelTypesFromValue(value);
    if (type === "scatter") {
      onUpdate({
        type,
        xField: defaultXField,
        yField: defaultYField,
      });
      return;
    }
    if (type === "distribution") {
      onUpdate({
        type,
        valueField: defaultValueField,
        groupField: defaultGroupField,
        replicateField: defaultReplicateField,
      });
      return;
    }
    if (type === "histogram_timeline") {
      onUpdate({
        type,
        objectKey: panel.type === "histogram_timeline" ? panel.objectKey : panel.metricKey,
      });
      return;
    }
    onUpdate({ type });
  }
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
        onChange={updateType}
        options={WORKSPACE_PANEL_TYPES.map((type) => ({ value: type, label: workspacePanelTypeLabel(type) }))}
        value={panel.type}
      />
      <label className="control full">
        Title
        <input aria-label="Panel title" value={panel.title} onChange={(event) => onUpdate({ title: event.target.value })} />
      </label>
      {panel.type === "scatter" ? (
        <>
          <CustomSelect
            className="full"
            disabled={!fieldSelectOptions.length}
            id="edit-panel-x-field"
            label="X field"
            onChange={(xField) => onUpdate({ xField })}
            options={fieldSelectOptions.length ? fieldSelectOptions : [{ value: "", label: "No numeric fields" }]}
            value={isValidField(panel.xField) ? panel.xField : fieldSelectOptions[0]?.value ?? ""}
          />
          <CustomSelect
            className="full"
            disabled={!fieldSelectOptions.length}
            id="edit-panel-y-field"
            label="Y field"
            onChange={(yField) => onUpdate({ yField })}
            options={fieldSelectOptions.length ? fieldSelectOptions : [{ value: "", label: "No numeric fields" }]}
            value={isValidField(panel.yField) ? panel.yField : fieldSelectOptions.find((option) => option.value !== panel.xField)?.value ?? fieldSelectOptions[0]?.value ?? ""}
          />
        </>
      ) : panel.type === "distribution" ? (
        <>
          <CustomSelect
            className="full"
            disabled={!fieldSelectOptions.length}
            id="edit-panel-value-field"
            label="Value field"
            onChange={(valueField) => onUpdate({ valueField })}
            options={fieldSelectOptions.length ? fieldSelectOptions : [{ value: "", label: "No numeric fields" }]}
            value={defaultValueField}
          />
          <CustomSelect
            className="full"
            id="edit-panel-group-field"
            label="Group field"
            onChange={(groupField) => onUpdate({ groupField })}
            options={categoricalSelectOptions}
            value={defaultGroupField ?? ""}
          />
          <CustomSelect
            className="full"
            id="edit-panel-replicate-field"
            label="Replicate field"
            onChange={(replicateField) => onUpdate({ replicateField })}
            options={categoricalSelectOptions}
            value={defaultReplicateField ?? ""}
          />
        </>
      ) : panel.type === "histogram_timeline" ? (
        <label className="control full">
          Object key
          <input
            aria-label="Histogram object key"
            value={panel.objectKey}
            onChange={(event) => onUpdate({ objectKey: event.target.value, metricKey: event.target.value })}
            placeholder="eval/score_distribution"
          />
        </label>
      ) : (
        <>
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
        </>
      )}
      {panel.type === "histogram_timeline" ? null : (
        <label className="control full">
          Max runs to show
          <input aria-label="Max runs to show" type="number" min="1" max="25" value={settings.maxRuns} onChange={(event) => onUpdate({ settings: { maxRuns: Number(event.target.value) } })} />
        </label>
      )}
      {panel.type === "line" ? (
        <>
          <label className="control full">
            Smoothing
            <input aria-label="Panel smoothing" type="range" min="0" max="90" step="10" value={settings.smoothing} onChange={(event) => onUpdate({ settings: { smoothing: Number(event.target.value) } })} />
          </label>
          <label className="toggle-control drawer-toggle">
            <span>Show group average</span>
            <input aria-label="Show group average" type="checkbox" checked={settings.groupAverage} onChange={(event) => onUpdate({ settings: { groupAverage: event.target.checked } })} />
          </label>
        </>
      ) : null}
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
