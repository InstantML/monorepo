"use client";

import { Activity, ChevronDown, ChevronRight, Copy, GitBranch, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, isAbortError, queryString, retryTransientRequest } from "../../../src/api.js";
import { formatNumber } from "../../../src/state.js";
import type { components } from "../../../src/types/api.generated";
import type { RunSummary } from "../../dashboard-types";
import { PageHead } from "../ui/page-head";
import { relativeTime } from "../ui/relative-time";

type TraceSummary = components["schemas"]["TraceSummaryItem"];
type TraceListResponse = components["schemas"]["TraceListResponse"];
type TraceDetailResponse = components["schemas"]["TraceDetailResponse"];
type TraceChildrenResponse = components["schemas"]["TraceChildrenResponse"];
type TraceSpan = components["schemas"]["TraceSpanItem"];

type Props = {
  api: {
    get: <T = unknown>(path: string, options?: { signal?: AbortSignal }) => Promise<T>;
  };
  onSelectRun?: (runId: string) => void;
  primaryRun: RunSummary | null;
  project: string;
  sortedRuns: RunSummary[];
};

type ChildWindow = {
  spans: TraceSpan[];
  nextCursor: string | null;
  childCount: number;
  loading: boolean;
  error: string;
};

const TRACE_PAGE_LIMIT = 50;
const TRACE_SPAN_LIMIT = 500;
const TRACE_CHILD_LIMIT = 100;
const statusOptions = ["", "running", "ok", "error", "cancelled", "interrupted"];
const kindOptions = ["", "rollout", "env_step", "model", "tool", "retrieval", "reward", "evaluator", "dataset", "checkpoint", "artifact", "system", "custom"];

export function TracesTabPane({ api, onSelectRun = () => {}, primaryRun, project, sortedRuns }: Props) {
  const initialUrl = useMemo(() => traceUrlState(), []);
  const [runFilter, setRunFilter] = useState(initialUrl.runId || primaryRun?.id || "");
  const [statusFilter, setStatusFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [query, setQuery] = useState("");
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [selectedRunId, setSelectedRunId] = useState(initialUrl.runId || "");
  const [selectedTraceId, setSelectedTraceId] = useState(initialUrl.traceId || "");
  const [selectedSpanId, setSelectedSpanId] = useState(initialUrl.spanId || "");
  const selectedTraceIdRef = useRef(initialUrl.traceId || "");
  const listRequestRef = useRef(0);
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ChildWindow>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const runOptions = useMemo(() => sortedRuns.slice(0, 500).map((run) => ({ id: run.id, label: `${run.name} · ${run.project}` })), [sortedRuns]);
  const selectedTrace = useMemo(
    () => traces.find((trace) => trace.trace_id === selectedTraceId && trace.run_id === selectedRunId) ?? null,
    [selectedRunId, selectedTraceId, traces],
  );
  const selectedSpan = useMemo(() => {
    const all = detail ? flattenDisplayedSpans(detail.spans, childrenByParent) : [];
    return all.find((span) => span.span_id === selectedSpanId) ?? all[0] ?? null;
  }, [childrenByParent, detail, selectedSpanId]);

  useEffect(() => {
    selectedTraceIdRef.current = selectedTraceId;
  }, [selectedTraceId]);

  const loadTraces = useCallback(async (cursor = "") => {
    if (!project && !runFilter) {
      setTraces([]);
      setNextCursor(null);
      setListError("");
      return;
    }
    const controller = new AbortController();
    const requestId = ++listRequestRef.current;
    setListLoading(true);
    setListError("");
    try {
      const payload = await retryTransientRequest(
        () => api.get<TraceListResponse>(`/api/traces${queryString({
          project: runFilter ? undefined : project,
          run_id: runFilter,
          status: statusFilter,
          kind: kindFilter,
          q: query.trim(),
          limit: TRACE_PAGE_LIMIT,
          cursor,
        })}`, { signal: controller.signal }),
        { signal: controller.signal },
      );
      if (requestId !== listRequestRef.current) return;
      const rows = payload.traces ?? [];
      setTraces((current) => cursor ? [...current, ...rows] : rows);
      setNextCursor(payload.next_cursor ?? null);
      if (!selectedTraceIdRef.current && rows[0]) {
        selectTrace(rows[0], false);
      }
    } catch (error) {
      if (requestId === listRequestRef.current && !isAbortError(error)) {
        setListError(error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : "Unable to load traces.");
      }
    } finally {
      if (requestId === listRequestRef.current) setListLoading(false);
    }
  }, [api, kindFilter, project, query, runFilter, statusFilter]);

  useEffect(() => {
    void loadTraces("");
  }, [loadTraces]);

  useEffect(() => {
    if (!selectedRunId || !selectedTraceId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    async function loadDetail() {
      setDetailLoading(true);
      setDetailError("");
      setChildrenByParent({});
      try {
        const payload = await retryTransientRequest(
          () => api.get<TraceDetailResponse>(
            `/api/runs/${encodeURIComponent(selectedRunId)}/traces/${encodeURIComponent(selectedTraceId)}${queryString({ span_limit: TRACE_SPAN_LIMIT })}`,
            { signal: controller.signal },
          ),
          { signal: controller.signal },
        );
        if (cancelled) return;
        setDetail(payload);
        const first = payload.spans?.[0]?.span_id ?? "";
        setSelectedSpanId((current) => current || first);
        setExpanded(new Set());
      } catch (error) {
        if (!cancelled && !isAbortError(error)) {
          setDetail(null);
          setDetailError(error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : "Unable to load trace detail.");
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }
    void loadDetail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, selectedRunId, selectedTraceId]);

  function selectTrace(trace: TraceSummary, updateUrl = true) {
    setSelectedRunId(trace.run_id);
    setSelectedTraceId(trace.trace_id);
    setSelectedSpanId(trace.root_span_id);
    setExpanded(new Set());
    onSelectRun(trace.run_id);
    if (updateUrl) replaceTraceUrl(trace.run_id, trace.trace_id, trace.root_span_id);
  }

  async function loadChildren(parentSpanId: string, cursor = "") {
    if (!selectedRunId || !selectedTraceId) return;
    setChildrenByParent((current) => ({
      ...current,
      [parentSpanId]: {
        spans: cursor ? current[parentSpanId]?.spans ?? [] : current[parentSpanId]?.spans ?? [],
        nextCursor: current[parentSpanId]?.nextCursor ?? null,
        childCount: current[parentSpanId]?.childCount ?? 0,
        loading: true,
        error: "",
      },
    }));
    try {
      const payload = await api.get<TraceChildrenResponse>(
        `/api/runs/${encodeURIComponent(selectedRunId)}/traces/${encodeURIComponent(selectedTraceId)}/spans${queryString({
          parent_span_id: parentSpanId,
          limit: TRACE_CHILD_LIMIT,
          cursor,
        })}`,
      );
      setChildrenByParent((current) => {
        const previous = current[parentSpanId]?.spans ?? [];
        const spans = cursor ? [...previous, ...(payload.spans ?? [])] : payload.spans ?? [];
        return {
          ...current,
          [parentSpanId]: {
            spans,
            nextCursor: payload.next_cursor ?? null,
            childCount: payload.child_count ?? spans.length,
            loading: false,
            error: "",
          },
        };
      });
    } catch (error) {
      setChildrenByParent((current) => ({
        ...current,
        [parentSpanId]: {
          spans: current[parentSpanId]?.spans ?? [],
          nextCursor: current[parentSpanId]?.nextCursor ?? null,
          childCount: current[parentSpanId]?.childCount ?? 0,
          loading: false,
          error: error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : "Unable to load child spans.",
        },
      }));
    }
  }

  function toggleSpan(span: TraceSpan) {
    if (!span.child_count) {
      setSelectedSpanId(span.span_id);
      replaceTraceUrl(selectedRunId, selectedTraceId, span.span_id);
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(span.span_id)) next.delete(span.span_id);
      else next.add(span.span_id);
      return next;
    });
    setSelectedSpanId(span.span_id);
    replaceTraceUrl(selectedRunId, selectedTraceId, span.span_id);
    if (!childrenByParent[span.span_id]) void loadChildren(span.span_id);
  }

  return (
    <>
      <PageHead
        title="Traces"
        lede={project || runFilter ? `${traces.length}${nextCursor ? "+" : ""} loaded` : "Choose a project or run"}
      />
      <div className="traces-workspace">
        <section className="panel traces-list-panel">
          <div className="panel-head">
            <h2><Activity size={15} /> Trace summaries <span>({traces.length})</span></h2>
            <div className="panel-controls">
              <button className="icon-button framed" type="button" aria-label="Refresh traces" onClick={() => loadTraces("")} disabled={listLoading}>
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          <div className="trace-filter-row">
            <label>
              <span>Run</span>
              <select value={runFilter} onChange={(event) => { setRunFilter(event.target.value); setSelectedTraceId(""); }}>
                <option value="">{project ? `Project: ${project}` : "Select run"}</option>
                {runOptions.map((run) => <option key={run.id} value={run.id}>{run.label}</option>)}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                {statusOptions.map((status) => <option key={status || "all"} value={status}>{status || "All"}</option>)}
              </select>
            </label>
            <label>
              <span>Kind</span>
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                {kindOptions.map((kind) => <option key={kind || "all"} value={kind}>{kind || "All"}</option>)}
              </select>
            </label>
            <label className="trace-search">
              <span>Search</span>
              <span><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} /></span>
            </label>
          </div>
          {listError ? <div className="status-strip">{listError}</div> : null}
          {!project && !runFilter ? <div className="empty">Select a project or run to browse traces.</div> : null}
          <div className="trace-table" role="table" aria-label="Trace summaries">
            {traces.map((trace) => (
              <button
                className={`trace-row ${trace.trace_id === selectedTraceId && trace.run_id === selectedRunId ? "active" : ""}`}
                key={`${trace.run_id}:${trace.trace_id}`}
                onClick={() => selectTrace(trace)}
                type="button"
                role="row"
              >
                <span className={`trace-status ${trace.status}`}>{trace.status}</span>
                <span className="trace-row-main">
                  <strong>{trace.root_name}</strong>
                  <small>{trace.run_name} · {trace.kinds.slice(0, 3).join(", ") || "custom"}</small>
                </span>
                <span className="trace-row-meta">{formatNumber(trace.span_count, 0)} spans</span>
                <span className="trace-row-meta">{formatDuration(trace.duration_ms)}</span>
                <span className="trace-row-meta">{relativeTime(trace.updated_at)}</span>
              </button>
            ))}
          </div>
          {listLoading ? <div className="empty">Loading traces...</div> : null}
          {!listLoading && (project || runFilter) ? (!traces.length && !listError ? <div className="empty">No traces match the current filters.</div> : null) : null}
          {nextCursor ? <button className="secondary-button trace-load-more" type="button" onClick={() => loadTraces(nextCursor)} disabled={listLoading}>Load more</button> : null}
        </section>

        <section className="panel traces-detail-panel">
          <div className="panel-head">
            <h2><GitBranch size={15} /> Trace tree</h2>
            {selectedTrace ? (
              <button className="icon-button framed" type="button" aria-label="Copy trace ID" onClick={() => copyText(selectedTrace.trace_id)}>
                <Copy size={15} />
              </button>
            ) : null}
          </div>
          {detailLoading ? <div className="empty">Loading trace detail...</div> : null}
          {detailError ? <div className="status-strip">{detailError}</div> : null}
          {detail ? (
            <div className="trace-detail-grid">
              <div className="trace-tree" role="tree" aria-label="Trace spans">
                <TraceTree
                  childrenByParent={childrenByParent}
                  detail={detail}
                  expanded={expanded}
                  onLoadMoreChildren={loadChildren}
                  onToggle={toggleSpan}
                  selectedSpanId={selectedSpanId}
                />
                {detail.truncated.partial_tree ? <div className="trace-truncation">Partial tree · {formatNumber(detail.trace.total_span_count, 0)} total spans</div> : null}
              </div>
              <TraceInspector span={selectedSpan} summary={selectedTrace} />
            </div>
          ) : !detailLoading && !detailError ? <div className="empty">Select a trace to inspect its spans.</div> : null}
        </section>
      </div>
    </>
  );
}

function TraceTree({
  childrenByParent,
  detail,
  expanded,
  onLoadMoreChildren,
  onToggle,
  selectedSpanId,
}: {
  childrenByParent: Record<string, ChildWindow>;
  detail: TraceDetailResponse;
  expanded: Set<string>;
  onLoadMoreChildren: (parentSpanId: string, cursor?: string) => void;
  onToggle: (span: TraceSpan) => void;
  selectedSpanId: string;
}) {
  const roots = rootSpans(detail.spans);
  return (
    <div>
      {roots.map((span) => (
        <TraceTreeNode
          childrenByParent={childrenByParent}
          expanded={expanded}
          key={span.span_id}
          level={1}
          onLoadMoreChildren={onLoadMoreChildren}
          onToggle={onToggle}
          selectedSpanId={selectedSpanId}
          span={span}
        />
      ))}
    </div>
  );
}

function TraceTreeNode({
  childrenByParent,
  expanded,
  level,
  onLoadMoreChildren,
  onToggle,
  selectedSpanId,
  span,
}: {
  childrenByParent: Record<string, ChildWindow>;
  expanded: Set<string>;
  level: number;
  onLoadMoreChildren: (parentSpanId: string, cursor?: string) => void;
  onToggle: (span: TraceSpan) => void;
  selectedSpanId: string;
  span: TraceSpan;
}) {
  const childWindow = childrenByParent[span.span_id];
  const isExpanded = expanded.has(span.span_id);
  const children = childWindow?.spans ?? [];
  const hasChildren = span.child_count > 0;
  return (
    <div className="trace-node" role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined}>
      <button className={`trace-node-button ${selectedSpanId === span.span_id ? "active" : ""}`} style={{ paddingLeft: `${level * 14}px` }} type="button" onClick={() => onToggle(span)}>
        {hasChildren ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="trace-node-spacer" />}
        <span className={`trace-status ${span.status}`}>{span.status}</span>
        <span className="trace-node-name">{span.name}</span>
        <span className="trace-node-kind">{span.kind}</span>
        <span className="trace-node-duration">{formatDuration(span.duration_ms)}</span>
      </button>
      {isExpanded ? (
        <div role="group">
          {childWindow?.loading ? <div className="trace-child-state" style={{ paddingLeft: `${(level + 1) * 14}px` }}>Loading child spans...</div> : null}
          {childWindow?.error ? <div className="trace-child-state error" style={{ paddingLeft: `${(level + 1) * 14}px` }}>{childWindow.error}</div> : null}
          {children.map((child) => (
            <TraceTreeNode
              childrenByParent={childrenByParent}
              expanded={expanded}
              key={child.span_id}
              level={level + 1}
              onLoadMoreChildren={onLoadMoreChildren}
              onToggle={onToggle}
              selectedSpanId={selectedSpanId}
              span={child}
            />
          ))}
          {childWindow?.nextCursor ? (
            <button className="trace-child-state trace-load-children" style={{ paddingLeft: `${(level + 1) * 14}px` }} type="button" onClick={() => onLoadMoreChildren(span.span_id, childWindow.nextCursor ?? "")}>
              Load more child spans
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TraceInspector({ span, summary }: { span: TraceSpan | null; summary: TraceSummary | null }) {
  if (!span) return <aside className="trace-inspector empty">Select a span.</aside>;
  return (
    <aside className="trace-inspector">
      <div className="trace-inspector-head">
        <span className={`trace-status ${span.status}`}>{span.status}</span>
        <strong>{span.name}</strong>
        <small>{span.kind}{summary ? ` · ${summary.run_name}` : ""}</small>
      </div>
      <dl className="trace-kv">
        <div><dt>Span ID</dt><dd><code>{span.span_id}</code></dd></div>
        <div><dt>Trace ID</dt><dd><code>{span.trace_id}</code></dd></div>
        <div><dt>Duration</dt><dd>{formatDuration(span.duration_ms)}</dd></div>
        <div><dt>Step</dt><dd>{span.step ?? "-"}</dd></div>
        <div><dt>Children</dt><dd>{formatNumber(span.child_count, 0)}</dd></div>
      </dl>
      <PreviewBlock title="Input" value={span.input_preview} />
      <PreviewBlock title="Output" value={span.output_preview} />
      <PreviewBlock title="Error" value={span.error_preview || span.error_type || ""} tone="bad" />
      <JsonBlock title="Attributes" value={span.attributes} />
      <JsonBlock title="Metrics" value={span.metrics} />
    </aside>
  );
}

function PreviewBlock({ title, value, tone = "" }: { title: string; value: string; tone?: string }) {
  if (!value) return null;
  return (
    <div className={`trace-preview ${tone}`}>
      <strong>{title}</strong>
      <pre>{value}</pre>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const text = JSON.stringify(value ?? {}, null, 2);
  if (text === "{}") return null;
  return (
    <div className="trace-preview">
      <strong>{title}</strong>
      <pre>{text}</pre>
    </div>
  );
}

function rootSpans(spans: TraceSpan[]) {
  const roots = spans.filter((span) => !span.parent_span_id);
  return roots.length ? roots : spans;
}

function flattenDisplayedSpans(spans: TraceSpan[], childrenByParent: Record<string, ChildWindow>) {
  const out: TraceSpan[] = [];
  const visit = (span: TraceSpan) => {
    out.push(span);
    for (const child of childrenByParent[span.span_id]?.spans ?? []) visit(child);
  };
  for (const span of rootSpans(spans)) visit(span);
  return out;
}

function formatDuration(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function traceUrlState() {
  if (typeof window === "undefined") return { runId: "", traceId: "", spanId: "" };
  const params = new URLSearchParams(window.location.search);
  return {
    runId: params.get("run_id") ?? "",
    traceId: params.get("trace_id") ?? "",
    spanId: params.get("span_id") ?? "",
  };
}

function replaceTraceUrl(runId: string, traceId: string, spanId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set("run_id", runId);
  else url.searchParams.delete("run_id");
  if (traceId) url.searchParams.set("trace_id", traceId);
  else url.searchParams.delete("trace_id");
  if (spanId) url.searchParams.set("span_id", spanId);
  else url.searchParams.delete("span_id");
  window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
}

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // IDs are visible and selectable when clipboard permission is unavailable.
  }
}
