"use client";

import { Columns3, RefreshCw, Search } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";

import { shortMetricName } from "../../dashboard-models";
import { CustomSelect } from "../ui/select";
import type { TableColumns } from "../../dashboard-types";

const tableColumnLabels: Array<[keyof TableColumns, string]> = [
  ["status", "Status"],
  ["tags", "Tags"],
  ["notes", "Notes"],
  ["started", "Started"],
  ["duration", "Duration"],
  ["latest", "Latest metric"],
];

export function RunsCommandbar({
  columnsOpen,
  metricKey,
  metricOptions,
  onColumnsOpen,
  onMetricKey,
  onPinnedMetricFilter,
  onPinnedMetric,
  onRefresh,
  onTableColumns,
  pinnedMetricFilter,
  pinnedMetricFilterValid,
  pinnedMetricOptions,
  pinnedMetrics,
  tableColumns,
}: {
  columnsOpen: boolean;
  metricKey: string;
  metricOptions: string[];
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onMetricKey: (value: string) => void;
  onPinnedMetricFilter: (value: string) => void;
  onPinnedMetric: (metric: string) => void;
  onRefresh: () => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  pinnedMetricFilter: string;
  pinnedMetricFilterValid: boolean;
  pinnedMetricOptions: string[];
  pinnedMetrics: string[];
  tableColumns: TableColumns;
}) {
  return (
    <div className="runs-commandbar">
      <CustomSelect
        className="command-select metric-command"
        disabled={!metricOptions.length}
        id="runs-metric-select"
        label="Metric"
        labelClassName="command-label"
        onChange={onMetricKey}
        options={metricOptions.length ? metricOptions.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
        value={metricOptions.length ? metricKey : ""}
      />
      <div className="command-spacer" />
      <div className="columns-menu">
        <button className="secondary compact-button" type="button" aria-expanded={columnsOpen} aria-controls="columns-popover" onClick={() => onColumnsOpen((current) => !current)}><Columns3 size={15} /> Columns</button>
        {columnsOpen ? (
          <div className="column-popover" id="columns-popover">
            <strong>Visible columns</strong>
            {tableColumnLabels.map(([key, label]) => (
              <label key={key}>
                <input
                  checked={tableColumns[key]}
                  onChange={(event) => onTableColumns((current) => ({ ...current, [key]: event.target.checked }))}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
            <strong>Pinned metrics</strong>
            <label className={`metric-filter-row ${pinnedMetricFilterValid ? "" : "invalid"}`}>
              <Search size={13} />
              <input id="column-metric-filter" type="search" value={pinnedMetricFilter} onChange={(event) => onPinnedMetricFilter(event.target.value)} placeholder="metric regex" />
            </label>
            {pinnedMetricOptions.slice(0, 8).map((metric) => (
              <label key={metric} title={metric}>
                <input
                  checked={pinnedMetrics.includes(metric)}
                  onChange={() => onPinnedMetric(metric)}
                  type="checkbox"
                />
                {shortMetricName(metric)}
              </label>
            ))}
          </div>
        ) : null}
      </div>
      <button className="icon-button framed" type="button" aria-label="Refresh runs" onClick={onRefresh}><RefreshCw size={16} /></button>
    </div>
  );
}
