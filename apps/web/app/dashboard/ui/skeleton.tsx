import type { CSSProperties } from "react";

// Shared dashboard loading skeletons. A single shimmer treatment (see
// styles/skeleton.css) keeps every tab's loading state in the same visual
// family, so a page reads as "drawing itself in" rather than "blank with the
// word Loading". Page-shaped layouts (distributed, compare, …) are composed
// from these primitives.

// Faux plotted bars, ramping up across the chart body. Fixed heights keep the
// shape stable across renders so it doesn't twitch while data streams in.
const CHART_BARS = [44, 66, 54, 80, 70, 90, 76, 94, 82, 68, 58, 78, 88, 72];

// Faux training curves for the line-chart placeholder, normalized to a 100x56
// box. Loss-shaped (steep drop, long flat tail) with slightly offset tails so
// the placeholder reads as a bundle of runs, like the plotted chart it stands
// in for.
const CHART_LINES = [
  "M0 3 C2 20 5 34 10 41 C17 47 28 50 44 51 C66 52 86 52.4 100 52.6",
  "M0 8 C3 24 7 37 13 43 C21 48 34 50 50 50.8 C70 51.4 88 51.6 100 51.8",
  "M0 5 C2.5 22 6 36 11.5 42 C19 47.5 31 49.4 47 50 C68 50.6 87 50.8 100 51",
];

// Faux legend label widths (percent of the chip) so the run list at the
// bottom of the placeholder reads organic rather than stamped.
const CHART_LEGEND_WIDTHS = [72, 56, 84, 62, 76, 50];

export function Skeleton({
  className = "",
  width,
  height,
  radius,
  style,
}: {
  className?: string;
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`dash-skeleton ${className}`.trim()}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

// A line-chart placeholder that occupies the exact box the plotted chart will
// take over, so the swap doesn't reflow the card. It stretches to fill its
// grid cell; pass minHeight when the real chart has a fixed frame height.
// A shimmering outline of faux series sits over the usual chart grid, with a
// faux run legend along the bottom mirroring the plotted chart's legend row.
// Pass legend={false} where the real chart renders without one (e.g. the
// single-run overview minis).
export function SkeletonChartLines({ label, legend = true, minHeight }: { label?: string; legend?: boolean; minHeight?: number }) {
  return (
    <div
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="dash-skel-linechart"
      role={label ? "status" : undefined}
      style={minHeight === undefined ? undefined : { minHeight }}
    >
      <div className="dash-skel-linechart__frame">
        <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 56">
          {CHART_LINES.map((d) => (
            <path d={d} key={d} />
          ))}
        </svg>
      </div>
      {legend ? (
        <div className="dash-skel-linechart__legend">
          {CHART_LEGEND_WIDTHS.map((width, index) => (
            <span className="dash-skel-linechart__legend-chip" key={index}>
              <Skeleton className="dash-skel-linechart__legend-swatch" />
              <Skeleton className="dash-skel-linechart__legend-label" width={`${width}%`} />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// A chart placeholder: grid backdrop with a bar silhouette rising across it.
export function SkeletonChart({ tall = false }: { tall?: boolean }) {
  return (
    <div className={`dash-skel-chart ${tall ? "is-tall" : ""}`.trim()}>
      <div className="dash-skel-chart__bars">
        {CHART_BARS.map((h, index) => (
          <Skeleton key={index} height={`${h}%`} radius="4px 4px 0 0" />
        ))}
      </div>
    </div>
  );
}

// A titled panel wrapping a chart placeholder — mirrors the analysis cards.
export function SkeletonChartCard({ tall = false }: { tall?: boolean }) {
  return (
    <div className="dash-skel-card">
      <div className="dash-skel-card__head">
        <Skeleton className="dash-skel-card__title" />
        <Skeleton className="dash-skel-card__meta" />
      </div>
      <SkeletonChart tall={tall} />
    </div>
  );
}

// A row of stat tiles (the "Tile" strip pattern used across analysis pages).
export function SkeletonStatTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="dash-skel-tiles">
      {Array.from({ length: count }, (_, index) => (
        <div className="dash-skel-tile" key={index}>
          <Skeleton className="dash-skel-tile__label" />
          <Skeleton className="dash-skel-tile__value" />
          <Skeleton className="dash-skel-tile__sub" />
        </div>
      ))}
    </div>
  );
}

// Rank reducers / distributed analysis page: a tile strip over a chart grid.
export function AnalysisSkeleton({ label }: { label: string }) {
  return (
    <div className="dash-skel" role="status" aria-label={label}>
      <SkeletonStatTiles count={4} />
      <div className="dash-skel-grid is-two">
        <SkeletonChartCard />
        <SkeletonChartCard />
      </div>
      <div className="dash-skel-grid is-two">
        <SkeletonChartCard />
        <SkeletonChartCard />
      </div>
      <div className="dash-skel-grid is-one">
        <SkeletonChartCard tall />
      </div>
    </div>
  );
}
