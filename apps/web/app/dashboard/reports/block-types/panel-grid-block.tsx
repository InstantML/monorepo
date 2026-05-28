"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";

import { ApiClient } from "../../../../src/api.js";
import {
  AddPanelModal,
} from "./add-panel-modal";
import {
  cloneInReportPanel,
  cloneInventoryPanel,
  defaultPanelWithMetric,
} from "./panel-factories";
import { PanelChartRenderer } from "./panel-chart-renderer";
import { RunSetTable } from "./run-set-table";
import type {
  BarPanelData,
  CodePanelData,
  ImagePanelData,
  InRunsetCandidate,
  LinePanelData,
  MarkdownPanelData,
  PanelData,
  PanelGridBlockData,
  PanelInventoryEntry,
  PanelType,
  ParallelCoordinatesPanelData,
  RunComparerPanelData,
  RunsetData,
  ScalarPanelData,
  ScatterPanelData,
} from "./types";
import {
  defaultPanel,
  SUPPORTED_PANEL_TYPES,
  SUPPORTED_SCALAR_AGGREGATIONS,
} from "./types";

type Props = {
  block: PanelGridBlockData;
  readOnly?: boolean;
  onChange?: (next: PanelGridBlockData) => void;
  /**
   * Sibling PanelGrids in the same report — surfaced in the modal's
   * "From this report" tab. Caller (ReportEditor) is responsible for
   * filtering out the host block by index.
   */
  siblingPanelGrids?: { blockIndex: number; label: string; block: PanelGridBlockData }[];
};

const PANEL_TYPE_LABEL: Record<PanelType, string> = {
  line: "Line",
  bar: "Bar",
  scalar: "Scalar",
  scatter: "Scatter",
  parallel_coordinates: "Parallel coords",
  run_comparer: "Run comparer",
  markdown_panel: "Markdown",
  code_panel: "Code",
  image_panel: "Image",
};

/**
 * PanelGrid editor — the load-bearing live-data block. Per the v1 spec,
 * Runsets accept a list of projects (not a single project) so reports can
 * span experiments organized across multiple projects.
 *
 * Renders four panel types inline (line / bar / scalar / scatter) using the
 * same metrics-series fetch path as the metrics tab. Charts re-fetch live
 * whenever the runset or panel config changes.
 */
export function PanelGridBlock({ block, readOnly = false, onChange, siblingPanelGrids }: Props) {
  const api = useMemo(() => new ApiClient(), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const projectOptions = useProjectOptions(api);

  const updateRunset = useCallback(
    (index: number, patch: Partial<RunsetData>) => {
      if (!onChange) return;
      const runsets = block.runsets.map((runset, current) =>
        current === index ? { ...runset, ...patch } : runset,
      );
      onChange({ ...block, runsets });
    },
    [block, onChange],
  );
  const addRunset = useCallback(() => {
    if (!onChange) return;
    onChange({
      ...block,
      runsets: [
        ...block.runsets,
        { name: `runset-${block.runsets.length + 1}`, projects: [], pinned_run_ids: [] },
      ],
    });
  }, [block, onChange]);
  const removeRunset = useCallback(
    (index: number) => {
      if (!onChange) return;
      onChange({
        ...block,
        runsets: block.runsets.filter((_, current) => current !== index),
      });
    },
    [block, onChange],
  );
  const addPanel = useCallback(
    (type: PanelType, metricKey?: string) => {
      if (!onChange) return;
      onChange({
        ...block,
        panels: [...block.panels, defaultPanelWithMetric(type, metricKey)],
      });
      setPaletteOpen(false);
    },
    [block, onChange],
  );
  const addFromCandidate = useCallback(
    (candidate: InRunsetCandidate) => {
      if (!onChange) return;
      const cloned = cloneInReportPanel(candidate);
      onChange({ ...block, panels: [...block.panels, cloned] });
      setPaletteOpen(false);
    },
    [block, onChange],
  );
  const addInventoryPanel = useCallback(
    (entry: PanelInventoryEntry) => {
      if (!onChange) return;
      const cloned = cloneInventoryPanel(entry);
      onChange({ ...block, panels: [...block.panels, cloned] });
      setPaletteOpen(false);
    },
    [block, onChange],
  );
  const updatePanel = useCallback(
    (index: number, patch: Partial<PanelData>) => {
      if (!onChange) return;
      const panels = block.panels.map((panel, current) =>
        current === index ? ({ ...panel, ...patch } as PanelData) : panel,
      );
      onChange({ ...block, panels });
    },
    [block, onChange],
  );
  const replacePanelType = useCallback(
    (index: number, type: PanelType) => {
      if (!onChange) return;
      const previous = block.panels[index];
      const next = defaultPanel(type);
      // Preserve runset_index across type swaps so charts stay aimed at the
      // same runset; metric keys reset because shapes differ across types.
      // Static panels (markdown/code/image) don't carry a runset_index — skip.
      if ("runset_index" in next && previous && "runset_index" in previous) {
        (next as { runset_index: number }).runset_index = previous.runset_index;
      }
      const panels = block.panels.map((panel, current) => (current === index ? next : panel));
      onChange({ ...block, panels });
    },
    [block, onChange],
  );
  const removePanel = useCallback(
    (index: number) => {
      if (!onChange) return;
      onChange({
        ...block,
        panels: block.panels.filter((_, current) => current !== index),
      });
    },
    [block, onChange],
  );
  return (
    <div className="report-block report-block--panel-grid">
      <div className="report-block__section">
        <div className="report-block__section-head">
          <h4>Runsets</h4>
          {!readOnly ? (
            <button
              type="button"
              className="report-block__action"
              onClick={addRunset}
              aria-label="Add runset"
            >
              + Runset
            </button>
          ) : null}
        </div>
        {block.runsets.length === 0 ? (
          <p className="report-block__empty">No runsets yet.</p>
        ) : (
          <ul className="report-block__list">
            {block.runsets.map((runset, index) => (
              <RunsetEditor
                key={index}
                runset={runset}
                index={index}
                readOnly={readOnly}
                projectOptions={projectOptions}
                onChange={(patch) => updateRunset(index, patch)}
                onRemove={() => removeRunset(index)}
              />
            ))}
          </ul>
        )}
      </div>
      <div className="report-block__section">
        <div className="report-block__section-head">
          <h4>Panels</h4>
          {!readOnly ? (
            <button
              type="button"
              className="report-block__action"
              onClick={() => setPaletteOpen(true)}
              aria-label="Add panel"
            >
              + Panel
            </button>
          ) : null}
        </div>
        {block.panels.length === 0 ? (
          <p className="report-block__empty">No panels yet.</p>
        ) : (
          <ul className="report-block__list">
            {block.panels.map((panel, index) => (
              <li className="report-block__panel" key={index}>
                <PanelEditor
                  panel={panel}
                  panelIndex={index}
                  readOnly={readOnly}
                  runsetCount={block.runsets.length}
                  onChange={(patch) => updatePanel(index, patch)}
                  onChangeType={(type) => replacePanelType(index, type)}
                  onRemove={() => removePanel(index)}
                />
                <PanelChartRenderer
                  panel={panel}
                  runset={
                    "runset_index" in panel ? block.runsets[panel.runset_index] : undefined
                  }
                  api={api}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {block.runsets.length > 0 ? (
        <div className="report-block__section">
          <div className="report-block__section-head">
            <h4>Runs</h4>
          </div>
          {block.runsets.map((_, index) => (
            <div key={`table-${index}`} className="report-block__runset-table">
              {block.runsets.length > 1 ? (
                <div className="report-block__runset-table-head">
                  Runset {index + 1}: {block.runsets[index]?.name}
                </div>
              ) : null}
              <RunSetTable
                block={block}
                runsetIndex={index}
                readOnly={readOnly}
                api={api}
                onChange={onChange}
              />
            </div>
          ))}
        </div>
      ) : null}
      <AddPanelModal
        open={paletteOpen}
        api={api}
        hostRunsets={block.runsets}
        inReportCandidates={siblingPanelGrids}
        onClose={() => setPaletteOpen(false)}
        onPickType={(type, metricKey) => addPanel(type, metricKey)}
        onPickFromInventory={(entry) => addInventoryPanel(entry)}
        onPickFromCandidate={(candidate) => addFromCandidate(candidate)}
      />
    </div>
  );
}

function useProjectOptions(api: ApiClient): string[] {
  const [projects, setProjects] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await api.get("/projects");
        const list = Array.isArray(payload?.projects) ? payload.projects : [];
        const names = list
          .map((project: { name?: string }) => project?.name)
          .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
        if (!cancelled) setProjects(names);
      } catch {
        // Project typeahead is best-effort — fall back to free text input.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);
  return projects;
}

function RunsetEditor({
  runset,
  index,
  readOnly,
  projectOptions,
  onChange,
  onRemove,
}: {
  runset: RunsetData;
  index: number;
  readOnly: boolean;
  projectOptions: string[];
  onChange: (patch: Partial<RunsetData>) => void;
  onRemove: () => void;
}) {
  const [pinnedDraft, setPinnedDraft] = useState("");
  const projectListId = `runset-${index}-projects`;
  const pinnedRunIds = runset.pinned_run_ids ?? [];

  const addPinnedRun = () => {
    const trimmed = pinnedDraft.trim();
    if (!trimmed) return;
    if (pinnedRunIds.includes(trimmed)) {
      setPinnedDraft("");
      return;
    }
    onChange({ pinned_run_ids: [...pinnedRunIds, trimmed] });
    setPinnedDraft("");
  };
  const removePinnedRun = (target: string) => {
    onChange({ pinned_run_ids: pinnedRunIds.filter((id) => id !== target) });
  };

  return (
    <li className="report-block__runset">
      <div className="report-block__row">
        <input
          className="report-block__input"
          value={runset.name}
          placeholder="Runset name"
          onChange={(event) => onChange({ name: event.target.value })}
          aria-label={`Runset ${index + 1} name`}
          readOnly={readOnly}
        />
        {!readOnly ? (
          <button
            type="button"
            className="report-block__icon-action report-block__icon-action--danger"
            onClick={onRemove}
            aria-label={`Remove runset ${index + 1}`}
            title={`Remove runset ${index + 1}`}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <span className="report-block__label">
        Projects (comma-separated, supports cross-project)
      </span>
      <input
        className="report-block__input"
        value={runset.projects.join(", ")}
        placeholder="proj-a, proj-b"
        list={projectOptions.length ? projectListId : undefined}
        onChange={(event) =>
          onChange({
            projects: event.target.value
              .split(",")
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          })
        }
        aria-label={`Runset ${index + 1} projects`}
        readOnly={readOnly}
      />
      {projectOptions.length ? (
        <datalist id={projectListId}>
          {projectOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </datalist>
      ) : null}
      <span className="report-block__label">Pinned run IDs (UUID or project/name)</span>
      <ul className="report-block__pinned-list">
        {pinnedRunIds.map((id) => (
          <li key={id} className="report-block__pinned-chip">
            <code>{id}</code>
            {!readOnly ? (
              <button
                type="button"
                className="report-block__pinned-remove"
                onClick={() => removePinnedRun(id)}
                aria-label={`Unpin run ${id}`}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
        {pinnedRunIds.length === 0 ? (
          <li className="report-block__hint">No runs pinned. Pinned runs are unioned with the project query.</li>
        ) : null}
      </ul>
      {!readOnly ? (
        <div className="report-block__row">
          <input
            className="report-block__input"
            value={pinnedDraft}
            placeholder="run-uuid or project/run-name"
            onChange={(event) => setPinnedDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addPinnedRun();
              }
            }}
            aria-label={`Runset ${index + 1} pinned run input`}
          />
          <button
            type="button"
            className="report-block__action"
            onClick={addPinnedRun}
            aria-label={`Add pinned run to runset ${index + 1}`}
          >
            + Run
          </button>
        </div>
      ) : null}
    </li>
  );
}

function PanelEditor({
  panel,
  panelIndex,
  readOnly,
  runsetCount,
  onChange,
  onChangeType,
  onRemove,
}: {
  panel: PanelData;
  panelIndex: number;
  readOnly: boolean;
  runsetCount: number;
  onChange: (patch: Partial<PanelData>) => void;
  onChangeType: (type: PanelType) => void;
  onRemove: () => void;
}) {
  return (
    <div className="report-block__panel-editor">
      {!readOnly ? (
        <button
          type="button"
          className="report-block__icon-action report-block__icon-action--danger report-block__panel-delete"
          onClick={onRemove}
          aria-label={`Remove panel ${panelIndex + 1}`}
          title={`Remove panel ${panelIndex + 1}`}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      ) : null}
      <div className="report-block__row">
        <span className="report-block__label">Panel type</span>
        <select
          className="report-block__select"
          value={panel.type}
          onChange={(event) => onChangeType(event.target.value as PanelType)}
          disabled={readOnly}
          aria-label={`Panel ${panelIndex + 1} type`}
        >
          {SUPPORTED_PANEL_TYPES.map((type) => (
            <option key={type} value={type}>
              {PANEL_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
      </div>
      {"runset_index" in panel ? (
        <div className="report-block__row">
          <span className="report-block__label">Runset</span>
          <select
            className="report-block__select"
            value={panel.runset_index}
            onChange={(event) =>
              onChange({ runset_index: Number(event.target.value) } as Partial<PanelData>)
            }
            disabled={readOnly}
            aria-label={`Panel ${panelIndex + 1} runset`}
          >
            {Array.from({ length: Math.max(1, runsetCount) }, (_, index) => (
              <option key={index} value={index}>
                Runset {index + 1}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <PanelKindFields panel={panel} readOnly={readOnly} onChange={onChange} />
    </div>
  );
}

function PanelKindFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: PanelData;
  readOnly: boolean;
  onChange: (patch: Partial<PanelData>) => void;
}) {
  switch (panel.type) {
    case "line":
      return <LinePanelFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />;
    case "bar":
      return <BarPanelFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />;
    case "scalar":
      return <ScalarPanelFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />;
    case "scatter":
      return <ScatterPanelFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />;
    case "parallel_coordinates":
      return (
        <ParallelCoordsFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />
      );
    case "run_comparer":
      return (
        <RunComparerFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />
      );
    case "markdown_panel":
      return (
        <MarkdownPanelFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />
      );
    case "code_panel":
      return (
        <CodePanelFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />
      );
    case "image_panel":
      return (
        <ImagePanelFields panel={panel} readOnly={readOnly} onChange={(patch) => onChange(patch)} />
      );
  }
}

function ParallelCoordsFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: ParallelCoordinatesPanelData;
  readOnly: boolean;
  onChange: (patch: Partial<ParallelCoordinatesPanelData>) => void;
}) {
  const [draftKind, setDraftKind] = useState<"metric_key" | "config_key">("metric_key");
  const [draftValue, setDraftValue] = useState("");
  const addDimension = () => {
    const value = draftValue.trim();
    if (!value) return;
    const next = [...panel.dimensions, { [draftKind]: value }];
    onChange({ dimensions: next });
    setDraftValue("");
  };
  const removeDimension = (target: number) => {
    onChange({ dimensions: panel.dimensions.filter((_, idx) => idx !== target) });
  };
  return (
    <div className="report-block__panel-fields">
      <span className="report-block__label">Dimensions</span>
      <ul className="report-block__pinned-list">
        {panel.dimensions.map((dim, index) => {
          const label = dim.metric_key
            ? `metric: ${dim.metric_key}`
            : `config: ${dim.config_key ?? ""}`;
          return (
            <li key={`${label}-${index}`} className="report-block__pinned-chip">
              <code>{label}</code>
              {!readOnly ? (
                <button
                  type="button"
                  className="report-block__pinned-remove"
                  onClick={() => removeDimension(index)}
                  aria-label={`Remove dimension ${label}`}
                >
                  ×
                </button>
              ) : null}
            </li>
          );
        })}
        {panel.dimensions.length === 0 ? (
          <li className="report-block__hint">Add at least one dimension to render.</li>
        ) : null}
      </ul>
      {!readOnly ? (
        <div className="report-block__row">
          <select
            className="report-block__select"
            value={draftKind}
            onChange={(event) => setDraftKind(event.target.value as "metric_key" | "config_key")}
            aria-label="Dimension kind"
          >
            <option value="metric_key">Metric</option>
            <option value="config_key">Config</option>
          </select>
          <input
            className="report-block__input"
            value={draftValue}
            placeholder={draftKind === "metric_key" ? "eval/return_mean" : "lr"}
            onChange={(event) => setDraftValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addDimension();
              }
            }}
            aria-label="Dimension value"
          />
          <button type="button" className="report-block__action" onClick={addDimension}>
            + Dim
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RunComparerFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: RunComparerPanelData;
  readOnly: boolean;
  onChange: (patch: Partial<RunComparerPanelData>) => void;
}) {
  const [runDraft, setRunDraft] = useState("");
  const [fieldDraft, setFieldDraft] = useState("");
  return (
    <div className="report-block__panel-fields">
      <span className="report-block__label">Run IDs to compare</span>
      <ul className="report-block__pinned-list">
        {panel.run_ids.map((id) => (
          <li key={id} className="report-block__pinned-chip">
            <code>{id}</code>
            {!readOnly ? (
              <button
                type="button"
                className="report-block__pinned-remove"
                onClick={() =>
                  onChange({ run_ids: panel.run_ids.filter((entry) => entry !== id) })
                }
                aria-label={`Remove run ${id}`}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <div className="report-block__row">
          <input
            className="report-block__input"
            value={runDraft}
            placeholder="run-uuid"
            onChange={(event) => setRunDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const value = runDraft.trim();
                if (value && !panel.run_ids.includes(value)) {
                  onChange({ run_ids: [...panel.run_ids, value] });
                  setRunDraft("");
                }
              }
            }}
            aria-label="Run id"
          />
          <button
            type="button"
            className="report-block__action"
            onClick={() => {
              const value = runDraft.trim();
              if (value && !panel.run_ids.includes(value)) {
                onChange({ run_ids: [...panel.run_ids, value] });
                setRunDraft("");
              }
            }}
          >
            + Run
          </button>
        </div>
      ) : null}
      <span className="report-block__label">Fields (e.g. config.lr, summary.val_acc)</span>
      <ul className="report-block__pinned-list">
        {panel.fields.map((field) => (
          <li key={field} className="report-block__pinned-chip">
            <code>{field}</code>
            {!readOnly ? (
              <button
                type="button"
                className="report-block__pinned-remove"
                onClick={() =>
                  onChange({ fields: panel.fields.filter((entry) => entry !== field) })
                }
                aria-label={`Remove field ${field}`}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!readOnly ? (
        <div className="report-block__row">
          <input
            className="report-block__input"
            value={fieldDraft}
            placeholder="config.lr"
            onChange={(event) => setFieldDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const value = fieldDraft.trim();
                if (value && !panel.fields.includes(value)) {
                  onChange({ fields: [...panel.fields, value] });
                  setFieldDraft("");
                }
              }
            }}
            aria-label="Field path"
          />
          <button
            type="button"
            className="report-block__action"
            onClick={() => {
              const value = fieldDraft.trim();
              if (value && !panel.fields.includes(value)) {
                onChange({ fields: [...panel.fields, value] });
                setFieldDraft("");
              }
            }}
          >
            + Field
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MarkdownPanelFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: MarkdownPanelData;
  readOnly: boolean;
  onChange: (patch: Partial<MarkdownPanelData>) => void;
}) {
  return (
    <div className="report-block__panel-fields">
      <span className="report-block__label">Markdown</span>
      <textarea
        className="report-block__textarea report-block__textarea--mono"
        rows={Math.min(12, Math.max(3, panel.text.split("\n").length + 1))}
        value={panel.text}
        placeholder="# Section title"
        onChange={(event) => onChange({ text: event.target.value })}
        readOnly={readOnly}
        aria-label="Markdown panel text"
      />
    </div>
  );
}

function CodePanelFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: CodePanelData;
  readOnly: boolean;
  onChange: (patch: Partial<CodePanelData>) => void;
}) {
  return (
    <div className="report-block__panel-fields">
      <div className="report-block__row">
        <span className="report-block__label">Language</span>
        <input
          className="report-block__input"
          value={panel.language}
          placeholder="python"
          onChange={(event) => onChange({ language: event.target.value })}
          readOnly={readOnly}
          aria-label="Code panel language"
        />
      </div>
      <span className="report-block__label">Code</span>
      <textarea
        className="report-block__textarea report-block__textarea--mono"
        rows={Math.min(15, Math.max(4, panel.code.split("\n").length + 1))}
        value={panel.code}
        placeholder="// code"
        onChange={(event) => onChange({ code: event.target.value })}
        readOnly={readOnly}
        aria-label="Code panel body"
        spellCheck={false}
      />
    </div>
  );
}

function ImagePanelFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: ImagePanelData;
  readOnly: boolean;
  onChange: (patch: Partial<ImagePanelData>) => void;
}) {
  return (
    <div className="report-block__panel-fields">
      <div className="report-block__row">
        <span className="report-block__label">URL</span>
        <input
          className="report-block__input"
          value={panel.url}
          placeholder="https://example.com/figure.png"
          onChange={(event) => onChange({ url: event.target.value })}
          readOnly={readOnly}
          aria-label="Image panel url"
        />
      </div>
      <div className="report-block__row">
        <span className="report-block__label">Caption</span>
        <input
          className="report-block__input"
          value={panel.caption ?? ""}
          placeholder="Optional caption"
          onChange={(event) => onChange({ caption: event.target.value || null })}
          readOnly={readOnly}
          aria-label="Image panel caption"
        />
      </div>
    </div>
  );
}

function MetricInput({
  label,
  value,
  readOnly,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="report-block__row">
      <span className="report-block__label">{label}</span>
      <input
        className="report-block__input"
        value={value}
        placeholder="loss"
        onChange={(event) => onChange(event.target.value)}
        readOnly={readOnly}
        aria-label={ariaLabel}
      />
    </div>
  );
}

function LinePanelFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: LinePanelData;
  readOnly: boolean;
  onChange: (patch: Partial<LinePanelData>) => void;
}) {
  return (
    <>
      <MetricInput
        label="Metric key"
        value={panel.metric_key}
        readOnly={readOnly}
        onChange={(value) => onChange({ metric_key: value })}
        ariaLabel="Line panel metric key"
      />
      <div className="report-block__row">
        <span className="report-block__label">Smoothing</span>
        <input
          className="report-block__input report-block__input--narrow"
          type="number"
          min={0}
          max={99}
          value={panel.smoothing ?? 0}
          onChange={(event) => onChange({ smoothing: Number(event.target.value) })}
          readOnly={readOnly}
          aria-label="Line panel smoothing"
        />
      </div>
    </>
  );
}

function BarPanelFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: BarPanelData;
  readOnly: boolean;
  onChange: (patch: Partial<BarPanelData>) => void;
}) {
  return (
    <>
      <MetricInput
        label="Metric key"
        value={panel.metric_key}
        readOnly={readOnly}
        onChange={(value) => onChange({ metric_key: value })}
        ariaLabel="Bar panel metric key"
      />
      <div className="report-block__row">
        <span className="report-block__label">Group by (optional)</span>
        <input
          className="report-block__input"
          value={panel.group_by ?? ""}
          placeholder="config field or 'project'"
          onChange={(event) => onChange({ group_by: event.target.value || null })}
          readOnly={readOnly}
          aria-label="Bar panel group_by"
        />
      </div>
    </>
  );
}

function ScalarPanelFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: ScalarPanelData;
  readOnly: boolean;
  onChange: (patch: Partial<ScalarPanelData>) => void;
}) {
  return (
    <>
      <MetricInput
        label="Metric key"
        value={panel.metric_key}
        readOnly={readOnly}
        onChange={(value) => onChange({ metric_key: value })}
        ariaLabel="Scalar panel metric key"
      />
      <div className="report-block__row">
        <span className="report-block__label">Aggregation</span>
        <select
          className="report-block__select"
          value={panel.agg}
          onChange={(event) => onChange({ agg: event.target.value as ScalarPanelData["agg"] })}
          disabled={readOnly}
          aria-label="Scalar panel aggregation"
        >
          {SUPPORTED_SCALAR_AGGREGATIONS.map((agg) => (
            <option key={agg} value={agg}>
              {agg}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

function ScatterPanelFields({
  panel,
  readOnly,
  onChange,
}: {
  panel: ScatterPanelData;
  readOnly: boolean;
  onChange: (patch: Partial<ScatterPanelData>) => void;
}) {
  return (
    <>
      <MetricInput
        label="X metric"
        value={panel.x_metric}
        readOnly={readOnly}
        onChange={(value) => onChange({ x_metric: value })}
        ariaLabel="Scatter panel x metric"
      />
      <MetricInput
        label="Y metric"
        value={panel.y_metric}
        readOnly={readOnly}
        onChange={(value) => onChange({ y_metric: value })}
        ariaLabel="Scatter panel y metric"
      />
      <div className="report-block__row">
        <span className="report-block__label">Color by (optional)</span>
        <input
          className="report-block__input"
          value={panel.color_by ?? ""}
          placeholder="config field or 'project'"
          onChange={(event) => onChange({ color_by: event.target.value || null })}
          readOnly={readOnly}
          aria-label="Scatter panel color_by"
        />
      </div>
    </>
  );
}
