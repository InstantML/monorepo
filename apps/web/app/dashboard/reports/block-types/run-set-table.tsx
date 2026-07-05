"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { ApiClient } from "../../../../src/api.js";
import { resolveRunsetRuns } from "../runset-cache";
import type { PanelGridBlockData, RunsetData, RunsetRunSettings } from "./types";
import { RUN_COLOR_PALETTE } from "./types";

/**
 * Run-set table widget — the load-bearing v1.2 addition.
 *
 * Renders the runs resolved by every PanelGrid runset as a block-based table
 * with per-row visibility / disable / color controls. Mutations are persisted
 * back to the Runset spec (via `onChange`) so the charts above re-render
 * with the user's selections. The table never short-circuits chart fetches
 * with its own data store — that keeps the spec the single source of truth
 * for both rendering and persistence.
 */

const PAGE_SIZE = 10;
const NAME_TRUNCATE_AT = 28;
const EMPTY_RUNSET_IDS: string[] = [];

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  finished: "Finished",
  failed: "Failed",
};

type RunRow = {
  id: string;
  name: string;
  project: string;
  status: string;
  tags: string[];
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  notes: string;
};

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; runs: RunRow[] };

type RunsetFetchSpec = Pick<RunsetData, "projects" | "pinned_run_ids" | "limit">;

type Props = {
  block: PanelGridBlockData;
  runsetIndex: number;
  readOnly?: boolean;
  api?: ApiClient;
  onChange?: (next: PanelGridBlockData) => void;
};

export function RunSetTable({ block, runsetIndex, readOnly = false, api, onChange }: Props) {
  const runset = block.runsets[runsetIndex];
  const client = useMemo(() => api ?? new ApiClient(), [api]);
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  const requestSeqRef = useRef(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(0);
  const [openMenu, setOpenMenu] = useState<"filter" | "group" | "sort" | null>(null);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);

  const fetchProjects = runset?.projects ?? EMPTY_RUNSET_IDS;
  const fetchPinnedRunIds = runset?.pinned_run_ids ?? EMPTY_RUNSET_IDS;
  const fetchLimit = runset?.limit;
  const hasRunset = !!runset;
  const fetchSpec = useMemo<RunsetFetchSpec | null>(() => {
    if (!hasRunset) return null;
    return {
      projects: [...fetchProjects],
      pinned_run_ids: [...fetchPinnedRunIds],
      limit: fetchLimit,
    };
  }, [fetchLimit, fetchPinnedRunIds, fetchProjects, hasRunset]);

  useEffect(() => {
    if (!fetchSpec) {
      setState({ kind: "idle" });
      return;
    }
    if (!fetchSpec.projects.length && !(fetchSpec.pinned_run_ids ?? []).length) {
      setState({ kind: "ready", runs: [] });
      return;
    }
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    setState({ kind: "loading" });
    (async () => {
      try {
        const runs = await fetchRunsForRunset(client, fetchSpec, controller.signal);
        if (seq !== requestSeqRef.current) return;
        setState({ kind: "ready", runs });
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        if ((error as { name?: string } | null)?.name === "AbortError") return;
        const message = error instanceof Error ? error.message : "Failed to load runs";
        setState({ kind: "error", message });
      }
    })();
    return () => controller.abort();
  }, [client, fetchSpec]);

  const updateRunset = useCallback(
    (patch: Partial<RunsetData>) => {
      if (!onChange || !runset) return;
      const runsets = block.runsets.map((entry, index) =>
        index === runsetIndex ? { ...entry, ...patch } : entry,
      );
      onChange({ ...block, runsets });
    },
    [block, onChange, runset, runsetIndex],
  );

  const updateRunSettings = useCallback(
    (runId: string, patch: Partial<RunsetRunSettings>) => {
      if (!runset) return;
      const next = { ...(runset.run_settings ?? {}) };
      const previous = next[runId] ?? {};
      next[runId] = { ...previous, ...patch };
      updateRunset({ run_settings: next });
    },
    [runset, updateRunset],
  );

  // Apply filters → search → sort to the raw fetched rows. None of these mutate
  // the underlying spec unless the user clicks a menu action (e.g. "sort by
  // name" persists into runset.order).
  const visibleRuns = useMemo(() => {
    if (state.kind !== "ready") return [];
    const term = searchTerm.trim().toLowerCase();
    const statusFilter = runset?.filters?.status ?? null;
    const projectFilter = runset?.filters?.projects ?? null;
    const filtered = state.runs.filter((run) => {
      if (statusFilter?.length && !statusFilter.includes(run.status)) return false;
      if (projectFilter?.length && !projectFilter.includes(run.project)) return false;
      if (!term) return true;
      if (run.name.toLowerCase().includes(term)) return true;
      if (run.tags.some((tag) => tag.toLowerCase().includes(term))) return true;
      if (run.notes.toLowerCase().includes(term)) return true;
      return false;
    });
    const sorted = sortRuns(filtered, runset?.order ?? null);
    return sorted;
  }, [state, runset, searchTerm]);

  const totalCount = visibleRuns.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageRuns = visibleRuns.slice(pageStart, pageStart + PAGE_SIZE);

  // Available filter options derived from the loaded rows. This is best-effort:
  // we fall back to common status enums when no rows have loaded yet.
  const availableStatuses = useMemo(() => {
    if (state.kind !== "ready") return ["running", "finished", "failed"];
    const set = new Set<string>(state.runs.map((run) => run.status));
    return Array.from(set).sort();
  }, [state]);
  const availableProjects = useMemo(() => {
    if (state.kind !== "ready") return runset?.projects ?? [];
    const set = new Set<string>(state.runs.map((run) => run.project));
    return Array.from(set).sort();
  }, [state, runset]);

  if (!runset) {
    return <div className="runset-table runset-table--empty">Runset {runsetIndex} is not configured.</div>;
  }

  const renderToolbar = (
    <div className="runset-table__toolbar">
      <input
        className="runset-table__search"
        type="search"
        value={searchTerm}
        placeholder="Search runs by name, tag, note…"
        onChange={(event) => {
          setSearchTerm(event.target.value);
          setPage(0);
        }}
        aria-label={`Search runs in runset ${runsetIndex + 1}`}
      />
      <div className="runset-table__menus">
        <ToolbarMenu
          label="Filter"
          open={openMenu === "filter"}
          onToggle={() => setOpenMenu(openMenu === "filter" ? null : "filter")}
          disabled={readOnly}
        >
          <FilterMenuContent
            availableStatuses={availableStatuses}
            availableProjects={availableProjects}
            selectedStatuses={runset.filters?.status ?? []}
            selectedProjects={runset.filters?.projects ?? []}
            onStatusToggle={(value) => {
              const current = new Set(runset.filters?.status ?? []);
              if (current.has(value)) current.delete(value);
              else current.add(value);
              updateRunset({
                filters: { ...(runset.filters ?? {}), status: Array.from(current) },
              });
            }}
            onProjectToggle={(value) => {
              const current = new Set(runset.filters?.projects ?? []);
              if (current.has(value)) current.delete(value);
              else current.add(value);
              updateRunset({
                filters: { ...(runset.filters ?? {}), projects: Array.from(current) },
              });
            }}
            onClear={() => updateRunset({ filters: null })}
          />
        </ToolbarMenu>
        <ToolbarMenu
          label={runset.groupby ? `Group: ${runset.groupby}` : "Group"}
          open={openMenu === "group"}
          onToggle={() => setOpenMenu(openMenu === "group" ? null : "group")}
          disabled={readOnly}
        >
          <GroupMenuContent
            value={runset.groupby ?? ""}
            onChange={(value) => updateRunset({ groupby: value || null })}
          />
        </ToolbarMenu>
        <ToolbarMenu
          label={runset.order ? `Sort: ${SORT_LABELS[runset.order] ?? runset.order}` : "Sort"}
          open={openMenu === "sort"}
          onToggle={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
          disabled={readOnly}
        >
          <SortMenuContent
            value={runset.order ?? "created"}
            onChange={(value) => updateRunset({ order: value })}
          />
        </ToolbarMenu>
      </div>
    </div>
  );

  if (state.kind === "loading") {
    return (
      <div className="runset-table">
        {renderToolbar}
        <div className="runset-table__status">Loading runs…</div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="runset-table">
        {renderToolbar}
        <div className="runset-table__status runset-table__status--error">
          Run query failed: {state.message}
        </div>
      </div>
    );
  }
  if (!runset.projects.length && !(runset.pinned_run_ids ?? []).length) {
    return (
      <div className="runset-table">
        {renderToolbar}
        <div className="runset-table__status">Add a project to populate runs.</div>
      </div>
    );
  }
  if (state.kind !== "ready" || !state.runs.length) {
    return (
      <div className="runset-table">
        {renderToolbar}
        <div className="runset-table__status">
          No runs match this query. Edit the Runset config or pin specific runs by ID.
        </div>
      </div>
    );
  }

  return (
    <div className="runset-table">
      {renderToolbar}
      <div className="runset-table__scroll">
        <table className="runset-table__grid">
          <thead>
            <tr>
              <th aria-label="Selected" className="runset-table__col-select" />
              <th aria-label="Visibility" className="runset-table__col-eye" />
              <th aria-label="Color" className="runset-table__col-color" />
              <th>Name</th>
              <th>Project</th>
              <th>State</th>
              <th>Tags</th>
              <th>Created</th>
              <th>Runtime</th>
            </tr>
          </thead>
          <tbody>
            {pageRuns.map((run, index) => {
              const settings = runset.run_settings?.[run.id] ?? {};
              const disabled = !!settings.disabled;
              const hidden = !!settings.hidden;
              const color = settings.color ?? RUN_COLOR_PALETTE[index % RUN_COLOR_PALETTE.length];
              return (
                <tr key={run.id} className={disabled ? "runset-table__row--disabled" : undefined}>
                  <td className="runset-table__col-select">
                    <input
                      type="checkbox"
                      checked={!disabled}
                      onChange={(event) =>
                        updateRunSettings(run.id, { disabled: !event.target.checked })
                      }
                      disabled={readOnly}
                      aria-label={`Include run ${run.name}`}
                    />
                  </td>
                  <td className="runset-table__col-eye">
                    <button
                      type="button"
                      className="runset-table__eye"
                      onClick={() => updateRunSettings(run.id, { hidden: !hidden })}
                      disabled={readOnly || disabled}
                      aria-label={hidden ? `Show run ${run.name}` : `Hide run ${run.name}`}
                      aria-pressed={!hidden}
                      title={hidden ? "Hidden from charts" : "Visible in charts"}
                    >
                      {hidden ? (
                        <EyeOff size={14} strokeWidth={1.8} aria-hidden="true" />
                      ) : (
                        <Eye size={14} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
                  </td>
                  <td className="runset-table__col-color">
                    <button
                      type="button"
                      className="runset-table__dot"
                      style={{ backgroundColor: color }}
                      onClick={() =>
                        setColorPickerFor(colorPickerFor === run.id ? null : run.id)
                      }
                      disabled={readOnly}
                      aria-label={`Pick color for run ${run.name}`}
                    />
                    {colorPickerFor === run.id ? (
                      <ColorPickerPopover
                        currentColor={color}
                        onPick={(picked) => {
                          updateRunSettings(run.id, { color: picked });
                          setColorPickerFor(null);
                        }}
                        onDismiss={() => setColorPickerFor(null)}
                      />
                    ) : null}
                  </td>
                  <td className="runset-table__name" title={run.name}>
                    {truncate(run.name, NAME_TRUNCATE_AT)}
                  </td>
                  <td className="runset-table__project">{run.project}</td>
                  <td>
                    <StatusPill status={run.status} />
                  </td>
                  <td>
                    <TagList tags={run.tags} />
                  </td>
                  <td className="runset-table__time">{formatRelative(run.created_at)}</td>
                  <td className="runset-table__time">
                    {formatRuntime(run.started_at, run.finished_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="runset-table__pagination">
        <span className="runset-table__count">
          {pageStart + 1}–{Math.min(totalCount, pageStart + PAGE_SIZE)} of {totalCount}
        </span>
        <div className="runset-table__page-controls">
          <button
            type="button"
            className="report-block__action report-block__action--secondary"
            onClick={() => setPage(Math.max(0, safePage - 1))}
            disabled={safePage === 0}
            aria-label="Previous page"
          >
            ‹
          </button>
          <button
            type="button"
            className="report-block__action report-block__action--secondary"
            onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
            disabled={safePage >= pageCount - 1}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

const SORT_LABELS: Record<string, string> = {
  created: "Created",
  name: "Name",
  state: "State",
  runtime: "Runtime",
};

function sortRuns(runs: RunRow[], order: string | null): RunRow[] {
  if (!order) return runs;
  const copy = [...runs];
  switch (order) {
    case "name":
      copy.sort((a, b) => a.name.localeCompare(b.name));
      return copy;
    case "state":
      copy.sort((a, b) => a.status.localeCompare(b.status));
      return copy;
    case "runtime":
      copy.sort((a, b) => runtimeMs(a) - runtimeMs(b));
      return copy;
    case "created":
      copy.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
      return copy;
    default:
      // Treat unknown orders as a key onto the summary/config — best-effort
      // sort by string equality of that path so the UI doesn't blow up.
      return copy;
  }
}

function runtimeMs(run: RunRow): number {
  if (!run.started_at) return 0;
  const start = Date.parse(run.started_at);
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return end - start;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatRelative(value: string | null): string {
  if (!value) return "—";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  const delta = Date.now() - ts;
  if (delta < 0) return "in future";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatRuntime(started: string | null, finished: string | null): string {
  if (!started) return "—";
  const start = Date.parse(started);
  if (!Number.isFinite(start)) return "—";
  if (!finished) return "running";
  const end = Date.parse(finished);
  if (!Number.isFinite(end)) return "—";
  const ms = Math.max(0, end - start);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function StatusPill({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;
  return <span className={`runset-table__pill runset-table__pill--${status}`}>{label}</span>;
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="runset-table__tags-empty">—</span>;
  const visible = tags.slice(0, 3);
  const overflow = tags.length - visible.length;
  return (
    <span className="runset-table__tag-list">
      {visible.map((tag) => (
        <span key={tag} className="runset-table__tag">
          {tag}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="runset-table__tag runset-table__tag--overflow">+{overflow}</span>
      ) : null}
    </span>
  );
}

function ToolbarMenu({
  label,
  open,
  onToggle,
  disabled,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="runset-table__menu">
      <button
        type="button"
        className="report-block__action report-block__action--secondary"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
      >
        {label}
      </button>
      {open ? <div className="runset-table__menu-pop">{children}</div> : null}
    </div>
  );
}

function FilterMenuContent({
  availableStatuses,
  availableProjects,
  selectedStatuses,
  selectedProjects,
  onStatusToggle,
  onProjectToggle,
  onClear,
}: {
  availableStatuses: string[];
  availableProjects: string[];
  selectedStatuses: string[];
  selectedProjects: string[];
  onStatusToggle: (value: string) => void;
  onProjectToggle: (value: string) => void;
  onClear: () => void;
}) {
  const statusSet = new Set(selectedStatuses);
  const projectSet = new Set(selectedProjects);
  return (
    <div className="runset-table__menu-body">
      <div className="runset-table__menu-section">
        <div className="runset-table__menu-label">Status</div>
        {availableStatuses.map((value) => (
          <label key={value} className="runset-table__check-row">
            <input
              aria-label={`Filter status ${STATUS_LABELS[value] ?? value}`}
              type="checkbox"
              checked={statusSet.has(value)}
              onChange={() => onStatusToggle(value)}
            />
            {STATUS_LABELS[value] ?? value}
          </label>
        ))}
      </div>
      {availableProjects.length ? (
        <div className="runset-table__menu-section">
          <div className="runset-table__menu-label">Project</div>
          {availableProjects.map((value) => (
            <label key={value} className="runset-table__check-row">
            <input
              aria-label={`Filter project ${value}`}
              type="checkbox"
                checked={projectSet.has(value)}
                onChange={() => onProjectToggle(value)}
              />
              {value}
            </label>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="report-block__action report-block__action--secondary"
        onClick={onClear}
      >
        Clear filters
      </button>
    </div>
  );
}

function GroupMenuContent({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="runset-table__menu-body">
      <div className="runset-table__menu-label">Group by</div>
      <input
        aria-label="Group runs by"
        className="report-block__input"
        type="text"
        value={value}
        placeholder="config.lr or summary.val_acc"
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="report-block__action report-block__action--secondary"
        onClick={() => onChange("")}
      >
        Clear group
      </button>
    </div>
  );
}

function SortMenuContent({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="runset-table__menu-body">
      <div className="runset-table__menu-label">Sort by</div>
      {(["created", "name", "state", "runtime"] as const).map((option) => (
        <label key={option} className="runset-table__check-row">
          <input
            aria-label={`Sort by ${SORT_LABELS[option]}`}
            type="radio"
            checked={value === option}
            onChange={() => onChange(option)}
          />
          {SORT_LABELS[option]}
        </label>
      ))}
    </div>
  );
}

function ColorPickerPopover({
  currentColor,
  onPick,
  onDismiss,
}: {
  currentColor: string;
  onPick: (color: string) => void;
  onDismiss: () => void;
}) {
  // Dismiss on outside click — keep the popover minimal.
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".runset-table__color-pop")) return;
      onDismiss();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onDismiss]);

  return (
    <div className="runset-table__color-pop" role="dialog" aria-label="Pick color">
      {RUN_COLOR_PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          className={`runset-table__color-swatch${
            color === currentColor ? " runset-table__color-swatch--active" : ""
          }`}
          style={{ backgroundColor: color }}
          onClick={() => onPick(color)}
          aria-label={`Use color ${color}`}
        />
      ))}
    </div>
  );
}

/**
 * Resolve the runset to a concrete RunRow list. Mirrors the runset resolution
 * inside `PanelChartRenderer` but pulls richer fields (tags, started_at,
 * finished_at, notes) because the table surface needs more than just metric
 * aggregates.
 */
async function fetchRunsForRunset(
  api: ApiClient,
  runset: RunsetFetchSpec,
  signal: AbortSignal,
): Promise<RunRow[]> {
  // Shared, short-TTL promise cache with parallel per-project fetches (B7) —
  // the table joins any panel already resolving the identical spec.
  const rawRuns = await resolveRunsetRuns(
    api,
    runset,
    {
      perProjectLimit: clampLimit(runset.limit ?? null),
      maxRuns: Number.POSITIVE_INFINITY,
      pinnedLookupLimit: MAX_RUNS,
      includePinned: true,
    },
    signal,
  );
  const collected = new Map<string, RunRow>();
  for (const { raw, project } of rawRuns) {
    const row = normalizeRunRow(raw, project);
    if (row && !collected.has(row.id)) collected.set(row.id, row);
  }
  return Array.from(collected.values());
}

const MAX_RUNS = 200;

function clampLimit(value: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return MAX_RUNS;
  return Math.min(Math.floor(value), MAX_RUNS);
}

function normalizeRunRow(raw: unknown, fallbackProject: string): RunRow | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  if (!id) return null;
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const metadata =
    typeof obj.metadata === "object" && obj.metadata !== null
      ? (obj.metadata as Record<string, unknown>)
      : {};
  const notes =
    typeof metadata.notes === "string"
      ? metadata.notes
      : typeof obj.notes === "string"
        ? obj.notes
        : "";
  return {
    id,
    name: typeof obj.name === "string" ? obj.name : id,
    project: typeof obj.project === "string" && obj.project ? obj.project : fallbackProject,
    status: typeof obj.status === "string" ? obj.status : "unknown",
    tags,
    created_at: typeof obj.created_at === "string" ? obj.created_at : null,
    started_at: typeof obj.started_at === "string" ? obj.started_at : null,
    finished_at: typeof obj.finished_at === "string" ? obj.finished_at : null,
    notes,
  };
}
