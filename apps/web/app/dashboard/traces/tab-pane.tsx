"use client";

import { Activity, ChevronDown, ChevronRight, Copy, GitBranch, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { ApiError, isAbortError, queryString, retryTransientRequest } from "../../../src/api.js";
import { formatNumber } from "../../../src/state.js";
import type { components } from "../../../src/types/api.generated";
import type { RunSummary } from "../../dashboard-types";
import { formatDuration } from "../ui/duration";
import { PageHead } from "../ui/page-head";
import { relativeTime } from "../ui/relative-time";
import { CustomSelect, type SelectOption } from "../ui/select";

type TraceSummary = components["schemas"]["TraceSummaryItem"];
type TraceListResponse = components["schemas"]["TraceListResponse"];
type TraceDetailResponse = components["schemas"]["TraceDetailResponse"];
type TraceChildrenResponse = components["schemas"]["TraceChildrenResponse"];
type TraceSpan = components["schemas"]["TraceSpanItem"];
type TraceInspectorSummary = Pick<TraceSummary, "run_name">;

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
const statusOptions: SelectOption[] = ["", "running", "ok", "error", "cancelled", "interrupted"].map((status) => ({
  value: status,
  label: status || "All",
}));
const kindOptions: SelectOption[] = ["", "rollout", "env_step", "model", "tool", "retrieval", "reward", "evaluator", "dataset", "preprocessing", "postprocessing", "checkpoint", "artifact", "system", "custom"].map((kind) => ({
  value: kind,
  label: kind || "All",
}));
const timeRangeOptions: SelectOption[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];
const EMPTY_CHILD_WINDOW: ChildWindow = {
  spans: [],
  nextCursor: null,
  childCount: 0,
  loading: false,
  error: "",
};

export function TracesTabPane({ api, onSelectRun = () => {}, primaryRun, project, sortedRuns }: Props) {
  const [runFilter, setRunFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [timeRange, setTimeRange] = useState("7d");
  const [query, setQuery] = useState("");
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [selectedSpanId, setSelectedSpanId] = useState("");
  const selectedTraceIdRef = useRef("");
  const selectedTraceKeyRef = useRef("");
  const childrenByParentRef = useRef<Record<string, ChildWindow>>({});
  const defaultRunAppliedRef = useRef(false);
  const resolvingSpanRef = useRef("");
  const urlStateHydratedRef = useRef(false);
  const [urlStateReady, setUrlStateReady] = useState(false);
  const listControllerRef = useRef<AbortController | null>(null);
  const listRequestRef = useRef(0);
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ChildWindow>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const debouncedQuery = useDebouncedValue(query, 300);

  const runOptions = useMemo(() => sortedRuns.slice(0, 500).map((run) => ({ id: run.id, label: `${run.name} · ${run.project}` })), [sortedRuns]);
  const runFilterOptions = useMemo<SelectOption[]>(() => {
    const hasRun = !runFilter || runOptions.some((run) => run.id === runFilter);
    return [
      { value: "", label: project ? `Project: ${project}` : "Select run" },
      ...(hasRun ? [] : [{ value: runFilter, label: `Run ${runFilter.slice(0, 8)}` }]),
      ...runOptions.map((run) => ({ value: run.id, label: run.label })),
    ];
  }, [project, runFilter, runOptions]);
  const selectedTrace = useMemo(
    () => traces.find((trace) => trace.trace_id === selectedTraceId && trace.run_id === selectedRunId) ?? null,
    [selectedRunId, selectedTraceId, traces],
  );
  const selectedDetail = detail?.trace.run_id === selectedRunId && detail.trace.trace_id === selectedTraceId ? detail : null;
  const inspectorSummary = useMemo<TraceInspectorSummary | null>(
    () => selectedTrace ? { run_name: selectedTrace.run_name } : selectedDetail ? { run_name: selectedDetail.trace.run_name } : null,
    [selectedDetail, selectedTrace],
  );
  const traceIdForActions = selectedTrace?.trace_id ?? selectedDetail?.trace.trace_id ?? selectedTraceId;
  const displayedSpanIndex = useMemo(
    () => selectedDetail ? indexDisplayedSpans(selectedDetail.spans, childrenByParent) : { first: null, byId: new Map<string, TraceSpan>(), ordered: [] as TraceSpan[] },
    [childrenByParent, selectedDetail],
  );
  const selectedSpan = selectedSpanId ? displayedSpanIndex.byId.get(selectedSpanId) ?? null : displayedSpanIndex.first;
  const selectedSpanLoaded = selectedSpanId ? displayedSpanIndex.byId.has(selectedSpanId) : true;
  const loadedSpanCount = displayedSpanIndex.byId.size;

  useEffect(() => {
    selectedTraceIdRef.current = selectedTraceId;
  }, [selectedTraceId]);

  useEffect(() => {
    selectedTraceKeyRef.current = traceKey(selectedRunId, selectedTraceId);
  }, [selectedRunId, selectedTraceId]);

  useEffect(() => {
    childrenByParentRef.current = childrenByParent;
  }, [childrenByParent]);

  useEffect(() => {
    const applyUrlState = () => {
      const next = traceUrlState();
      const hasCompleteTraceState = Boolean(next.runId && next.traceId);
      const hasBrokenTraceState = Boolean((next.traceId || next.spanId) && !hasCompleteTraceState);
      urlStateHydratedRef.current = Boolean(next.runId || hasCompleteTraceState);
      setStatusFilter(next.status);
      setKindFilter(next.kind);
      setTimeRange(next.timeRange);
      setQuery(next.q);
      setRunFilter(next.runId);
      if (!hasCompleteTraceState || hasBrokenTraceState) {
        setSelectedRunId("");
        setSelectedTraceId("");
        setSelectedSpanId("");
        selectedTraceIdRef.current = "";
        selectedTraceKeyRef.current = "";
        if (hasBrokenTraceState) replaceTraceUrl(next.runId, "", "", next);
        setUrlStateReady(true);
        return;
      }
      setSelectedRunId(next.runId);
      setSelectedTraceId(next.traceId);
      setSelectedSpanId(next.spanId);
      selectedTraceIdRef.current = next.traceId;
      selectedTraceKeyRef.current = traceKey(next.runId, next.traceId);
      setUrlStateReady(true);
    };
    applyUrlState();
    window.addEventListener("popstate", applyUrlState);
    return () => window.removeEventListener("popstate", applyUrlState);
  }, []);

  useEffect(() => {
    if (!urlStateReady) return;
    if (urlStateHydratedRef.current || defaultRunAppliedRef.current || runFilter || !primaryRun?.id) return;
    defaultRunAppliedRef.current = true;
    setRunFilter(primaryRun.id);
  }, [primaryRun?.id, runFilter, urlStateReady]);

  useEffect(() => {
    if (!urlStateReady) return;
    replaceTraceUrl(selectedRunId || runFilter, selectedTraceId, selectedSpanId, {
      kind: kindFilter,
      q: debouncedQuery.trim(),
      status: statusFilter,
      timeRange,
    });
  }, [debouncedQuery, kindFilter, runFilter, selectedRunId, selectedSpanId, selectedTraceId, statusFilter, timeRange, urlStateReady]);

  const loadTraces = useCallback(async (cursor = "") => {
    listControllerRef.current?.abort();
    if (!urlStateReady) {
      listRequestRef.current += 1;
      setListLoading(false);
      return;
    }
    if (!project && !runFilter) {
      listRequestRef.current += 1;
      setTraces([]);
      setNextCursor(null);
      setListError("");
      setListLoading(false);
      return;
    }
    const controller = new AbortController();
    listControllerRef.current = controller;
    const requestId = ++listRequestRef.current;
    setListLoading(true);
    setListError("");
    try {
      const payload = await retryTransientRequest(
        () => api.get<TraceListResponse>(`/api/traces${queryString(traceListQueryParams({
          project,
          runFilter,
          statusFilter,
          kindFilter,
          timeRange,
          query: debouncedQuery.trim(),
          limit: TRACE_PAGE_LIMIT,
          cursor,
        }))}`, { signal: controller.signal }),
        { signal: controller.signal },
      );
      if (requestId !== listRequestRef.current) return;
      const rows = payload.traces ?? [];
      setTraces((current) => cursor ? [...current, ...rows] : rows);
      setNextCursor(payload.next_cursor ?? null);
      if (!cursor && selectedTraceIdRef.current && rows.length === 0) {
        clearSelectedTrace(runFilter);
      } else if (!selectedTraceIdRef.current && rows[0]) {
        selectTrace(rows[0], false);
      }
    } catch (error) {
      if (requestId === listRequestRef.current && !isAbortError(error)) {
        setListError(error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : "Unable to load traces.");
      }
    } finally {
      if (requestId === listRequestRef.current) setListLoading(false);
      if (listControllerRef.current === controller) listControllerRef.current = null;
    }
  }, [api, debouncedQuery, kindFilter, project, runFilter, statusFilter, timeRange, urlStateReady]);

  useEffect(() => {
    void loadTraces("");
    return () => listControllerRef.current?.abort();
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
      setDetail(null);
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
    selectedTraceIdRef.current = trace.trace_id;
    selectedTraceKeyRef.current = traceKey(trace.run_id, trace.trace_id);
    setExpanded(new Set());
    onSelectRun(trace.run_id);
    if (updateUrl) replaceTraceUrl(trace.run_id, trace.trace_id, trace.root_span_id, currentTraceUrlFilters(statusFilter, kindFilter, timeRange, debouncedQuery));
  }

  function clearSelectedTrace(nextRunId = runFilter) {
    setSelectedRunId("");
    setSelectedTraceId("");
    setSelectedSpanId("");
    selectedTraceIdRef.current = "";
    selectedTraceKeyRef.current = "";
    setExpanded(new Set());
    setChildrenByParent({});
    setDetail(null);
    replaceTraceUrl(nextRunId, "", "", currentTraceUrlFilters(statusFilter, kindFilter, timeRange, debouncedQuery));
  }

  const loadChildren = useCallback(async (parentSpanId: string, cursor = ""): Promise<TraceChildrenResponse | null> => {
    if (!selectedRunId || !selectedTraceId) return null;
    const requestTraceKey = traceKey(selectedRunId, selectedTraceId);
    setChildrenByParent((current) => patchChildWindow(current, parentSpanId, { loading: true, error: "" }));
    try {
      const payload = await retryTransientRequest(
        () => api.get<TraceChildrenResponse>(
          `/api/runs/${encodeURIComponent(selectedRunId)}/traces/${encodeURIComponent(selectedTraceId)}/spans${queryString({
            parent_span_id: parentSpanId,
            limit: TRACE_CHILD_LIMIT,
            cursor,
          })}`,
        ),
      );
      if (selectedTraceKeyRef.current !== requestTraceKey) return null;
      setChildrenByParent((current) => {
        const previous = current[parentSpanId] ?? EMPTY_CHILD_WINDOW;
        const spans = cursor ? [...previous.spans, ...(payload.spans ?? [])] : payload.spans ?? [];
        return patchChildWindow(current, parentSpanId, {
          spans,
          nextCursor: payload.next_cursor ?? null,
          childCount: payload.child_count ?? spans.length,
          loading: false,
          error: "",
        });
      });
      return payload;
    } catch (error) {
      if (selectedTraceKeyRef.current !== requestTraceKey) return null;
      setChildrenByParent((current) => patchChildWindow(current, parentSpanId, {
        loading: false,
        error: error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : "Unable to load child spans.",
      }));
      return null;
    }
  }, [api, selectedRunId, selectedTraceId]);

  useEffect(() => {
    if (!selectedDetail || !selectedSpanId || selectedSpanLoaded) return;
    const detailForResolve = selectedDetail;
    const requestKey = `${traceKey(selectedRunId, selectedTraceId)}:${selectedSpanId}`;
    if (resolvingSpanRef.current === requestKey) return;
    resolvingSpanRef.current = requestKey;
    let cancelled = false;
    async function resolveLinkedSpan() {
      const queue = rootSpans(detailForResolve.spans);
      const queued = new Set(queue.map((span) => span.span_id));
      const expandedIds = new Set(expanded);
      let fetches = 0;
      while (!cancelled && queue.length && fetches < 50) {
        const parent = queue.shift();
        if (!parent || parent.child_count <= 0) continue;
        expandedIds.add(parent.span_id);
        setExpanded(new Set(expandedIds));
        let window = childrenByParentRef.current[parent.span_id];
        let cursor: string | null = window?.nextCursor ?? "";
        if (!window || (!window.spans.length && !window.loading)) {
          const payload = await loadChildren(parent.span_id);
          fetches += 1;
          window = {
            spans: payload?.spans ?? [],
            nextCursor: payload?.next_cursor ?? null,
            childCount: payload?.child_count ?? 0,
            loading: false,
            error: "",
          };
        }
        for (const child of window.spans) {
          if (child.span_id === selectedSpanId) {
            setExpanded(new Set(expandedIds));
            return;
          }
          if (!queued.has(child.span_id)) {
            queued.add(child.span_id);
            queue.push(child);
          }
        }
        while (!cancelled && cursor && fetches < 50) {
          const payload = await loadChildren(parent.span_id, cursor);
          fetches += 1;
          cursor = payload?.next_cursor ?? null;
          for (const child of payload?.spans ?? []) {
            if (child.span_id === selectedSpanId) {
              setExpanded(new Set(expandedIds));
              return;
            }
            if (!queued.has(child.span_id)) {
              queued.add(child.span_id);
              queue.push(child);
            }
          }
        }
      }
    }
    void resolveLinkedSpan().finally(() => {
      if (resolvingSpanRef.current === requestKey) resolvingSpanRef.current = "";
    });
    return () => {
      cancelled = true;
    };
  }, [loadChildren, selectedDetail, selectedRunId, selectedSpanId, selectedSpanLoaded, selectedTraceId]);

  function selectSpan(span: TraceSpan) {
    setSelectedSpanId(span.span_id);
    replaceTraceUrl(selectedRunId, selectedTraceId, span.span_id, currentTraceUrlFilters(statusFilter, kindFilter, timeRange, debouncedQuery));
  }

  function collapseSpan(spanId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      next.delete(spanId);
      return next;
    });
  }

  function toggleSpan(span: TraceSpan) {
    if (!span.child_count) {
      selectSpan(span);
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(span.span_id)) next.delete(span.span_id);
      else next.add(span.span_id);
      return next;
    });
    selectSpan(span);
    const childWindow = childrenByParent[span.span_id];
    if (!childWindow || (childWindow.error && !childWindow.spans.length)) void loadChildren(span.span_id);
  }

  function handleTraceRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = event.key === "ArrowDown" ? Math.min(index + 1, traces.length - 1)
      : event.key === "ArrowUp" ? Math.max(index - 1, 0)
        : event.key === "Home" ? 0
          : event.key === "End" ? traces.length - 1
            : -1;
    if (nextIndex < 0 || nextIndex === index) return;
    event.preventDefault();
    const nextTrace = traces[nextIndex];
    if (!nextTrace) return;
    selectTrace(nextTrace);
    requestAnimationFrame(() => {
      document.querySelectorAll<HTMLButtonElement>(".trace-row")[nextIndex]?.focus();
    });
  }

  function handleTreeKeyDown(event: KeyboardEvent<HTMLButtonElement>, span: TraceSpan) {
    const visible = displayedSpanIndex.ordered;
    const index = visible.findIndex((item) => item.span_id === span.span_id);
    const focusSpan = (next: TraceSpan | undefined) => {
      if (!next) return;
      event.preventDefault();
      selectSpan(next);
      requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>(`[data-trace-span-id="${next.span_id}"]`)?.focus();
      });
    };
    if (event.key === "ArrowDown") focusSpan(visible[Math.min(index + 1, visible.length - 1)]);
    else if (event.key === "ArrowUp") focusSpan(visible[Math.max(index - 1, 0)]);
    else if (event.key === "Home") focusSpan(visible[0]);
    else if (event.key === "End") focusSpan(visible[visible.length - 1]);
    else if (event.key === "ArrowRight" && span.child_count > 0) {
      event.preventDefault();
      if (!expanded.has(span.span_id)) toggleSpan(span);
      else focusSpan(visible[index + 1]);
    } else if (event.key === "ArrowLeft" && span.child_count > 0 && expanded.has(span.span_id)) {
      event.preventDefault();
      collapseSpan(span.span_id);
      selectSpan(span);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSpan(span);
    }
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
            <div className="trace-filter-control">
              <span>Run</span>
              <CustomSelect
                id="trace-run-filter"
                label="Run"
                labelClassName="visually-hidden"
                onChange={(value) => {
                  setRunFilter(value);
                  clearSelectedTrace(value);
                }}
                options={runFilterOptions}
                value={runFilter}
              />
            </div>
            <div className="trace-filter-control">
              <span>Status</span>
              <CustomSelect
                id="trace-status-filter"
                label="Status"
                labelClassName="visually-hidden"
                onChange={(value) => {
                  setStatusFilter(value);
                }}
                options={statusOptions}
                value={statusFilter}
              />
            </div>
            <div className="trace-filter-control">
              <span>Kind</span>
              <CustomSelect
                id="trace-kind-filter"
                label="Kind"
                labelClassName="visually-hidden"
                onChange={(value) => {
                  setKindFilter(value);
                }}
                options={kindOptions}
                value={kindFilter}
              />
            </div>
            <div className="trace-filter-control">
              <span>Time</span>
              <CustomSelect
                id="trace-time-filter"
                label="Time"
                labelClassName="visually-hidden"
                onChange={setTimeRange}
                options={timeRangeOptions}
                value={timeRange}
              />
            </div>
            <label className="trace-search">
              <span>Search</span>
              <span><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} /></span>
            </label>
          </div>
          {listError ? <div className="status-strip">{listError}</div> : null}
          {!project && !runFilter ? <div className="empty">Select a project or run to browse traces.</div> : null}
          <div className="trace-table" role="listbox" aria-label="Trace summaries">
            {traces.map((trace, index) => (
              <button
                aria-selected={trace.trace_id === selectedTraceId && trace.run_id === selectedRunId}
                className={`trace-row ${trace.trace_id === selectedTraceId && trace.run_id === selectedRunId ? "active" : ""}`}
                key={`${trace.run_id}:${trace.trace_id}`}
                onKeyDown={(event) => handleTraceRowKeyDown(event, index)}
                onClick={() => selectTrace(trace)}
                role="option"
                tabIndex={trace.trace_id === selectedTraceId && trace.run_id === selectedRunId ? 0 : !selectedTraceId && index === 0 ? 0 : -1}
                type="button"
              >
                <span className={`trace-status ${trace.status}`}>{trace.status}</span>
                <span className="trace-row-main">
                  <strong>{trace.root_name}</strong>
                  <small>{trace.run_name} · {trace.kinds.slice(0, 3).join(", ") || "custom"}</small>
                </span>
                <span className="trace-row-meta">{formatNumber(trace.span_count, 0)} spans</span>
                <span className="trace-row-meta">{formatDuration(trace.duration_ms)}</span>
                <span className="trace-row-meta" title={absoluteTimeTitle(trace.updated_at)}>{relativeTime(trace.updated_at)}</span>
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
            {traceIdForActions ? (
              <button className="icon-button framed" type="button" aria-label="Copy trace ID" onClick={() => copyText(traceIdForActions)}>
                <Copy size={15} />
              </button>
            ) : null}
          </div>
          {detailLoading ? <div className="empty">Loading trace detail...</div> : null}
          {detailError ? <div className="status-strip">{detailError}</div> : null}
          {selectedDetail ? (
            <div className="trace-detail-grid">
              <div className="trace-tree" role="tree" aria-label="Trace spans">
                <TraceTree
                  childrenByParent={childrenByParent}
                  detail={selectedDetail}
                  expanded={expanded}
                  focusableSpanId={selectedSpan?.span_id ?? displayedSpanIndex.first?.span_id ?? ""}
                  onKeyDown={handleTreeKeyDown}
                  onLoadMoreChildren={loadChildren}
                  onToggle={toggleSpan}
                  selectedSpanId={selectedSpanId}
                />
                {selectedDetail.trace.total_span_count > loadedSpanCount ? (
                  <div className="trace-truncation">{formatNumber(loadedSpanCount, 0)} of {formatNumber(selectedDetail.trace.total_span_count, 0)} spans loaded</div>
                ) : null}
              </div>
              <TraceInspector requestedSpanId={selectedSpanId} span={selectedSpan} summary={inspectorSummary} />
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
  focusableSpanId,
  onKeyDown,
  onLoadMoreChildren,
  onToggle,
  selectedSpanId,
}: {
  childrenByParent: Record<string, ChildWindow>;
  detail: TraceDetailResponse;
  expanded: Set<string>;
  focusableSpanId: string;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, span: TraceSpan) => void;
  onLoadMoreChildren: (parentSpanId: string, cursor?: string) => void;
  onToggle: (span: TraceSpan) => void;
  selectedSpanId: string;
}) {
  const roots = rootSpans(detail.spans);
  const knownChildrenByParent = useMemo(() => groupKnownChildren(detail.spans), [detail.spans]);
  return (
    <div>
      {roots.map((span) => (
        <TraceTreeNode
          childrenByParent={childrenByParent}
          expanded={expanded}
          focusableSpanId={focusableSpanId}
          key={span.span_id}
          level={1}
          knownChildrenByParent={knownChildrenByParent}
          onKeyDown={onKeyDown}
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
  focusableSpanId,
  knownChildrenByParent,
  level,
  onKeyDown,
  onLoadMoreChildren,
  onToggle,
  selectedSpanId,
  span,
}: {
  childrenByParent: Record<string, ChildWindow>;
  expanded: Set<string>;
  focusableSpanId: string;
  knownChildrenByParent: Record<string, TraceSpan[]>;
  level: number;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, span: TraceSpan) => void;
  onLoadMoreChildren: (parentSpanId: string, cursor?: string) => void;
  onToggle: (span: TraceSpan) => void;
  selectedSpanId: string;
  span: TraceSpan;
}) {
  const childWindow = childrenByParent[span.span_id];
  const isExpanded = expanded.has(span.span_id);
  const knownChildren = knownChildrenByParent[span.span_id] ?? [];
  const knownChildIds = new Set(knownChildren.map((child) => child.span_id));
  const children = [
    ...knownChildren,
    ...(childWindow?.spans ?? []).filter((child) => !knownChildIds.has(child.span_id)),
  ];
  const hasChildren = span.child_count > 0 || children.length > 0;
  return (
    <div className="trace-node">
      <button
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={selectedSpanId === span.span_id}
        className={`trace-node-button ${selectedSpanId === span.span_id ? "active" : ""}`}
        data-trace-span-id={span.span_id}
        onKeyDown={(event) => onKeyDown(event, span)}
        role="treeitem"
        style={{ paddingLeft: `${level * 14}px` }}
        tabIndex={focusableSpanId === span.span_id ? 0 : -1}
        type="button"
        onClick={() => onToggle(span)}
      >
        {hasChildren ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="trace-node-spacer" />}
        <span className={`trace-status ${span.status}`}>{span.status}</span>
        <span className="trace-node-name">{span.name}</span>
        <span className="trace-node-kind">{span.kind}</span>
        <span className="trace-node-duration">{formatDuration(span.duration_ms)}</span>
      </button>
      {isExpanded ? (
        <div role="group">
          {childWindow?.loading ? <div className="trace-child-state" style={{ paddingLeft: `${(level + 1) * 14}px` }}>Loading child spans...</div> : null}
          {childWindow?.error ? (
            <button className="trace-child-state error" style={{ paddingLeft: `${(level + 1) * 14}px` }} type="button" onClick={() => onLoadMoreChildren(span.span_id)}>
              {childWindow.error} Retry
            </button>
          ) : null}
          {children.map((child) => (
            <TraceTreeNode
              childrenByParent={childrenByParent}
              expanded={expanded}
              focusableSpanId={focusableSpanId}
              key={child.span_id}
              knownChildrenByParent={knownChildrenByParent}
              level={level + 1}
              onKeyDown={onKeyDown}
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

function TraceInspector({ requestedSpanId, span, summary }: { requestedSpanId: string; span: TraceSpan | null; summary: TraceInspectorSummary | null }) {
  if (!span && requestedSpanId) return <aside className="trace-inspector empty">Span {requestedSpanId.slice(0, 8)} is outside the loaded tree window.</aside>;
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

export function traceListQueryParams({
  project,
  runFilter,
  statusFilter,
  kindFilter,
  timeRange,
  query,
  limit,
  cursor,
  nowMs = Date.now(),
}: {
  project: string;
  runFilter: string;
  statusFilter: string;
  kindFilter: string;
  timeRange: string;
  query: string;
  limit: number;
  cursor: string;
  nowMs?: number;
}) {
  const scopedRunId = runFilter || undefined;
  const window = scopedRunId ? {} : traceTimeWindow(timeRange, nowMs);
  return {
    project: scopedRunId ? undefined : project,
    run_id: scopedRunId,
    status: statusFilter,
    kind: kindFilter,
    ...window,
    q: query,
    limit,
    cursor,
  };
}

function traceTimeWindow(timeRange: string, nowMs: number) {
  if (timeRange === "all") {
    return {
      from: "1900-01-01T00:00:00.000Z",
      to: "2299-12-31T23:59:59.000Z",
    };
  }
  const days = timeRange === "30d" ? 30 : 7;
  return {
    from: new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(nowMs + 60_000).toISOString(),
  };
}

function flattenDisplayedSpans(spans: TraceSpan[], childrenByParent: Record<string, ChildWindow>) {
  const out: TraceSpan[] = [];
  const knownChildrenByParent = groupKnownChildren(spans);
  const seen = new Set<string>();
  const visit = (span: TraceSpan) => {
    if (seen.has(span.span_id)) return;
    seen.add(span.span_id);
    out.push(span);
    for (const child of knownChildrenByParent[span.span_id] ?? []) visit(child);
    for (const child of childrenByParent[span.span_id]?.spans ?? []) visit(child);
  };
  for (const span of rootSpans(spans)) visit(span);
  for (const span of spans) visit(span);
  return out;
}

function indexDisplayedSpans(spans: TraceSpan[], childrenByParent: Record<string, ChildWindow>) {
  const ordered = flattenDisplayedSpans(spans, childrenByParent);
  return {
    first: ordered[0] ?? null,
    byId: new Map(ordered.map((span) => [span.span_id, span])),
    ordered,
  };
}

function groupKnownChildren(spans: TraceSpan[]) {
  return spans.reduce<Record<string, TraceSpan[]>>((groups, span) => {
    if (!span.parent_span_id) return groups;
    const group = groups[span.parent_span_id] ?? [];
    group.push(span);
    groups[span.parent_span_id] = group;
    return groups;
  }, {});
}

function patchChildWindow(current: Record<string, ChildWindow>, parentSpanId: string, patch: Partial<ChildWindow>) {
  return {
    ...current,
    [parentSpanId]: {
      ...(current[parentSpanId] ?? EMPTY_CHILD_WINDOW),
      ...patch,
    },
  };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function traceUrlState() {
  if (typeof window === "undefined") return { runId: "", traceId: "", spanId: "", status: "", kind: "", timeRange: "7d", q: "" };
  const params = new URLSearchParams(window.location.search);
  return {
    runId: params.get("run_id") ?? "",
    traceId: params.get("trace_id") ?? "",
    spanId: params.get("span_id") ?? "",
    status: params.get("status") ?? "",
    kind: params.get("kind") ?? "",
    timeRange: normalizeTraceTimeRange(params.get("time")),
    q: params.get("q") ?? "",
  };
}

function normalizeTraceTimeRange(value: string | null) {
  return value === "30d" || value === "all" ? value : "7d";
}

function absoluteTimeTitle(value: string | null | undefined) {
  if (!value) return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function currentTraceUrlFilters(status: string, kind: string, timeRange: string, query: string) {
  return {
    status,
    kind,
    timeRange,
    q: query.trim(),
  };
}

function replaceTraceUrl(runId: string, traceId: string, spanId: string, filters: { status?: string; kind?: string; timeRange?: string; q?: string } = {}) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (runId) url.searchParams.set("run_id", runId);
  else url.searchParams.delete("run_id");
  if (traceId) url.searchParams.set("trace_id", traceId);
  else url.searchParams.delete("trace_id");
  if (spanId) url.searchParams.set("span_id", spanId);
  else url.searchParams.delete("span_id");
  if (filters.status) url.searchParams.set("status", filters.status);
  else url.searchParams.delete("status");
  if (filters.kind) url.searchParams.set("kind", filters.kind);
  else url.searchParams.delete("kind");
  if (filters.timeRange && filters.timeRange !== "7d") url.searchParams.set("time", filters.timeRange);
  else url.searchParams.delete("time");
  if (filters.q) url.searchParams.set("q", filters.q);
  else url.searchParams.delete("q");
  const search = url.searchParams.toString();
  window.history.replaceState(null, "", search ? `${url.pathname}?${search}` : url.pathname);
}

function traceKey(runId: string, traceId: string) {
  return `${runId}:${traceId}`;
}

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // IDs are visible and selectable when clipboard permission is unavailable.
  }
}
