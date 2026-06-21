import type { CSSProperties } from "react";

// Shared dashboard loading skeletons. A single shimmer treatment (see
// styles/skeleton.css) keeps every tab's loading state in the same visual
// family, so a page reads as "drawing itself in" rather than "blank with the
// word Loading". Page-shaped layouts (distributed, compare, …) are composed
// from these primitives.

// Faux plotted bars, ramping up across the chart body. Fixed heights keep the
// shape stable across renders so it doesn't twitch while data streams in.
const CHART_BARS = [44, 66, 54, 80, 70, 90, 76, 94, 82, 68, 58, 78, 88, 72];

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
