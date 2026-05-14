"use client";

import {
  Activity,
  BarChart3,
  Box,
  Database,
  FileText,
  Folder,
  GitBranch,
  Package,
  RefreshCw,
  Search,
  Server,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { isAbortError, queryString } from "../../../src/api.js";
import { buildEvidenceSections, firstEvidenceItem } from "../../../src/evidence.js";
import { ansiTokens, terminalWindow } from "../../../src/terminal.js";
import { formatNumber, statusTone } from "../../../src/state.js";
import {
  ArtifactBrowser,
  MetricCard,
  MetricChart,
  RichObjectPanel,
  RunDetail,
} from "../../dashboard-components";
import { shortMetricName } from "../../dashboard-models";
import type {
  Artifact,
  HoverPoint,
  LoggedObject,
  LoggedObjectRow,
  MetricSeries,
  RunMetricRow,
  RunSummary,
  RunTimelineRow,
} from "../../dashboard-types";

export type RunWorkspaceTabId = "summary" | "data" | "logs" | "files" | "system" | "graph";
type ChartZoomRange = { min: number; max: number } | null;
type ApiLike = {
  get(path: string, options?: { signal?: AbortSignal }): Promise<any>;
};
type ConsoleLogLine = {
  created_at: string;
  line_number: number;
  message: string;
  run_id: string;
  stream: "stdout" | "stderr";
  timestamp: string;
};

const RUN_TABS: Array<{ id: RunWorkspaceTabId; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "data", label: "Data" },
  { id: "logs", label: "Logs" },
  { id: "files", label: "Files" },
  { id: "system", label: "System" },
  { id: "graph", label: "Graph" },
];
const TERMINAL_ROW_HEIGHT = 28;
const TERMINAL_VIEWPORT_HEIGHT = 420;

export function RunWorkspace({
  activeMetricKey,
  api,
  artifacts,
  chartDomain,
  chartFullDomain,
  chartHover,
  chartNormalizedSeries,
  chartRangeSeries,
  chartZoomRange,
  elementId,
  hover,
  loggedObjects,
  metricRows,
  objectRowsById,
  onChartLeave,
  onChartMove,
  onChartPointHover,
  onChartZoomRangeChange,
  onRunMetadataSave,
  onWorkspaceTabChange,
  run,
  selectedCount,
  selectedRuns,
  tab,
  timelineRows,
  xMode,
}: {
  activeMetricKey: string;
  api: ApiLike;
  artifacts: Artifact[];
  chartDomain: any;
  chartFullDomain: any;
  chartHover: HoverPoint;
  chartNormalizedSeries: MetricSeries[];
  chartRangeSeries: MetricSeries[];
  chartZoomRange: ChartZoomRange;
  elementId: string;
  hover: HoverPoint;
  loggedObjects: LoggedObject[];
  metricRows: RunMetricRow[];
  objectRowsById: Record<number, LoggedObjectRow[]>;
  onChartLeave: () => void;
  onChartMove: (event: MouseEvent<SVGSVGElement>) => void;
  onChartPointHover: (point: HoverPoint) => void;
  onChartZoomRangeChange: (range: ChartZoomRange) => void;
  onRunMetadataSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  onWorkspaceTabChange: (tab: RunWorkspaceTabId) => void;
  run: RunSummary | null;
  selectedCount: number;
  selectedRuns: RunSummary[];
  tab: RunWorkspaceTabId;
  timelineRows: RunTimelineRow[];
  xMode: string;
}) {
  useEffect(() => {
    onWorkspaceTabChange("summary");
  }, [onWorkspaceTabChange, run?.id]);

  if (!run) return <div className="empty">No run selected.</div>;
  return (
    <div className="run-workspace" id={elementId}>
      <header className="run-workspace-header">
        <div className="run-workspace-title">
          <span>{run.project}</span>
          <h2 title={run.name}>{run.name}</h2>
          <p>{durationContext(run)} · {sourceContext(run)}</p>
        </div>
        <div className="run-workspace-meta">
          <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
          {run.tags.slice(0, 2).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
          {run.tags.length > 2 ? <span className="chip">+{run.tags.length - 2}</span> : null}
        </div>
        <nav className="run-workspace-tabs" aria-label="Run workspace sections">
          {RUN_TABS.map((item) => (
            <button
              aria-pressed={tab === item.id}
              className={`run-workspace-tab ${tab === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => onWorkspaceTabChange(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {tab === "summary" ? (
        <RunDetail
          activeMetricKey={activeMetricKey}
          artifacts={artifacts}
          elementId={`${elementId}-summary`}
          hover={hover}
          loggedObjects={loggedObjects}
          metricRows={metricRows}
          objectRowsById={objectRowsById}
          onRunMetadataSave={onRunMetadataSave}
          run={run}
          selectedCount={selectedCount}
          selectedRuns={selectedRuns}
          timelineRows={timelineRows}
          workspaceSummary
        />
      ) : null}

      {tab === "data" ? (
        <section className="run-workspace-panel run-data-panel">
          <div className="panel-head compact-panel-head">
            <h2><BarChart3 size={15} /> {shortMetricName(activeMetricKey)} Curve</h2>
            <span className="chart-kind">bounded series</span>
          </div>
          <MetricChart
            domain={chartDomain}
            fullDomain={chartFullDomain}
            height={320}
            hover={chartHover}
            metricKey={activeMetricKey}
            normalizedSeries={chartNormalizedSeries}
            onLeave={onChartLeave}
            onMove={onChartMove}
            onPointHover={onChartPointHover}
            onZoomRangeChange={onChartZoomRangeChange}
            padding={48}
            rangeSeries={chartRangeSeries}
            showRange={false}
            xMode={xMode}
            zoomRange={chartZoomRange}
          />
        </section>
      ) : null}

      {tab === "logs" ? <RunLogsPanel api={api} run={run} /> : null}
      {tab === "files" ? (
        <RunEvidenceExplorer artifacts={artifacts} objects={loggedObjects} rowsByObjectId={objectRowsById} run={run} />
      ) : null}
      {tab === "system" ? <RunSystemPanel run={run} metricRows={metricRows} /> : null}
      {tab === "graph" ? <RunGraphPanel run={run} /> : null}
    </div>
  );
}

function RunLogsPanel({ api, run }: { api: ApiLike; run: RunSummary }) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<ConsoleLogLine[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const requestKeyRef = useRef(0);
  const windowRows = terminalWindow(lines.length, scrollTop, TERMINAL_ROW_HEIGHT, TERMINAL_VIEWPORT_HEIGHT);
  const visibleLines = lines.slice(windowRows.start, windowRows.end);

  useEffect(() => {
    const controller = new AbortController();
    const requestKey = requestKeyRef.current + 1;
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError("");
    setScrollTop(0);
    api.get(`/api/runs/${run.id}/logs${queryString({ stream, limit: 250, q: query.trim() })}`, { signal: controller.signal })
      .then((payload) => {
        if (requestKey !== requestKeyRef.current) return;
        setLines(payload.lines ?? []);
        setNextCursor(payload.next_cursor ?? null);
      })
      .catch((caught) => {
        if (isAbortError(caught) || requestKey !== requestKeyRef.current) return;
        setError(caught instanceof Error ? caught.message : "Unable to load logs.");
        setLines([]);
        setNextCursor(null);
      })
      .finally(() => {
        if (requestKey === requestKeyRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [api, query, refreshKey, run.id, stream]);

  async function loadMore() {
    if (!nextCursor || loading) return;
    const requestKey = requestKeyRef.current;
    const cursor = nextCursor;
    setLoading(true);
    setError("");
    try {
      const payload = await api.get(`/api/runs/${run.id}/logs${queryString({ stream, limit: 250, q: query.trim(), cursor })}`);
      if (requestKey !== requestKeyRef.current) return;
      setLines((current) => [...current, ...(payload.lines ?? [])]);
      setNextCursor(payload.next_cursor ?? null);
    } catch (caught) {
      if (requestKey !== requestKeyRef.current) return;
      setError(caught instanceof Error ? caught.message : "Unable to load more logs.");
    } finally {
      if (requestKey === requestKeyRef.current) setLoading(false);
    }
  }

  return (
    <section className="run-workspace-panel logs-panel">
      <div className="logs-toolbar">
        <div className="segmented-control" aria-label="Log stream">
          {(["stdout", "stderr"] as const).map((item) => (
            <button className={`segment-button ${stream === item ? "active" : ""}`} key={item} onClick={() => setStream(item)} type="button">
              <Terminal size={14} /> {item}
            </button>
          ))}
        </div>
        <label className="logs-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter logs" />
        </label>
        <button className="icon-button framed" aria-label="Refresh logs" onClick={() => setRefreshKey((current) => current + 1)} type="button">
          <RefreshCw size={15} />
        </button>
      </div>
      {error ? <div className="empty compact-empty">{error}</div> : null}
      <div className="terminal-frame">
        <div className="terminal-head">
          <span>Timestamp</span>
          <span>Line</span>
          <span>Message</span>
        </div>
        <div className="terminal-scroll" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <div className="terminal-spacer" style={{ height: windowRows.totalHeight }}>
            <div className="terminal-window" style={{ transform: `translateY(${windowRows.offsetTop}px)` }}>
              {visibleLines.map((line) => (
                <div className="terminal-row" key={`${line.stream}-${line.line_number}-${line.created_at}`}>
                  <span className="terminal-ts">{formatTimestamp(line.timestamp)}</span>
                  <span className="terminal-line">{line.line_number}</span>
                  <span className="terminal-message">
                    {ansiTokens(line.message).map((token, index) => (
                      <span className={token.className || undefined} key={index}>{token.text}</span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {!lines.length && !loading ? <div className="terminal-empty">No {stream} logs found.</div> : null}
        </div>
      </div>
      <div className="logs-footer">
        <span>{loading ? "Loading..." : `${formatNumber(lines.length, 0)} lines loaded`}</span>
        {nextCursor ? <button className="secondary" onClick={loadMore} type="button">Load more</button> : null}
      </div>
    </section>
  );
}

function RunEvidenceExplorer({
  artifacts,
  objects,
  rowsByObjectId,
  run,
}: {
  artifacts: Artifact[];
  objects: LoggedObject[];
  rowsByObjectId: Record<number, LoggedObjectRow[]>;
  run: RunSummary;
}) {
  const [search, setSearch] = useState("");
  const sections = useMemo(() => buildEvidenceSections({ artifacts: artifacts as any[], objects: objects as any[], search }), [artifacts, objects, search]);
  const fallbackItem = firstEvidenceItem(sections);
  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(() => {
    const all = sections.flatMap((section) => section.items);
    return all.find((item) => item.id === selectedId) ?? fallbackItem;
  }, [fallbackItem, sections, selectedId]);

  useEffect(() => {
    if (!selectedId && fallbackItem) setSelectedId(fallbackItem.id);
    if (selectedId && !sections.some((section) => section.items.some((item) => item.id === selectedId))) {
      setSelectedId(fallbackItem?.id ?? "");
    }
  }, [fallbackItem, sections, selectedId]);

  return (
    <section className="run-workspace-panel evidence-panel">
      <aside className="evidence-tree">
        <label className="evidence-search">
          <Search size={14} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files" />
        </label>
        {sections.map((section) => (
          <div className="evidence-section" key={section.id}>
            <h3>{section.label} <span>{section.items.length}</span></h3>
            {section.items.map((item) => (
              <button className={`evidence-row ${selected?.id === item.id ? "active" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)} type="button">
                <EvidenceIcon kind={item.kind} />
                <span>
                  <strong title={item.label}>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div className="evidence-preview">
        {selected ? <EvidencePreview item={selected} rowsByObjectId={rowsByObjectId} /> : (
          <div className="empty">No evidence logged for {run.name}.</div>
        )}
      </div>
    </section>
  );
}

function EvidencePreview({ item, rowsByObjectId }: { item: any; rowsByObjectId: Record<number, LoggedObjectRow[]> }) {
  if (item.artifact) {
    return (
      <div className="evidence-preview-stack">
        <div className="evidence-preview-head">
          <Package size={16} />
          <div>
            <h3>{item.artifact.name}</h3>
            <p>{item.artifact.type} · {item.artifact.step === null ? "no step" : `step ${item.artifact.step}`}</p>
          </div>
        </div>
        <ArtifactBrowser artifacts={[item.artifact]} />
        <div className="evidence-quicklook">
          <div><span>Type</span><strong>{item.artifact.type}</strong></div>
          <div><span>Size</span><strong>{formatNumber(item.artifact.size_bytes, 0)} bytes</strong></div>
          <div><span>Step</span><strong>{item.artifact.step === null ? "none" : item.artifact.step}</strong></div>
          <div><span>URI</span><strong>{item.artifact.uri}</strong></div>
        </div>
        <pre className="evidence-code-preview">
          {JSON.stringify({
            name: item.artifact.name,
            type: item.artifact.type,
            step: item.artifact.step,
            size_bytes: item.artifact.size_bytes,
            uri: item.artifact.uri,
            metadata: item.artifact.metadata ?? {},
          }, null, 2)}
        </pre>
      </div>
    );
  }
  if (item.object) {
    return <RichObjectPanel objects={[item.object]} rowsByObjectId={rowsByObjectId} title={item.object.key} />;
  }
  return <div className="empty">Select evidence to preview it.</div>;
}

function RunSystemPanel({ metricRows, run }: { metricRows: RunMetricRow[]; run: RunSummary }) {
  const commit = metadataValue(run.metadata, "git_commit")
    ?? metadataValue(run.metadata, "commit")
    ?? nestedMetadataValue(run.metadata, ["_rlobs", "source", "git", "commit"]);
  const artifactTotal = Object.values(run.artifact_counts ?? {}).reduce((total, value) => (
    total + (typeof value === "number" && Number.isFinite(value) ? value : 0)
  ), 0);
  const rows = [
    ["Host", run.metadata.hostname ?? run.metadata.host ?? "not logged"],
    ["PID", run.metadata.pid ?? "not logged"],
    ["Commit", commit ?? "not logged"],
    ["Metric keys", metricRows.length],
    ["Artifacts", artifactTotal],
  ];
  return (
    <section className="run-workspace-panel system-panel">
      <div className="system-grid">
        {rows.map(([label, value]) => (
          <MetricCard key={String(label)} label={String(label)} value={String(value)} tone="neutral" />
        ))}
      </div>
    </section>
  );
}

function RunGraphPanel({ run }: { run: RunSummary }) {
  return (
    <section className="run-workspace-panel graph-panel">
      <div className="empty">
        <GitBranch size={18} />
        Graph data has not been logged for {run.name} yet.
      </div>
    </section>
  );
}

function EvidenceIcon({ kind }: { kind: string }) {
  if (kind === "checkpoint") return <Box size={15} />;
  if (kind === "media" || kind === "object") return <Activity size={15} />;
  if (kind === "file") return <FileText size={15} />;
  return <Folder size={15} />;
}

function durationContext(run: RunSummary) {
  if (!run.started_at || !run.finished_at) return run.status === "running" ? "running" : "no duration";
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "no duration";
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function sourceContext(run: RunSummary) {
  const host = metadataValue(run.metadata, "hostname") ?? metadataValue(run.metadata, "host");
  const commit = metadataValue(run.metadata, "git_commit")
    ?? metadataValue(run.metadata, "commit")
    ?? nestedMetadataValue(run.metadata, ["_rlobs", "source", "git", "commit"]);
  return [host ? String(host) : "", commit ? shortHash(String(commit)) : ""].filter(Boolean).join(" · ") || "source metadata unavailable";
}

function shortHash(value: string) {
  return value.length > 10 ? value.slice(0, 10) : value;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function metadataValue(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function nestedMetadataValue(metadata: Record<string, unknown>, path: string[]) {
  let current: unknown = metadata;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" || typeof current === "number" ? current : null;
}
