"use client";

import {
  Activity,
  BarChart3,
  Box,
  Copy,
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
import type { MouseEvent, ReactNode } from "react";

import { isAbortError, queryString, retryTransientRequest } from "../../../src/api.js";
import { buildCheckpointResumeCode } from "../../../src/checkpoints.js";
import { buildEvidenceSections, firstEvidenceItem } from "../../../src/evidence.js";
import { ansiTokens, terminalWindow } from "../../../src/terminal.js";
import { displayStatusForRun, formatNumber, statusTone } from "../../../src/state.js";
import { ArtifactBrowser } from "../artifacts/artifact-browser";
import { MetricCard } from "../ui/metric-card";
import { MetricChart } from "../metrics/metric-chart";
import { RichObjectPanel } from "../detail/rich-object-panel";
import { RunDetail } from "../detail/run-detail";
import { safeArtifactUri, shortMetricName } from "../../dashboard-models";
import type {
  Artifact,
  HoverPoint,
  LoggedObject,
  LoggedObjectRow,
  MetricSeries,
  RunLineage,
  RunMetricRow,
  RunSummary,
  RunTimelineRow,
} from "../../dashboard-types";

export type RunWorkspaceTabId = "summary" | "data" | "logs" | "files" | "system" | "graph";
type ChartZoomRange = { min: number; max: number } | null;
type ApiLike = {
  get(path: string, options?: { signal?: AbortSignal }): Promise<any>;
  post(path: string, body?: any, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<any>;
};
const RUN_WORKSPACE_REQUEST_RETRY_DELAYS_MS = [250, 700, 1_500];

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Keep the visible resume snippet/selectable ID as a manual fallback.
  }
}
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
  chartSeries,
  chartZoomRange,
  dataControls,
  elementId,
  hover,
  loggedObjects,
  metricRows,
  objectRowsById,
  onChartLeave,
  onChartPointHover,
  onChartZoomRangeChange,
  onForkCheckpoint,
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
  chartSeries: MetricSeries[];
  chartZoomRange: ChartZoomRange;
  dataControls?: ReactNode;
  elementId: string;
  hover: HoverPoint;
  loggedObjects: LoggedObject[];
  metricRows: RunMetricRow[];
  objectRowsById: Record<number, LoggedObjectRow[]>;
  onChartLeave: () => void;
  onChartPointHover: (point: HoverPoint) => void;
  onChartZoomRangeChange: (range: ChartZoomRange) => void;
  onForkCheckpoint?: (artifact: Artifact, options: { inheritConfig: boolean; name: string; reason: string }) => Promise<void>;
  onRunMetadataSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  onWorkspaceTabChange: (tab: RunWorkspaceTabId) => void;
  run: RunSummary | null;
  selectedCount: number;
  selectedRuns: RunSummary[];
  tab: RunWorkspaceTabId;
  timelineRows: RunTimelineRow[];
  xMode: string;
}) {
  if (!run) {
    return (
      <div className="empty compact-empty run-detail-empty">
        <strong>No run open</strong>
        <span>Pick a run from the Runs workspace to inspect its summary, logs, files, and system metrics. Checkpoints live here too — open a run to download, resume, or fork from its checkpoints.</span>
        <a className="secondary compact-button" href="/dashboard/runs">Go to Runs</a>
      </div>
    );
  }
  const displayStatus = displayStatusForRun(run);
  return (
    <div className="run-workspace" id={elementId}>
      <header className="run-workspace-header">
        <div className="run-workspace-topline">
          <h2 className="run-workspace-name" title={run.name}>{run.name}</h2>
          <span className="run-workspace-sub">{durationContext(run)} · {sourceContext(run)}</span>
          <div className="run-workspace-spacer" />
          <span className={`pill ${statusTone(displayStatus)}`}>{displayStatus}</span>
          <div className="run-workspace-meta">
            {run.tags.slice(0, 2).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
            {run.tags.length > 2 ? <span className="chip">+{run.tags.length - 2}</span> : null}
          </div>
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
          onForkCheckpoint={onForkCheckpoint}
          onOpenFiles={() => onWorkspaceTabChange("files")}
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
            {dataControls ? <div className="run-data-controls">{dataControls}</div> : null}
            <span className="chart-kind">bounded series</span>
          </div>
          <MetricChart
            height={320}
            metricKey={activeMetricKey}
            emptyMessage={run ? `${run.name} has not logged the selected metric. Pick one of its logged metrics from the Metric selector above.` : undefined}
            onLeave={onChartLeave}
            onPointHover={onChartPointHover}
            onZoomRangeChange={onChartZoomRangeChange}
            padding={48}
            series={chartSeries}
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
      {tab === "graph" ? <RunGraphPanel api={api} run={run} /> : null}
    </div>
  );
}

export function RunLogsPanel({ api, run }: { api: ApiLike; run: RunSummary }) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<ConsoleLogLine[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const requestKeyRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(0);
  const windowRows = terminalWindow(lines.length, scrollTop, TERMINAL_ROW_HEIGHT, TERMINAL_VIEWPORT_HEIGHT);
  const tokenizedLines = useMemo(() => (
    lines.map((line) => ({ ...line, tokens: ansiTokens(line.message) }))
  ), [lines]);
  const visibleLines = tokenizedLines.slice(windowRows.start, windowRows.end);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  function updateScrollTop(nextScrollTop: number) {
    pendingScrollTopRef.current = nextScrollTop;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(pendingScrollTopRef.current);
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    const requestKey = requestKeyRef.current + 1;
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError("");
    setScrollTop(0);
    retryTransientRequest(
      () => api.get(`/api/runs/${run.id}/logs${queryString({ stream, limit: 250, q: query.trim() })}`, { signal: controller.signal }),
      { signal: controller.signal, delays: RUN_WORKSPACE_REQUEST_RETRY_DELAYS_MS },
    )
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
      const payload = await retryTransientRequest(
        () => api.get(`/api/runs/${run.id}/logs${queryString({ stream, limit: 250, q: query.trim(), cursor })}`),
        { delays: RUN_WORKSPACE_REQUEST_RETRY_DELAYS_MS },
      );
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
          <input aria-label="Filter logs" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Filter logs" />
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
        <div className="terminal-scroll" onScroll={(event) => updateScrollTop(event.currentTarget.scrollTop)}>
          <div className="terminal-spacer" style={{ height: windowRows.totalHeight }}>
            <div className="terminal-window" style={{ transform: `translateY(${windowRows.offsetTop}px)` }}>
              {visibleLines.map((line) => (
                <div className="terminal-row" key={`${line.stream}-${line.line_number}-${line.created_at}`}>
                  <span className="terminal-ts">{formatTimestamp(line.timestamp)}</span>
                  <span className="terminal-line">{line.line_number}</span>
                  <span className="terminal-message">
                    {line.tokens.map((token, index) => (
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

export function RunEvidenceExplorer({
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
          <input aria-label="Search files" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search files" />
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
        {selected ? <EvidencePreview item={selected} rowsByObjectId={rowsByObjectId} run={run} /> : (
          <div className="empty">No artifacts logged for {run.name} yet.</div>
        )}
      </div>
    </section>
  );
}

function EvidencePreview({ item, rowsByObjectId, run }: { item: any; rowsByObjectId: Record<number, LoggedObjectRow[]>; run: RunSummary }) {
  if (item.artifact) {
    const resumeCode = item.artifact.type === "checkpoint" ? buildCheckpointResumeCode(item.artifact, run) : "";
    return (
      <div className="evidence-preview-stack">
        <div className="evidence-preview-head">
          <Package size={16} />
          <div>
            <h3>{item.artifact.name}</h3>
            <p>{item.artifact.type} · {item.artifact.step === null ? "no step" : `step ${item.artifact.step}`}</p>
          </div>
          {resumeCode ? (
            <button className="copy-button" onClick={() => void copyText(resumeCode)} type="button">
              <Copy size={13} /> Resume Code
            </button>
          ) : null}
        </div>
        <ArtifactBrowser artifacts={[item.artifact]} />
        <div className="evidence-quicklook">
          <div><span>Type</span><strong>{item.artifact.type}</strong></div>
          <div><span>Size</span><strong>{formatNumber(item.artifact.size_bytes, 0)} bytes</strong></div>
          <div><span>Step</span><strong>{item.artifact.step === null ? "none" : item.artifact.step}</strong></div>
          <div><span>URI</span><strong>{safeArtifactUri(item.artifact.uri)}</strong></div>
        </div>
        <pre className="evidence-code-preview">
          {JSON.stringify({
            name: item.artifact.name,
            type: item.artifact.type,
            step: item.artifact.step,
            size_bytes: item.artifact.size_bytes,
            uri: safeArtifactUri(item.artifact.uri),
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

export function RunSystemPanel({ metricRows, run }: { metricRows: RunMetricRow[]; run: RunSummary }) {
  const commit = metadataValue(run.metadata, "git_commit")
    ?? metadataValue(run.metadata, "commit")
    ?? nestedMetadataValue(run.metadata, ["_rlobs", "source", "git", "commit"]);
  const artifactTotal = Object.values(run.artifact_counts ?? {}).reduce((total, value) => (
    total + (typeof value === "number" && Number.isFinite(value) ? value : 0)
  ), 0);
  const identity = [
    ["Host", String(run.metadata.hostname ?? run.metadata.host ?? "not logged")],
    ["PID", String(run.metadata.pid ?? "not logged")],
    ["Commit", String(commit ?? "not logged")],
    ["Metric keys", String(metricRows.length)],
    ["Artifacts", String(artifactTotal)],
  ];
  const systemRows = metricRows
    .filter((row) => /^(system|gpu|cpu|mem|memory|disk|network|hardware)[/_]/i.test(row.key))
    .filter((row) => !/upload_health_unix_seconds$/.test(row.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  // Raw unix timestamps are meaningless in a stats table; surface the SDK
  // heartbeat as a relative time in the identity strip instead.
  const heartbeatRow = metricRows.find((row) => /upload_health_unix_seconds$/.test(row.key));
  const heartbeatAgeSeconds = heartbeatRow?.latest ? Math.max(0, Math.round(Date.now() / 1000 - heartbeatRow.latest)) : null;
  const heartbeatLabel = heartbeatAgeSeconds === null
    ? "not logged"
    : heartbeatAgeSeconds < 90
      ? `${heartbeatAgeSeconds}s ago`
      : heartbeatAgeSeconds < 5400
        ? `${Math.round(heartbeatAgeSeconds / 60)}m ago`
        : `${Math.round(heartbeatAgeSeconds / 3600)}h ago`;
  identity.push(["Last SDK heartbeat", heartbeatLabel]);
  const fmt = (value: number | null) => (value === null ? "—" : formatNumber(value, 3));
  return (
    <section className="run-workspace-panel system-panel">
      <div className="system-identity">
        {identity.map(([label, value]) => (
          <div className="system-identity-item" key={label}>
            <span className="eyebrow">{label}</span>
            <strong title={value}>{value}</strong>
          </div>
        ))}
      </div>
      {systemRows.length ? (
        <div className="card system-metrics-card">
          <div className="card-head">
            <span className="subtitle"><Server size={15} /> System telemetry</span>
            <span className="meta">{systemRows.length} signals</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Signal</th>
                  <th scope="col" style={{ textAlign: "right" }}>Latest</th>
                  <th scope="col" style={{ textAlign: "right" }}>Mean</th>
                  <th scope="col" style={{ textAlign: "right" }}>Min</th>
                  <th scope="col" style={{ textAlign: "right" }}>Max</th>
                  <th scope="col" style={{ textAlign: "right" }}>Points</th>
                </tr>
              </thead>
              <tbody>
                {systemRows.map((row) => (
                  <tr key={row.key}>
                    <td><span className="mono">{row.key}</span></td>
                    <td className="num" style={{ textAlign: "right" }}>{fmt(row.latest)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmt(row.mean)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmt(row.min)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmt(row.max)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{formatNumber(row.count, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty">
          <Server size={18} />
          No system or hardware telemetry has been logged for {run.name} yet.
        </div>
      )}
    </section>
  );
}

export function RunGraphPanel({ api, run }: { api: ApiLike; run: RunSummary }) {
  const [lineage, setLineage] = useState<RunLineage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const requestKeyRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestKey = requestKeyRef.current + 1;
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError("");
    setLineage(null);
    retryTransientRequest(
      () => api.get(`/api/runs/${run.id}/lineage`, { signal: controller.signal }),
      { signal: controller.signal, delays: RUN_WORKSPACE_REQUEST_RETRY_DELAYS_MS },
    )
      .then((payload) => {
        if (requestKey !== requestKeyRef.current) return;
        setLineage(payload as RunLineage);
      })
      .catch((caught) => {
        if (isAbortError(caught) || requestKey !== requestKeyRef.current) return;
        setLineage(null);
        setError(caught instanceof Error ? caught.message : "Unable to load lineage.");
      })
      .finally(() => {
        if (requestKey === requestKeyRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [api, refreshKey, run.id]);

  const visibleLineage = lineage?.run?.id === run.id ? lineage : null;
  const parent = visibleLineage?.parent;
  const children = Array.isArray(visibleLineage?.children) ? visibleLineage.children : [];
  const checkpoint = visibleLineage?.checkpoint_artifact;
  const hasGraph = Boolean(parent || children.length || checkpoint);
  return (
    <section className="run-workspace-panel graph-panel">
      <div className="panel-head compact-panel-head">
        <h2><GitBranch size={15} /> Lineage</h2>
        <button className="icon-button framed" aria-label="Refresh lineage" onClick={() => setRefreshKey((current) => current + 1)} type="button">
          <RefreshCw size={15} />
        </button>
      </div>
      {error ? <div className="empty compact-empty" role="alert">{error}</div> : null}
      {loading && !visibleLineage ? <div className="empty compact-empty">Loading lineage...</div> : null}
      {!loading && !error && !hasGraph ? (
        <div className="empty">
          <GitBranch size={18} />
          No forks or checkpoint lineage have been recorded for {run.name}.
        </div>
      ) : null}
      {hasGraph ? (
        <div className="lineage-layout" aria-live="polite">
          <div className="lineage-cards" role="list" aria-label="Lineage nodes">
            <LineageNode label="Parent" run={parent ?? null} empty="No parent run" />
            <LineageNode label="Selected" run={visibleLineage?.run ?? run} />
            <div className="lineage-node" role="listitem">
              <span>Checkpoint</span>
              {checkpoint ? (
                <>
                  <strong title={checkpoint.name}>{checkpoint.name}</strong>
                  <small>{checkpoint.step === null ? "no step" : `step ${checkpoint.step}`}</small>
                </>
              ) : <strong>No checkpoint</strong>}
            </div>
          </div>
          <div className="lineage-children">
            <div className="lineage-children-head">
              <h3>Children</h3>
              <span>{formatNumber(visibleLineage?.children_total ?? children.length, 0)} direct forks</span>
            </div>
            {children.length ? (
              <table className="table lineage-table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Status</th>
                    <th scope="col">Step</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {children.map((child) => (
                    <tr key={child.id}>
                      <td><strong title={child.name}>{child.name}</strong></td>
                      <td><span className={`pill ${statusTone(displayStatusForRun(child))}`}>{displayStatusForRun(child)}</span></td>
                      <td>{child.forked_from_step ?? "unknown"}</td>
                      <td>{formatTimestamp(child.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty compact-empty">No direct children yet.</div>}
            {visibleLineage?.has_more_children ? (
              <p className="lineage-truncated">Showing the latest {formatNumber(visibleLineage.limit ?? children.length, 0)} children.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function LineageNode({ empty, label, run }: { empty?: string; label: string; run: RunSummary | null }) {
  return (
    <div className="lineage-node" role="listitem">
      <span>{label}</span>
      {run ? (
        <>
          <strong title={run.name}>{run.name}</strong>
          <small>{run.project} · {displayStatusForRun(run)}</small>
        </>
      ) : <strong>{empty ?? "Not available"}</strong>}
    </div>
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
