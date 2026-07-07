"use client";

import { Activity } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

import { axisTicks, formatAxisTick, formatAxisValue, formatMetricValue, normalizeSeries, svgPointFromClient, yMapper } from "../../../src/charts.js";
import { chartColor } from "../../../src/chart-colors.js";
import { formatNumber } from "../../../src/state.js";
import { CustomSelect } from "../ui/select";
import type { SelectOption } from "../ui/select";
import { SkeletonChartLines } from "../ui/skeleton";
import { formatDuration } from "../ui/duration";
import { useMeasuredSize } from "../ui/use-measured-size";
import type { MetricSeries } from "../../dashboard-types";
import type { components } from "../../../src/types/api.generated";

type StepBucket = components["schemas"]["TraceStepBucket"];
type TraceStepSummary = components["schemas"]["TraceStepSummaryResponse"];

// Geometry of the timeline frame, in CSS px (viewBox == rendered size, mirroring
// MetricChart's constant-pixel model). The metric plot occupies the top band; a
// fixed-height activity lane sits below the x-axis sharing the same x scale.
const TIMELINE_HEIGHT = 260;
const LANE_HEIGHT = 28;
const LANE_GAP = 10;
const X_AXIS_H = 22;
const PLOT_TOP = 16;
const PLOT_PAD_L = 46;
const PLOT_PAD_R = 16;
const PLOT_BOTTOM = TIMELINE_HEIGHT - LANE_HEIGHT - X_AXIS_H - LANE_GAP;
const LANE_TOP = PLOT_BOTTOM + X_AXIS_H + LANE_GAP;
const LANE_CENTER = LANE_TOP + LANE_HEIGHT / 2;
const MARKER_MIN_R = 3;
const MARKER_MAX_R = 9;
const HOVER_NEAR_PX = 40;

type NormPoint = { step: number; value: number; xValue: number };
type NormDomain = { minX: number; maxX: number; minY: number; maxY: number; yScale?: string };
type NormSeries = { normalizedPoints?: NormPoint[]; domain?: NormDomain };
type HoverInfo = { x: number; step: number; bucket: StepBucket | null; metricValue: number | null };

type Props = {
  error: string;
  loading: boolean;
  metricKey: string;
  metricKeys: string[];
  onMetricKeyChange: (key: string) => void;
  onStepSelect: (step: number | null) => void;
  runName: string;
  selectedStep: number | null;
  series: MetricSeries[];
  steps: TraceStepSummary | null;
};

function markerTone(bucket: StepBucket) {
  if (bucket.error_trace_count > 0) return "err";
  if (bucket.trace_count > 0 && bucket.running_trace_count === bucket.trace_count) return "run";
  return "ok";
}

function bucketStatsText(bucket: StepBucket) {
  const errors = `${formatNumber(bucket.error_trace_count, 0)} error${bucket.error_trace_count === 1 ? "" : "s"}`;
  const traces = `${formatNumber(bucket.trace_count, 0)} trace${bucket.trace_count === 1 ? "" : "s"}`;
  const avg = `avg ${formatDuration(bucket.avg_duration_ms)}`;
  const tokens = `${formatNumber(bucket.input_tokens, 0)}/${formatNumber(bucket.output_tokens, 0)} tok`;
  return `${traces} · ${errors} · ${avg} · ${tokens}`;
}

function markerLabel(bucket: StepBucket) {
  return `Step ${formatNumber(bucket.step, 0)}: ${bucketStatsText(bucket)}`;
}

/**
 * A single SVG chart correlating one run metric with per-step trace activity.
 * The metric line (top) and the trace activity lane (bottom) share one x-domain
 * — the union of the metric series' step range and the trace bucket step range —
 * so traces logged past the last metric point stay visible. Buckets are clickable
 * to pin the recent-traces list below to that step.
 */
export function TraceMetricTimeline({
  error,
  loading,
  metricKey,
  metricKeys,
  onMetricKeyChange,
  onStepSelect,
  runName,
  selectedStep,
  series,
  steps,
}: Props) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { width } = useMeasuredSize(frameRef, 640, TIMELINE_HEIGHT);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const buckets = useMemo<StepBucket[]>(() => steps?.steps ?? [], [steps]);

  // Reuse the exact y-domain math the metric charts use (unit domains, nice
  // rounding, log support) via normalizeSeries; x positions are recomputed
  // against the shared union domain below.
  const normalized = useMemo(
    () => normalizeSeries(series, width, TIMELINE_HEIGHT, PLOT_TOP, "step", metricKey) as NormSeries[],
    [metricKey, series, width],
  );
  const metricSeries = normalized.find((item) => (item.normalizedPoints?.length ?? 0) > 0) ?? normalized[0] ?? null;
  const metricPoints = metricSeries?.normalizedPoints ?? [];
  const domain = normalized.find((item) => item.domain)?.domain ?? null;
  const hasMetric = Boolean(domain) && metricPoints.length > 0;

  const options = useMemo<SelectOption[]>(
    () => metricKeys.map((key) => ({ label: key, value: key })),
    [metricKeys],
  );

  // Shared x-domain: union of the metric series step extent and the bucket step
  // extent, so activity past the last metric point still renders.
  const stepRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    if (domain) {
      min = Math.min(min, domain.minX);
      max = Math.max(max, domain.maxX);
    }
    for (const bucket of buckets) {
      if (bucket.step < min) min = bucket.step;
      if (bucket.step > max) max = bucket.step;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    if (min === max) return { min: min - 1, max: max + 1 };
    return { min, max };
  }, [buckets, domain]);

  const plotLeft = PLOT_PAD_L;
  const plotRight = Math.max(plotLeft + 1, width - PLOT_PAD_R);
  const xSpan = (stepRange.max - stepRange.min) || 1;
  const xPos = (step: number) => plotLeft + ((step - stepRange.min) / xSpan) * (plotRight - plotLeft);
  const yPos = useMemo(
    () => (domain ? (yMapper(domain, PLOT_BOTTOM + PLOT_TOP, PLOT_TOP) as (value: number) => number) : () => LANE_CENTER),
    [domain],
  );

  const maxTraceCount = useMemo(() => buckets.reduce((max, bucket) => Math.max(max, bucket.trace_count), 0), [buckets]);

  // Contiguous error-step runs become full-height wash bands so "the metric
  // moved exactly where traces failed" reads without inspecting markers. Band
  // edges extend half the local step gap on each side.
  const errorBands = useMemo(() => {
    const bands: Array<{ from: number; to: number }> = [];
    for (let index = 0; index < buckets.length; index += 1) {
      if (buckets[index].error_trace_count <= 0) continue;
      const gapBefore = index > 0 ? buckets[index].step - buckets[index - 1].step : 1;
      let end = index;
      while (
        end + 1 < buckets.length
        && buckets[end + 1].error_trace_count > 0
      ) end += 1;
      const gapAfter = end + 1 < buckets.length ? buckets[end + 1].step - buckets[end].step : gapBefore;
      bands.push({
        from: buckets[index].step - Math.min(gapBefore, 1) / 2,
        to: buckets[end].step + Math.min(gapAfter, 1) / 2,
      });
      index = end;
    }
    return bands;
  }, [buckets]);

  const errorTraceTotal = useMemo(
    () => buckets.reduce((total, bucket) => total + bucket.error_trace_count, 0),
    [buckets],
  );
  const radiusFor = (count: number) => {
    if (maxTraceCount <= 0) return MARKER_MIN_R;
    const scaled = Math.sqrt(Math.max(0, count)) / Math.sqrt(maxTraceCount);
    return Math.max(MARKER_MIN_R, Math.min(MARKER_MAX_R, MARKER_MIN_R + scaled * (MARKER_MAX_R - MARKER_MIN_R)));
  };

  const metricPath = useMemo(() => {
    if (!hasMetric) return "";
    return metricPoints.map((point, index) => `${index ? " " : ""}${xPos(point.step).toFixed(2)},${yPos(point.value).toFixed(2)}`).join("");
    // xPos/yPos derive from width, stepRange, and domain — all captured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMetric, metricPoints, width, stepRange.min, stepRange.max, plotRight, domain]);

  const xTicks = useMemo(
    () => axisTicks(stepRange.min, stepRange.max, Math.max(3, Math.min(8, Math.round(width / 140)))),
    [stepRange.max, stepRange.min, width],
  );
  const yTicks = useMemo(
    () => (domain ? axisTicks(domain.minY, domain.maxY, Math.max(3, Math.min(6, Math.round(PLOT_BOTTOM / 46)))) : []),
    [domain],
  );

  function nearestMetricValue(step: number) {
    let value: number | null = null;
    let best = Infinity;
    for (const point of metricPoints) {
      const distance = Math.abs(xPos(point.step) - xPos(step));
      if (distance < best) {
        best = distance;
        value = point.value;
      }
    }
    return best <= HOVER_NEAR_PX ? value : null;
  }

  function handleMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const local = svgPointFromClient(rect, event.clientX, event.clientY, width, TIMELINE_HEIGHT);
    const px = local.x;
    let bucket: StepBucket | null = null;
    let bucketDistance = Infinity;
    for (const candidate of buckets) {
      const distance = Math.abs(xPos(candidate.step) - px);
      if (distance < bucketDistance) {
        bucketDistance = distance;
        bucket = candidate;
      }
    }
    let metricPoint: NormPoint | null = null;
    let metricDistance = Infinity;
    for (const point of metricPoints) {
      const distance = Math.abs(xPos(point.step) - px);
      if (distance < metricDistance) {
        metricDistance = distance;
        metricPoint = point;
      }
    }
    const bucketNear = bucket !== null && bucketDistance <= HOVER_NEAR_PX;
    const metricNear = metricPoint !== null && metricDistance <= HOVER_NEAR_PX;
    if (!bucketNear && !metricNear) {
      setHover(null);
      return;
    }
    const anchorStep = bucketNear && (!metricNear || bucketDistance <= metricDistance)
      ? (bucket as StepBucket).step
      : (metricPoint as NormPoint).step;
    setHover({
      x: xPos(anchorStep),
      step: anchorStep,
      bucket: bucketNear ? bucket : null,
      metricValue: metricNear ? (metricPoint as NormPoint).value : null,
    });
  }

  function focusBucket(bucket: StepBucket) {
    setHover({ x: xPos(bucket.step), step: bucket.step, bucket, metricValue: nearestMetricValue(bucket.step) });
  }

  function toggleStep(step: number) {
    onStepSelect(selectedStep === step ? null : step);
  }

  const captions: string[] = [];
  if (!hasMetric && buckets.length) captions.push(metricKey ? `No points for ${metricKey} yet` : "No user metrics to plot");
  if (steps?.truncated) captions.push("Showing first 2,000 steps");

  const tooltipLeft = Math.max(64, Math.min(width - 64, hover?.x ?? 0));
  const frameStyle = { height: `${TIMELINE_HEIGHT}px` } as CSSProperties;

  let body: ReactNode;
  if (loading) {
    body = <SkeletonChartLines label={`Loading trace timeline for ${runName}`} legend={false} minHeight={TIMELINE_HEIGHT} />;
  } else if (error) {
    body = <div className="status-strip">{error}</div>;
  } else if (!buckets.length && (steps?.stepless_trace_count ?? 0) > 0) {
    body = (
      <div className="pd-trace-timeline-note">
        {formatNumber(steps?.stepless_trace_count ?? 0, 0)} trace{(steps?.stepless_trace_count ?? 0) === 1 ? "" : "s"} have no step; showing recent traces below.
      </div>
    );
  } else if (!buckets.length) {
    return null;
  } else {
    body = (
      <>
        <div className="pd-trace-timeline-frame" ref={frameRef} style={frameStyle}>
          <svg
            aria-label={`Trace activity and ${metricKey || "metric"} for ${runName}`}
            className="pd-trace-timeline-svg"
            onMouseLeave={() => setHover(null)}
            onMouseMove={handleMove}
            role="img"
            viewBox={`0 0 ${width} ${TIMELINE_HEIGHT}`}
          >
            {errorBands.map((band) => (
              <rect
                className="pd-trace-error-band"
                height={LANE_TOP + LANE_HEIGHT - PLOT_TOP}
                key={`band-${band.from}`}
                width={Math.max(2, xPos(band.to) - xPos(band.from))}
                x={xPos(band.from)}
                y={PLOT_TOP}
              />
            ))}
            {yTicks.map((tick) => (
              <g key={`y-${tick}`}>
                <line className="grid-line" x1={plotLeft} x2={plotRight} y1={yPos(tick)} y2={yPos(tick)} />
                <text className="tick-label" textAnchor="end" x={plotLeft - 6} y={yPos(tick) + 4}>{formatAxisTick(tick)}</text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <g key={`x-${tick}`}>
                <line className="grid-line vertical" x1={xPos(tick)} x2={xPos(tick)} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
                {xPos(tick) <= plotRight - 44 ? (
                  <text className="tick-label" textAnchor="middle" x={xPos(tick)} y={PLOT_BOTTOM + 16}>{formatAxisValue(tick, "step")}</text>
                ) : null}
              </g>
            ))}
            <line className="axis" x1={plotLeft} x2={plotRight} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} />
            <line className="axis" x1={plotLeft} x2={plotLeft} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
            <text className="axis-label axis-label-x" textAnchor="end" x={plotRight} y={PLOT_BOTTOM + 16}>Step</text>

            {/* Activity lane: hairline bezel + micro label make the second
                channel read as an instrument row, not floating dots. */}
            <line className="pd-trace-lane-divider" x1={plotLeft} x2={plotRight} y1={LANE_TOP - LANE_GAP / 2} y2={LANE_TOP - LANE_GAP / 2} />
            <text className="pd-trace-lane-label" textAnchor="end" x={plotLeft - 6} y={LANE_CENTER + 3}>traces</text>
            <line className="pd-trace-lane-track" x1={plotLeft} x2={plotRight} y1={LANE_CENTER} y2={LANE_CENTER} />
            {selectedStep !== null ? (
              <line className="pd-trace-selected-guide" x1={xPos(selectedStep)} x2={xPos(selectedStep)} y1={PLOT_TOP} y2={LANE_TOP + LANE_HEIGHT} />
            ) : null}

            {hasMetric ? (
              <polyline
                className="pd-trace-timeline-line"
                points={metricPath}
                style={{ stroke: chartColor(0) }}
              />
            ) : null}

            {hover ? <line className="hover-guide" x1={hover.x} x2={hover.x} y1={PLOT_TOP} y2={LANE_TOP + LANE_HEIGHT} /> : null}
            {hover && hover.metricValue !== null ? (
              <circle className="pd-trace-timeline-dot" cx={hover.x} cy={yPos(hover.metricValue)} r={4} style={{ fill: chartColor(0) }} />
            ) : null}

            {buckets.map((bucket) => (
              <g key={`marker-${bucket.step}`}>
                {selectedStep === bucket.step ? (
                  <circle className="pd-trace-marker-ring" cx={xPos(bucket.step)} cy={LANE_CENTER} r={radiusFor(bucket.trace_count) + 3} />
                ) : null}
                <circle
                  className={`pd-trace-marker ${markerTone(bucket)}${hover?.bucket?.step === bucket.step ? " is-hover" : ""}`}
                  cx={xPos(bucket.step)}
                  cy={LANE_CENTER}
                  r={radiusFor(bucket.trace_count)}
                />
              </g>
            ))}
          </svg>

          {/* Real <button> hit targets over the lane give the markers full
              keyboard operability and native focus-visible without SVG focus
              quirks; the circles above are the visual layer. */}
          <div className="pd-trace-lane-hits">
            {buckets.map((bucket) => {
              const size = Math.max(22, radiusFor(bucket.trace_count) * 2 + 8);
              return (
                <button
                  aria-label={markerLabel(bucket)}
                  aria-pressed={selectedStep === bucket.step}
                  className="pd-trace-marker-btn"
                  key={`hit-${bucket.step}`}
                  onBlur={() => setHover((current) => (current?.step === bucket.step ? null : current))}
                  onClick={() => toggleStep(bucket.step)}
                  onFocus={() => focusBucket(bucket)}
                  onMouseEnter={() => focusBucket(bucket)}
                  style={{ left: `${xPos(bucket.step)}px`, top: `${LANE_CENTER}px`, width: `${size}px`, height: `${size}px` }}
                  type="button"
                />
              );
            })}
          </div>

          {hover ? (
            <div className="chart-tooltip pd-trace-tip" role="tooltip" style={{ left: `${tooltipLeft}px` }}>
              <div className="chart-tooltip-head">Step {formatNumber(hover.step, 0)}</div>
              {hover.metricValue !== null ? (
                <div className="pd-trace-tip-row">
                  <span className="pd-trace-tip-key" style={{ color: chartColor(0) }}>{metricKey}</span>
                  <b>{formatMetricValue(hover.metricValue)}</b>
                </div>
              ) : null}
              {hover.bucket ? (
                <div className="pd-trace-tip-stats">
                  {formatNumber(hover.bucket.trace_count, 0)} trace{hover.bucket.trace_count === 1 ? "" : "s"}
                  {" · "}
                  <span className={hover.bucket.error_trace_count > 0 ? "pd-trace-tip-errors" : undefined}>
                    {formatNumber(hover.bucket.error_trace_count, 0)} error{hover.bucket.error_trace_count === 1 ? "" : "s"}
                  </span>
                  {" · avg "}{formatDuration(hover.bucket.avg_duration_ms)}
                  {" · "}{formatNumber(hover.bucket.input_tokens, 0)}/{formatNumber(hover.bucket.output_tokens, 0)} tok
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {captions.length ? (
          <div className="pd-trace-timeline-captions">
            {captions.map((caption) => <span className="pd-trace-timeline-caption" key={caption}>{caption}</span>)}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section className="pd-panel pd-trace-timeline">
      <div className="pd-panel-head">
        <span className="pd-mlabel"><Activity size={14} /> Trace activity</span>
        {buckets.length ? (
          <span className="pd-unit pd-trace-timeline-summary">
            {formatNumber(steps?.total_trace_count ?? 0, 0)} traces
            {errorTraceTotal > 0 ? <span className="pd-trace-timeline-summary-errors"> · {formatNumber(errorTraceTotal, 0)} errors</span> : null}
            {` · steps ${formatNumber(stepRange.min, 0)}–${formatNumber(stepRange.max, 0)}`}
          </span>
        ) : null}
        {options.length ? (
          <CustomSelect
            className="pd-trace-metric-select"
            id="trace-timeline-metric"
            label="Metric"
            labelClassName="pd-trace-select-label"
            menuAlign="right"
            onChange={onMetricKeyChange}
            options={options}
            value={metricKey}
          />
        ) : (
          <span className="pd-unit">no metrics logged</span>
        )}
      </div>
      <div className="pd-panel-body">{body}</div>
    </section>
  );
}
