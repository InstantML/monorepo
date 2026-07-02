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
// box.
const CHART_LINES = [
  "M0 50 C10 46 14 38 22 34 S36 26 44 24 S62 18 72 16 S90 12 100 10",
  "M0 14 C8 18 12 26 20 30 S34 38 44 40 S64 46 76 47 S92 49 100 50",
  "M0 36 C6 32 10 40 16 36 S26 28 34 32 S46 24 54 28 S68 20 78 24 S92 18 100 20",
];

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
// A static outline of faux series shimmers over the usual chart grid.
export function SkeletonChartLines({ label, minHeight }: { label?: string; minHeight?: number }) {
  return (
    <div
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="dash-skel-linechart"
      role={label ? "status" : undefined}
      style={minHeight === undefined ? undefined : { minHeight }}
    >
      <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 56">
        {CHART_LINES.map((d) => (
          <path d={d} key={d} />
        ))}
      </svg>
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
