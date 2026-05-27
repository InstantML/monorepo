"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiClient } from "../../../../src/api.js";
import type {
  PanelData,
  PanelInventoryEntry,
  PanelPickerEntry,
  PanelType,
} from "./types";
import { defaultPanel, PANEL_PICKER_CATALOG } from "./types";

type Tab = "panels" | "from-other-reports";

type Props = {
  open: boolean;
  api?: ApiClient;
  onClose: () => void;
  onPickType: (type: PanelType) => void;
  onPickFromInventory: (entry: PanelInventoryEntry) => void;
};

/**
 * Two-tab "Add panel" picker — replaces the v1.1 inline palette. The "Panels"
 * tab shows every supported panel type (with v1.3 cells disabled so the
 * roadmap is visible); the "From other reports" tab pulls the org's panel
 * inventory from `/api/reports/panels` so a panel from a prior report can
 * be cloned in.
 */
export function AddPanelModal({ open, api, onClose, onPickType, onPickFromInventory }: Props) {
  const client = useMemo(() => api ?? new ApiClient(), [api]);
  const [tab, setTab] = useState<Tab>("panels");
  const [inventory, setInventory] = useState<PanelInventoryEntry[] | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab("panels");
  }, [open]);

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

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="add-panel-modal-overlay" onMouseDown={onClose}>
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
            Panels
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
              onPick={(entry) => {
                if (!entry.implemented) return;
                onPickType(entry.type as PanelType);
              }}
            />
          ) : (
            <FromReportsTab
              entries={inventory}
              error={inventoryError}
              onPick={(entry) => onPickFromInventory(entry)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PanelsTab({ onPick }: { onPick: (entry: PanelPickerEntry) => void }) {
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
            {entries.map((entry) => (
              <button
                key={entry.type}
                type="button"
                className={`add-panel-modal__cell${entry.implemented ? "" : " add-panel-modal__cell--disabled"}`}
                onClick={() => onPick(entry)}
                disabled={!entry.implemented}
                title={entry.implemented ? entry.label : `${entry.label} — coming in v1.3`}
                aria-label={entry.implemented ? `Add ${entry.label} panel` : `${entry.label} not yet implemented`}
              >
                <span className="add-panel-modal__cell-label">{entry.label}</span>
                {!entry.implemented ? (
                  <span className="add-panel-modal__cell-tag">v1.3</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ))}
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

/**
 * Helper to clone a panel spec into the local PanelGrid. Strips the runset
 * index because the donor and recipient grids can have different runset
 * topologies; rest of the spec carries over.
 */
export function cloneInventoryPanel(entry: PanelInventoryEntry): PanelData {
  const next = JSON.parse(JSON.stringify(entry.panel_spec)) as PanelData;
  if ("runset_index" in next) {
    (next as { runset_index: number }).runset_index = 0;
  }
  return next;
}

// Re-export the default factory so callers can build a fresh panel from a
// picker type without importing types.ts directly. Mostly here for symmetry
// with the inventory clone helper.
export { defaultPanel };
