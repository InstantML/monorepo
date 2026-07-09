import { Activity, Archive, Database, FileText, GitBranch, Package, Telescope } from "lucide-react";
import type { CSSProperties } from "react";

import { PageHead } from "./page-head";
import { SETTINGS_SECTIONS } from "../settings/sections";

// Shared dashboard loading skeletons. A single shimmer treatment (see
// styles/skeleton.css) keeps every tab's loading state in the same visual
// family, so a page reads as "drawing itself in" rather than "blank with the
// word Loading".
//
// Each lazy-loaded tab has a page-shaped skeleton below that reproduces that
// page's real chrome — its PageHead, panel frames, and headers render for real
// (they are known statically), while the data regions shimmer. The skeletons
// reuse the pages' own layout classes (hp-grid, traces-workspace, report-home,
// …) so the swap-in lands in exactly the boxes the loaded pane will occupy.

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

/* ── Page-shaped skeletons ─────────────────────────────────────────────────
 * One per lazy-loaded tab, used as that pane's dynamic() loading fallback in
 * dashboard-shell.tsx. Real page chrome, shimmering data. */

// Deterministic per-index widths (percent) so skeleton text lines and table
// cells read as data rather than uniform stamped bars, without twitching
// between renders.
const LINE_WIDTHS = [72, 54, 86, 62, 78, 46, 68, 58];

function lineWidth(index: number) {
  return LINE_WIDTHS[index % LINE_WIDTHS.length];
}

// Table placeholder: a header row over data rows, first column widest like
// most dashboard tables (name/title column, then numeric cells).
export function SkeletonTable({ columns = 4, rows = 6 }: { columns?: number; rows?: number }) {
  const template: CSSProperties = { gridTemplateColumns: `minmax(0, 2.1fr) repeat(${Math.max(1, columns - 1)}, minmax(0, 1fr))` };
  return (
    <div aria-hidden="true" className="dash-skel-table">
      <div className="dash-skel-table__row is-head" style={template}>
        {Array.from({ length: columns }, (_, column) => (
          <Skeleton className="dash-skel-table__cell" key={column} width={`${Math.round(lineWidth(column) * 0.55)}%`} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div className="dash-skel-table__row" key={row} style={template}>
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton className="dash-skel-table__cell" key={column} width={`${lineWidth(row + column)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// Label/value rows — settings lists and the key/value detail panels.
function SkeletonKvRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="dash-skel-kv">
      {Array.from({ length: rows }, (_, index) => (
        <div className="dash-skel-kv__row" key={index}>
          <Skeleton className="dash-skel-kv__label" width={`${Math.round(lineWidth(index) * 0.55)}%`} />
          <Skeleton className="dash-skel-kv__value" width={`${Math.round(lineWidth(index + 3) * 0.4)}%`} />
        </div>
      ))}
    </div>
  );
}

// A select/input-shaped control box.
function SkeletonControl({ width = "100%" }: { width?: number | string }) {
  return <Skeleton className="dash-skel-control" width={width} />;
}

// Run health: a stat strip, the alerts table beside the health key/value
// panel, and the datasets table underneath (mirrors alerts/tab-pane.tsx).
export function RunHealthPageSkeleton() {
  return (
    <>
      <PageHead title="Run health" />
      <div aria-label="Loading run health" className="dash-skel-flow" role="status">
        <div className="hp-grid">
          {["Open alerts", "Monitors", "Active runs", "Failed runs"].map((label, index) => (
            <section className="hp-panel hp-col-3" key={label}>
              <div className="hp-panel-head"><span className="hp-mlabel">{label}</span></div>
              <div className="hp-panel-body dash-skel-stat" aria-hidden="true">
                <Skeleton className="dash-skel-stat__value" width={`${34 + lineWidth(index) / 4}%`} />
                <Skeleton className="dash-skel-stat__sub" width={`${lineWidth(index + 2)}%`} />
              </div>
            </section>
          ))}
        </div>
        <div className="hp-grid">
          <section className="hp-panel hp-col-7">
            <div className="hp-panel-head"><span className="hp-mlabel">Alerts</span></div>
            <div className="hp-panel-body">
              <SkeletonTable columns={5} rows={6} />
            </div>
          </section>
          <section className="hp-panel hp-col-5">
            <div className="hp-panel-head"><span className="hp-mlabel">Run health</span></div>
            <div className="hp-panel-body">
              <SkeletonKvRows rows={4} />
              <Skeleton className="dash-skel-note" width="62%" />
            </div>
          </section>
        </div>
        <div className="hp-grid">
          <section className="hp-panel hp-col-12">
            <div className="hp-panel-head"><span className="hp-mlabel">Datasets</span></div>
            <div className="hp-panel-body">
              <SkeletonTable columns={4} rows={3} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

// Datasets: one full-width panel wrapping the config-derived dataset table.
export function DatasetsPageSkeleton() {
  return (
    <>
      <PageHead title="Datasets" />
      <div aria-label="Loading datasets" className="tab-grid" role="status">
        <section className="panel">
          <div className="panel-head"><h2><Database size={15} /> Config-derived Datasets</h2></div>
          <div className="panel-body">
            <SkeletonTable columns={5} rows={7} />
          </div>
        </section>
      </div>
    </>
  );
}

// Traces: the summaries list panel (filter row over trace rows) beside the
// trace tree panel (mirrors traces/tab-pane.tsx).
export function TracesPageSkeleton() {
  return (
    <>
      <PageHead title="Traces" />
      <div aria-label="Loading traces" className="traces-workspace" role="status">
        <section className="panel traces-list-panel">
          <div className="panel-head"><h2><Activity size={15} /> Trace summaries</h2></div>
          <div aria-hidden="true" className="trace-filter-row">
            {["Run", "Status", "Kind", "Search"].map((label) => (
              <div className="trace-filter-control" key={label}>
                <span>{label}</span>
                <SkeletonControl />
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="dash-skel-trace-list">
            {Array.from({ length: 8 }, (_, index) => (
              <div className="dash-skel-trace-row" key={index}>
                <Skeleton className="dash-skel-pill" width={58} />
                <span className="dash-skel-trace-main">
                  <Skeleton className="dash-skel-line is-title" width={`${lineWidth(index)}%`} />
                  <Skeleton className="dash-skel-line" width={`${Math.round(lineWidth(index + 1) * 0.7)}%`} />
                </span>
                <Skeleton className="dash-skel-line" width="82%" />
                <Skeleton className="dash-skel-line" width="72%" />
                <Skeleton className="dash-skel-line" width="78%" />
              </div>
            ))}
          </div>
        </section>
        <section className="panel traces-detail-panel">
          <div className="panel-head"><h2><GitBranch size={15} /> Trace tree</h2></div>
          <div aria-hidden="true" className="dash-skel-trace-tree">
            {[0, 1, 2, 2, 3, 2, 1, 2].map((depth, index) => (
              <Skeleton
                className="dash-skel-line"
                key={index}
                style={{ marginLeft: depth * 18 }}
                width={`${Math.max(24, lineWidth(index) - depth * 8)}%`}
              />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

// Reports: the "All reports" home header over the report list rows
// (mirrors reports/reports-tab-pane.tsx's list view).
export function ReportsPageSkeleton() {
  return (
    <>
      <PageHead title="Reports" />
      <section aria-label="Loading reports" className="report-home" role="status">
        <div className="report-home__header">
          <div>
            <h2><FileText size={16} /> All reports</h2>
            <p>Experiment writeups, live panels, and shareable readouts.</p>
          </div>
          <div aria-hidden="true" className="report-home__actions">
            <Skeleton className="dash-skel-button" width={158} />
            <Skeleton className="dash-skel-button" width={112} />
          </div>
        </div>
        <div className="report-home__body">
          <ul aria-hidden="true" className="report-list">
            {Array.from({ length: 5 }, (_, index) => (
              <li className="report-list__row" key={index}>
                <span className="dash-skel-report-main">
                  <Skeleton className="dash-skel-line is-title" width={`${Math.round(lineWidth(index) * 0.6)}%`} />
                  <Skeleton className="dash-skel-line" width={`${lineWidth(index + 2)}%`} />
                  <Skeleton className="dash-skel-line is-dim" width={`${Math.round(lineWidth(index + 4) * 0.5)}%`} />
                </span>
                <span className="dash-skel-report-stamps">
                  <Skeleton className="dash-skel-line" width={84} />
                  <Skeleton className="dash-skel-line is-dim" width={64} />
                </span>
                <span className="dash-skel-report-actions">
                  <Skeleton height={26} radius={6} width={26} />
                  <Skeleton height={26} radius={6} width={26} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}

// Insights: analysis header with the view toggle, over the two-two-one
// analysis card grid (mirrors insights/tab-pane.tsx).
export function InsightsPageSkeleton() {
  return (
    <div aria-label="Loading insights" className="analysis-page insights-page" role="status">
      <header className="analysis-header">
        <div className="analysis-title-block"><h2>Insights</h2></div>
        <Skeleton className="dash-skel-toggle" width={218} />
      </header>
      <div aria-hidden="true" className="dash-skel">
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
    </div>
  );
}

// Rank reducers: page head and the run/key control band over the analysis
// body the loaded pane also uses while fetching (distributed/tab-pane.tsx).
export function DistributedPageSkeleton() {
  return (
    <div aria-label="Loading rank reducers" className="analysis-page distributed-page" role="status">
      <PageHead title="Rank reducers" />
      <section aria-hidden="true" className="distributed-control-band">
        <div className="distributed-toolbar">
          <SkeletonControl width={220} />
          <SkeletonControl width={180} />
        </div>
      </section>
      <div aria-hidden="true" className="dash-skel">
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
    </div>
  );
}

// Agent: the Connect panel beside the capability-card grid and prompt
// starters (mirrors agent/tab-pane.tsx).
export function AgentPageSkeleton() {
  return (
    <>
      <PageHead title="Agent" />
      <div aria-label="Loading agent" className="tab-grid two-col agent-tab-grid" role="status">
        <section className="panel agent-connect-panel">
          <div className="panel-head"><h2><Telescope size={15} /> Connect</h2></div>
          <div aria-hidden="true" className="panel-body dash-skel-stack">
            <Skeleton className="dash-skel-line" width="52%" />
            <SkeletonControl />
            <Skeleton className="dash-skel-block" height={96} />
            <Skeleton className="dash-skel-line is-dim" width="68%" />
            <div className="dash-skel-button-row">
              <Skeleton className="dash-skel-button" width={182} />
              <Skeleton className="dash-skel-button" width={136} />
            </div>
          </div>
        </section>
        <section className="panel agent-capabilities-panel">
          <div className="panel-head"><h2><Activity size={15} /> Agent Workspace</h2></div>
          <div aria-hidden="true" className="panel-body dash-skel-stack">
            <div className="agent-capability-grid">
              {Array.from({ length: 6 }, (_, index) => (
                <article className="dash-skel-cap-card" key={index}>
                  <Skeleton height={16} radius={4} width={16} />
                  <Skeleton className="dash-skel-line is-title" width={`${Math.round(lineWidth(index) * 0.6)}%`} />
                  <Skeleton className="dash-skel-line" width="92%" />
                  <Skeleton className="dash-skel-line" width={`${lineWidth(index + 3)}%`} />
                  <span className="dash-skel-chip-row">
                    <Skeleton className="dash-skel-chip" width={64} />
                    <Skeleton className="dash-skel-chip" width={52} />
                    <Skeleton className="dash-skel-chip" width={70} />
                  </span>
                </article>
              ))}
            </div>
            <Skeleton className="dash-skel-line is-title" width={118} />
            <div className="dash-skel-stack is-tight">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton className="dash-skel-block" height={42} key={index} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

// Artifacts workspace: collections rail, versions, and lineage. Shared with
// artifacts/tab-pane.tsx, which shows the same skeleton (below its real
// PageHead) while the catalog itself loads — so the module-load fallback and
// the pane's own loading state are pixel-identical.
export function ArtifactsWorkspaceSkeleton() {
  return (
    <div className="artifact-workspace artifact-skeleton" aria-busy="true" aria-live="polite" aria-label="Loading artifacts">
      <section className="panel artifact-catalog-panel">
        <div className="panel-head"><h2><Package size={15} /> Collections</h2></div>
        <div className="panel-body artifact-collection-list">
          {Array.from({ length: 6 }).map((_, index) => (
            <div className="artifact-skeleton-row" key={index}>
              <span className="artifact-skeleton-line is-chip" />
              <span className="artifact-skeleton-line is-title" />
              <span className="artifact-skeleton-line is-meta" />
            </div>
          ))}
        </div>
      </section>
      <section className="panel artifact-version-panel">
        <div className="panel-head"><h2><Archive size={15} /> Versions</h2></div>
        <div className="panel-body artifact-collection-list">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="artifact-skeleton-row is-version" key={index}>
              <span className="artifact-skeleton-line is-box" />
              <span className="artifact-skeleton-line is-title" />
              <span className="artifact-skeleton-line is-meta" />
            </div>
          ))}
        </div>
      </section>
      <section className="panel artifact-lineage-panel">
        <div className="panel-head"><h2><GitBranch size={15} /> Lineage</h2></div>
        <div className="panel-body artifact-collection-list">
          {Array.from({ length: 3 }).map((_, index) => (
            <span className="artifact-skeleton-line is-block" key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}

// Artifacts: page head over the artifact workspace skeleton.
export function ArtifactsPageSkeleton() {
  return (
    <>
      <PageHead title="Artifacts" />
      <ArtifactsWorkspaceSkeleton />
    </>
  );
}

// Compare strip: lives at the top of the Runs → Table view, so its loading
// state is a strip, not a page — head row, metric controls, comparison rows
// (mirrors compare/tab-pane.tsx).
export function CompareEmbedSkeleton() {
  return (
    <section aria-label="Loading comparison" className="compare-embed" role="status">
      <header className="compare-embed-head">
        <div aria-hidden="true" className="compare-embed-title dash-skel-stack is-tight">
          <Skeleton className="dash-skel-line is-title" width={152} />
          <Skeleton className="dash-skel-line is-dim" width={216} />
        </div>
        <div aria-hidden="true" className="compare-embed-actions">
          <Skeleton className="dash-skel-control" width={168} />
          <Skeleton className="dash-skel-button" width={118} />
          <Skeleton className="dash-skel-button" width={76} />
        </div>
      </header>
      <div aria-hidden="true" className="compare-embed-controls">
        <Skeleton className="dash-skel-control" width={190} />
        <span className="dash-skel-chip-row">
          <Skeleton className="dash-skel-chip" width={92} />
          <Skeleton className="dash-skel-chip" width={74} />
          <Skeleton className="dash-skel-chip" width={84} />
        </span>
      </div>
      <SkeletonTable columns={5} rows={5} />
    </section>
  );
}

// Settings modal: the real section nav (labels are static) beside a pane of
// shimmering setting rows (mirrors settings/tab-pane.tsx).
export function SettingsModalSkeleton() {
  return (
    <div aria-label="Loading settings" className="workspace-modal settings-modal" role="status">
      <div aria-busy="true" className="settings-modal-card">
        <nav className="settings-nav" aria-hidden="true">
          <span className="settings-nav-title">Settings</span>
          {SETTINGS_SECTIONS.map(({ id, label, Icon }) => (
            <span className="settings-nav-item" key={id}>
              <Icon size={15} /> {label}
            </span>
          ))}
        </nav>
        <div className="settings-pane">
          <div className="settings-pane-head"><h2>{SETTINGS_SECTIONS[0].label}</h2></div>
          <div aria-hidden="true" className="settings-pane-body settings-grid">
            <div className="dash-skel-stack">
              <SkeletonKvRows rows={3} />
              <Skeleton className="dash-skel-meter" />
              <SkeletonKvRows rows={2} />
              <Skeleton className="dash-skel-meter" />
              <Skeleton className="dash-skel-note" width="58%" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
