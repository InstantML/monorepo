"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ApiClient } from "../../../../src/api.js";
import type {
  PanelData,
  PanelGridBlockData,
  PanelInventoryEntry,
  PanelPickerEntry,
  PanelType,
  RunsetData,
  InRunsetCandidate,
} from "./types";
import { PANEL_PICKER_CATALOG } from "./types";

type Tab = "panels" | "from-other-reports" | "from-this-report";

type Props = {
  open: boolean;
  api?: ApiClient;
  /**
   * Runsets attached to the host PanelGrid. Used to drive the metric-key
   * combobox — we hit /runs?project=… for the first project of each runset
   * and aggregate every `latest_metrics` key we see.
   */
  hostRunsets?: RunsetData[];
  /**
   * Optional list of in-report sibling PanelGrids (excluding the host).
   * Each one becomes a row in the "From other PanelGrid in this report"
   * tab.
   */
  inReportCandidates?: { blockIndex: number; label: string; block: PanelGridBlockData }[];
  onClose: () => void;
  /** User selected a new panel type + (optionally) a metric key from the picker. */
  onPickType: (type: PanelType, metricKey?: string) => void;
  /** User cloned a panel from the org-wide inventory. */
  onPickFromInventory: (entry: PanelInventoryEntry) => void;
  /** User cloned a panel from a sibling PanelGrid in this report. */
  onPickFromCandidate?: (candidate: InRunsetCandidate) => void;
};

/**
 * Add-panel picker with three tabs:
 *
 *   1. **New panel** — type picker + metric-key combobox (typeahead over
 *      the host runset's metric keys, populated by listing one run per
 *      project and unioning `latest_metrics`).
 *   2. **From other reports** — org-wide panel inventory (`/api/reports/panels`).
 *   3. **From other PanelGrid in this report** — quick clone from a
 *      sibling block. Surfaced only when there's at least one other grid.
 */
export function AddPanelModal({
  open,
  api,
  hostRunsets,
  inReportCandidates,
  onClose,
  onPickType,
  onPickFromInventory,
  onPickFromCandidate,
}: Props) {
  const client = useMemo(() => api ?? new ApiClient(), [api]);
  const [tab, setTab] = useState<Tab>("panels");
  const [inventory, setInventory] = useState<PanelInventoryEntry[] | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [metricKeys, setMetricKeys] = useState<string[]>([]);
  const [metricKey, setMetricKey] = useState("");
  const [pickedType, setPickedType] = useState<PanelType | null>(null);
  const comboRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab("panels");
    setPickedType(null);
    setMetricKey("");
  }, [open]);

  // Auto-scroll the metric-key combobox into view when a type is picked.
  // Otherwise users have to scroll a long modal body to find it.
  useEffect(() => {
    if (!pickedType) return;
    const handle = setTimeout(() => {
      comboRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    return () => clearTimeout(handle);
  }, [pickedType]);

  // Load the org panel inventory only when its tab becomes visible.
  useEffect(() => {
    if (!open || tab !== "from-other-reports") return;
    if (inventory !== null) return;
    const controller = new AbortController();
    (async () => {
      try {
        const payload = await client.get("/api/reports/panels", { signal: controller.signal });
        const list = Array.isArray(payload?.panels) ? (payload.panels as PanelInventoryEntry[]) : [];
        setInventory(list);
      } catch (error) {
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        setInventoryError(
          error instanceof Error ? error.message : "Failed to load org panel inventory",
        );
      }
    })();
    return () => controller.abort();
  }, [open, tab, client, inventory]);

  // Resolve metric-keys for the host runsets. Best-effort — we hit one run
  // per project and union `latest_metrics`. Cancels on close so a stale
  // request can't update state after unmount.
  useEffect(() => {
    if (!open || !hostRunsets || hostRunsets.length === 0) return;
    const controller = new AbortController();
    const projects = new Set<string>();
    for (const runset of hostRunsets) {
      for (const project of runset.projects ?? []) {
        if (project) projects.add(project);
      }
    }
    if (projects.size === 0) return;
    (async () => {
      const keys = new Set<string>();
      for (const project of Array.from(projects).slice(0, 6)) {
        if (controller.signal.aborted) return;
        try {
          const params = new URLSearchParams({ project, limit: "20" });
          const payload = await client.get(`/runs?${params.toString()}`, {
            signal: controller.signal,
          });
          const runs = Array.isArray(payload?.runs) ? payload.runs : [];
          for (const run of runs) {
            const latest = run?.latest_metrics;
            if (latest && typeof latest === "object") {
              for (const key of Object.keys(latest)) keys.add(key);
            }
          }
        } catch {
          // Best-effort — if the project doesn't exist or auth fails the
          // combobox just falls back to free text input.
        }
      }
      if (!controller.signal.aborted) setMetricKeys(Array.from(keys).sort());
    })();
    return () => controller.abort();
  }, [open, hostRunsets, client]);

  // Dismiss on Esc.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const hasInReport = (inReportCandidates ?? []).length > 0;
  const wantsMetricKey =
    pickedType !== null &&
    (pickedType === "line" ||
      pickedType === "bar" ||
      pickedType === "scalar" ||
      pickedType === "scatter");

  return (
    <div className="add-panel-modal-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="add-panel-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="add-panel-modal__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "panels"}
            className={`add-panel-modal__tab${tab === "panels" ? " add-panel-modal__tab--active" : ""}`}
            onClick={() => setTab("panels")}
          >
            New panel
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "from-other-reports"}
            className={`add-panel-modal__tab${tab === "from-other-reports" ? " add-panel-modal__tab--active" : ""}`}
            onClick={() => setTab("from-other-reports")}
          >
            From other reports
          </button>
          {hasInReport ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "from-this-report"}
              className={`add-panel-modal__tab${tab === "from-this-report" ? " add-panel-modal__tab--active" : ""}`}
              onClick={() => setTab("from-this-report")}
            >
              From this report
            </button>
          ) : null}
          <button
            type="button"
            className="add-panel-modal__close"
            onClick={onClose}
            aria-label="Close add panel"
          >
            ×
          </button>
        </div>
        <div className="add-panel-modal__body">
          {tab === "panels" ? (
            <PanelsTab
              selectedType={pickedType}
              onPick={(entry) => {
                if (!entry.implemented) return;
                setPickedType(entry.type as PanelType);
              }}
            />
          ) : null}
          {tab === "panels" && pickedType ? (
            <div ref={comboRef}>
              <MetricKeyCombobox
                metricKeys={metricKeys}
                value={metricKey}
                optional={!wantsMetricKey}
                onChange={setMetricKey}
              />
            </div>
          ) : null}
          {tab === "from-other-reports" ? (
            <FromReportsTab
              entries={inventory}
              error={inventoryError}
              onPick={(entry) => onPickFromInventory(entry)}
            />
          ) : null}
          {tab === "from-this-report" ? (
            <FromInReportTab
              candidates={inReportCandidates ?? []}
              onPick={(entry) => onPickFromCandidate?.(entry)}
            />
          ) : null}
        </div>
        {tab === "panels" ? (
          <div className="add-panel-modal__footer">
            <span className="add-panel-modal__footer-hint">
              {pickedType
                ? wantsMetricKey
                  ? "Pick a metric key (or leave blank to fill later) and click Add."
                  : "Click Add to insert this panel."
                : "Choose a panel type to continue."}
            </span>
            <button
              type="button"
              className="report-block__action"
              disabled={!pickedType}
              onClick={() => {
                if (!pickedType) return;
                onPickType(pickedType, metricKey.trim() || undefined);
              }}
            >
              Add panel
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PanelsTab({
  selectedType,
  onPick,
}: {
  selectedType: PanelType | null;
  onPick: (entry: PanelPickerEntry) => void;
}) {
  const grouped = useMemo(() => {
    const byCategory = new Map<string, PanelPickerEntry[]>();
    for (const entry of PANEL_PICKER_CATALOG) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }
    return byCategory;
  }, []);
  return (
    <div className="add-panel-modal__grid">
      {Array.from(grouped.entries()).map(([category, entries]) => (
        <div key={category} className="add-panel-modal__category">
          <h4 className="add-panel-modal__category-label">{categoryLabel(category)}</h4>
          <div className="add-panel-modal__cells">
            {entries.map((entry) => {
              const active = selectedType === entry.type;
              return (
                <button
                  key={entry.type}
                  type="button"
                  className={`add-panel-modal__cell${active ? " add-panel-modal__cell--active" : ""}`}
                  onClick={() => onPick(entry)}
                  title={entry.label}
                  aria-label={`Pick ${entry.label} panel`}
                >
                  <span className="add-panel-modal__cell-label">{entry.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Type-ahead combobox over the host runset's metric keys. Falls back to a
 * free-text input when no keys are available (e.g. before a runset has a
 * project assigned).
 */
function MetricKeyCombobox({
  metricKeys,
  value,
  optional,
  onChange,
}: {
  metricKeys: string[];
  value: string;
  optional: boolean;
  onChange: (next: string) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const filtered = useMemo(() => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return metricKeys.slice(0, 20);
    return metricKeys
      .filter((key) => key.toLowerCase().includes(trimmed))
      .slice(0, 20);
  }, [value, metricKeys]);

  useEffect(() => {
    setActiveIndex(0);
  }, [value]);

  return (
    <div className="add-panel-modal__combo">
      <span className="add-panel-modal__combo-label">
        Metric key{optional ? " (optional)" : ""}
      </span>
      <div className="add-panel-modal__combo-shell">
        <input
          aria-label={optional ? "Metric key optional" : "Metric key"}
          ref={inputRef}
          className="add-panel-modal__combo-input"
          type="text"
          value={value}
          placeholder={
            metricKeys.length === 0
              ? "e.g. eval/return_mean"
              : `${metricKeys.length} keys available — type to filter`
          }
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 100)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) =>
                filtered.length === 0 ? 0 : (current + 1) % filtered.length,
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) =>
                filtered.length === 0
                  ? 0
                  : (current - 1 + filtered.length) % filtered.length,
              );
            } else if (event.key === "Enter") {
              if (open && filtered[activeIndex]) {
                event.preventDefault();
                onChange(filtered[activeIndex]);
                setOpen(false);
              }
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        {open && filtered.length > 0 ? (
          <div className="add-panel-modal__combo-list" role="listbox">
            {filtered.map((key, index) => {
              const active = index === activeIndex;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`add-panel-modal__combo-row${active ? " add-panel-modal__combo-row--active" : ""}`}
                  key={key}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onChange(key);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  {key}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FromReportsTab({
  entries,
  error,
  onPick,
}: {
  entries: PanelInventoryEntry[] | null;
  error: string | null;
  onPick: (entry: PanelInventoryEntry) => void;
}) {
  if (error) {
    return (
      <div className="add-panel-modal__empty add-panel-modal__empty--error">{error}</div>
    );
  }
  if (entries === null) {
    return <div className="add-panel-modal__empty">Loading panels…</div>;
  }
  if (!entries.length) {
    return (
      <div className="add-panel-modal__empty">
        No panels saved in other reports yet. Add charts elsewhere to populate this list.
      </div>
    );
  }
  return (
    <ul className="add-panel-modal__inventory">
      {entries.map((entry, index) => (
        <li key={`${entry.report_id}-${entry.panel_index}-${index}`}>
          <button
            type="button"
            className="add-panel-modal__inventory-row"
            onClick={() => onPick(entry)}
          >
            <span className="add-panel-modal__inventory-title">{entry.report_title}</span>
            <span className="add-panel-modal__inventory-meta">
              panel #{entry.panel_index + 1} · {entry.panel_spec?.type ?? "panel"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function FromInReportTab({
  candidates,
  onPick,
}: {
  candidates: { blockIndex: number; label: string; block: PanelGridBlockData }[];
  onPick: (candidate: InRunsetCandidate) => void;
}) {
  if (candidates.length === 0) {
    return (
      <div className="add-panel-modal__empty">
        No sibling PanelGrids in this report yet.
      </div>
    );
  }
  return (
    <ul className="add-panel-modal__inventory">
      {candidates.flatMap((candidate) =>
        candidate.block.panels.map((panel, panelIndex) => (
          <li key={`${candidate.blockIndex}-${panelIndex}`}>
            <button
              type="button"
              className="add-panel-modal__inventory-row"
              onClick={() =>
                onPick({
                  blockIndex: candidate.blockIndex,
                  label: candidate.label,
                  panelIndex,
                  panel,
                })
              }
            >
              <span className="add-panel-modal__inventory-title">{candidate.label}</span>
              <span className="add-panel-modal__inventory-meta">
                panel #{panelIndex + 1} · {panel.type}
              </span>
            </button>
          </li>
        )),
      )}
    </ul>
  );
}

function categoryLabel(category: string): string {
  switch (category) {
    case "charts":
      return "Charts";
    case "media":
      return "Media";
    case "data":
      return "Data";
    default:
      return category;
  }
}
