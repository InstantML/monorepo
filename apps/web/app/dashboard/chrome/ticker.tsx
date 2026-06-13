"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import type { Overview, RunSummary } from "../../dashboard-types";

// Telemetry ticker — the 38px strip that replaces the desktop brand row.
// Mirrors docs/design/reimagine/shell.js: "● LIVE n" on the left, one chip per
// running run in the middle, system stats + search + UTC clock on the right.
// Real data only: sparklines render solely from series the shell has already
// loaded; the points total is the real overview.metric_points count.

export function tickerShortRunName(name: string) {
  return name.replace(/^[a-z]+-/, "");
}

// Compact count for dense mono chrome (1.8k, 1.24M) — matches the mock's
// formatting without inventing rates.
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const format = (scaled: number, suffix: string) => {
    const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${parseFloat(scaled.toFixed(digits))}${suffix}`;
  };
  if (value >= 1e9) return format(value / 1e9, "B");
  if (value >= 1e6) return format(value / 1e6, "M");
  if (value >= 1e3) return format(value / 1e3, "k");
  return String(Math.round(value));
}

// Inline sparkline drawn exactly like the mock's Charts.spark: 1.2px path,
// 2px inset, optional live end-dot.
export function MiniSpark({
  values,
  width = 52,
  height = 14,
  color = "currentColor",
  live = false,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  live?: boolean;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (index: number) => (index / (values.length - 1)) * (width - 4) + 2;
  const y = (value: number) => height - 3 - ((value - min) / (max - min || 1)) * (height - 6);
  const d = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" opacity={live ? 1 : 0.7} />
      {live ? <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2" fill={color} /> : null}
    </svg>
  );
}

function UtcClock() {
  const [text, setText] = useState("––:––:–– UTC");
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setText(
        [now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()]
          .map((part) => String(part).padStart(2, "0"))
          .join(":") + " UTC",
      );
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="ticker__clock">{text}</span>;
}

function numberMetric(run: RunSummary, key: string): number | null {
  const value = run.latest_metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function TickerRunChip({
  run,
  metricKey,
  sparkValues,
}: {
  run: RunSummary;
  metricKey: string;
  sparkValues?: number[];
}) {
  const ret = numberMetric(run, metricKey);
  const loss = numberMetric(run, "train/loss");
  const delta = sparkValues && sparkValues.length >= 2
    ? sparkValues[sparkValues.length - 1] - sparkValues[sparkValues.length - 2]
    : null;
  // Always surface the tracked metric (return), with a trend arrow when the
  // direction is known; fall back to loss only when the run has no return.
  const headline = ret !== null ? { value: ret, digits: 1 } : loss !== null ? { value: loss, digits: 3 } : null;
  let value;
  if (headline && delta !== null && delta > 0) {
    value = <span className="delta-up">▲ {headline.value.toFixed(headline.digits)}</span>;
  } else if (headline && delta !== null && delta < 0) {
    value = <span className="delta-down">▼ {headline.value.toFixed(headline.digits)}</span>;
  } else if (headline) {
    value = <span className="tick-flat">— {headline.value.toFixed(headline.digits)}</span>;
  } else {
    value = <span className="tick-flat">—</span>;
  }
  return (
    <span className="tick-run" title={run.name}>
      <b>{run.name}</b>
      {sparkValues && sparkValues.length >= 2 ? (
        <span className="tick-spark"><MiniSpark values={sparkValues} /></span>
      ) : null}
      {value}
    </span>
  );
}

export function TickerStrip({
  metricKey,
  onQuickSearch,
  overview,
  runningRuns,
  sparkValues,
}: {
  metricKey: string;
  onQuickSearch: () => void;
  overview: Overview;
  runningRuns: RunSummary[];
  sparkValues: Record<string, number[]>;
}) {
  return (
    <div className="ticker" data-testid="telemetry-ticker">
      <div className="ticker__brand">
        <span className="ticker__live">
          <span className="pulse" aria-hidden="true" />
          LIVE {overview.active_runs}
        </span>
      </div>
      <div className="ticker__feed" aria-label="Running runs">
        {runningRuns.map((run) => (
          <TickerRunChip key={run.id} metricKey={metricKey} run={run} sparkValues={sparkValues[run.id]} />
        ))}
      </div>
      <div className="ticker__sys">
        <span className="ticker__pts">PTS <b>{compactCount(overview.metric_points)}</b></span>
        <button
          aria-label="Quick search"
          className="ticker__search"
          data-quick-search-trigger="true"
          onClick={onQuickSearch}
          title="Search (⌘K)"
          type="button"
        >
          <Search size={13} aria-hidden="true" />
        </button>
        <UtcClock />
      </div>
    </div>
  );
}
