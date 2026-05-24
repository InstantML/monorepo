"use client";

import { Star } from "lucide-react";

import { CustomSelect } from "../ui/select";

export function ChartControls(props: {
  idPrefix?: string;
  metricFilter: string;
  metricFilterValid: boolean;
  metricKey: string;
  metricOptions: string[];
  groupBy: string;
  xMode: string;
  smoothing: number;
  groupAverage: boolean;
  identifierMode: string;
  pinnedMetrics: string[];
  onMetricFilter: (value: string) => void;
  onMetricKey: (value: string) => void;
  onGroupBy: (value: string) => void;
  onXMode: (value: string) => void;
  onSmoothing: (value: number) => void;
  onIdentifierMode: (value: string) => void;
  onGroupAverage: (value: boolean) => void;
  onPinnedMetric: (metric: string) => void;
}) {
  const idPrefix = props.idPrefix ?? "";
  return (
    <div className="panel-controls">
      <label className={`control metric-filter-control ${props.metricFilterValid ? "" : "invalid"}`}>
        Metric filter
        <input id={`${idPrefix}metric-filter`} type="search" value={props.metricFilter} onChange={(event) => props.onMetricFilter(event.target.value)} placeholder="train/.*" />
      </label>
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
        id={`${idPrefix}x-mode`}
        label="X axis"
        onChange={props.onXMode}
        options={[
          { value: "step", label: "Step" },
          { value: "time", label: "Logged time" },
        ]}
        value={props.xMode}
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
      <label className="control">
        Smooth {props.smoothing}
        <input id={`${idPrefix}smoothing`} type="range" min="0" max="90" step="10" value={props.smoothing} onChange={(event) => props.onSmoothing(Number(event.target.value))} />
      </label>
      <label className="control">
        Avg
        <input id={`${idPrefix}group-average`} type="checkbox" checked={props.groupAverage} onChange={(event) => props.onGroupAverage(event.target.checked)} />
      </label>
    </div>
  );
}
