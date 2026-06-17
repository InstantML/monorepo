"use client";

import { Star } from "lucide-react";
import { useMemo, useState } from "react";

import { shortMetricName } from "../../dashboard-models";
import type { MetricCatalogRow } from "../../dashboard-types";

/**
 * Namespace tree for the metric browser panel (mockup parity: mtree).
 * Rows arrive pre-filtered/sorted from the catalog; they are grouped by
 * namespace into collapsible sections. The active leaf gets the signal
 * treatment (left edge + gradient + dot); each leaf keeps its pin star.
 */
export function MetricCatalog({
  activeMetric,
  onMetricKey,
  onPinnedMetric,
  pinnedMetrics,
  rows,
}: {
  activeMetric: string;
  onMetricKey: (metric: string) => void;
  onPinnedMetric: (metric: string) => void;
  pinnedMetrics: string[];
  rows: MetricCatalogRow[];
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const groups = useMemo(() => {
    const byNamespace = new Map<string, MetricCatalogRow[]>();
    for (const row of rows) {
      const list = byNamespace.get(row.namespace) ?? [];
      list.push(row);
      byNamespace.set(row.namespace, list);
    }
    return [...byNamespace.entries()];
  }, [rows]);

  if (!rows.length) return <div className="mx-empty">No metrics are available for the current run filters.</div>;

  function toggleNamespace(namespace: string) {
    setCollapsed((current) => current.includes(namespace) ? current.filter((item) => item !== namespace) : [...current, namespace]);
  }

  return (
    <div className="mx-tree" role="tree" aria-label="Metric namespaces">
      {groups.map(([namespace, groupRows]) => {
        const isCollapsed = collapsed.includes(namespace);
        return (
          <div key={namespace} role="group">
            <button
              aria-expanded={!isCollapsed}
              className="mx-tree-ns"
              onClick={() => toggleNamespace(namespace)}
              type="button"
            >
              <span className="mx-tree-caret" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
              {namespace}
              <span className="mx-tree-n">{groupRows.length}</span>
            </button>
            {!isCollapsed ? groupRows.map((row) => {
              const pinned = pinnedMetrics.includes(row.key);
              const active = row.key === activeMetric;
              return (
                <div className={`mx-tree-leaf${active ? " is-active" : ""}`} key={row.key} role="treeitem" aria-selected={active}>
                  <button
                    className="mx-tree-leaf-main"
                    onClick={() => onMetricKey(row.key)}
                    title={`${row.key} · ${row.selectedCount}/${row.runCount} runs`}
                    type="button"
                  >
                    {shortMetricName(row.key)}
                  </button>
                  <button
                    aria-label={pinned ? `Unpin ${row.key}` : `Pin ${row.key}`}
                    aria-pressed={pinned}
                    className={`mx-leaf-pin${pinned ? " is-pinned" : ""}`}
                    onClick={() => onPinnedMetric(row.key)}
                    title={pinned ? "Pinned metric" : "Pin metric"}
                    type="button"
                  >
                    <Star size={11} />
                  </button>
                  {active ? <span className="mx-leaf-dot" aria-hidden="true">●</span> : null}
                </div>
              );
            }) : null}
          </div>
        );
      })}
    </div>
  );
}
