"use client";

import { Star } from "lucide-react";

import { CustomSelect } from "../ui/select";

/**
 * Secondary scope controls beneath the main chart. Smoothing and the x-axis
 * moved into the chart panel head (mockup parity); the metric search lives in
 * the metric browser panel. What remains here is the metric/group/identifier
 * scope plus the group-average toggle.
 */
export function ChartControls(props: {
  idPrefix?: string;
  metricKey: string;
  metricOptions: string[];
  groupBy: string;
  groupAverage: boolean;
  identifierMode: string;
  pinnedMetrics: string[];
  onMetricKey: (value: string) => void;
  onGroupBy: (value: string) => void;
  onIdentifierMode: (value: string) => void;
  onGroupAverage: (value: boolean) => void;
  onPinnedMetric: (metric: string) => void;
}) {
  const idPrefix = props.idPrefix ?? "";
  return (
    <div className="panel-controls mx-secondary-controls">
      <CustomSelect
        disabled={!props.metricOptions.length}
        id={`${idPrefix}metric-select`}
        label="Metric"
        onChange={props.onMetricKey}
        options={props.metricOptions.length ? props.metricOptions.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
        value={props.metricOptions.length ? props.metricKey : ""}
      />
      <button
        className={`secondary compact-button pin-button ${props.pinnedMetrics.includes(props.metricKey) ? "active" : ""}`}
        disabled={!props.metricKey}
        id={`${idPrefix}pin-metric`}
        onClick={() => props.onPinnedMetric(props.metricKey)}
        type="button"
      >
        <Star size={14} /> {props.pinnedMetrics.includes(props.metricKey) ? "Pinned" : "Pin"}
      </button>
      <CustomSelect
        id={`${idPrefix}group-select`}
        label="Group"
        onChange={props.onGroupBy}
        options={[
          { value: "", label: "None" },
          { value: "seed", label: "Seed" },
          { value: "tag", label: "First tag" },
          { value: "config:algo", label: "Config: algo" },
          { value: "config:policy", label: "Config: policy" },
        ]}
        value={props.groupBy}
      />
      <CustomSelect
        id={`${idPrefix}identifier-mode`}
        label="Identifier"
        onChange={props.onIdentifierMode}
        options={[
          { value: "name", label: "Name" },
          { value: "notes", label: "Notes" },
          { value: "tags", label: "Tags" },
        ]}
        value={props.identifierMode}
      />
      <label className="control metrics-average-control">
        <span>Avg</span>
        <input aria-label="Group average" id={`${idPrefix}group-average`} type="checkbox" checked={props.groupAverage} onChange={(event) => props.onGroupAverage(event.target.checked)} />
      </label>
    </div>
  );
}
