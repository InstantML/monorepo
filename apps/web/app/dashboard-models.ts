import { queryString } from "../src/api.js";
import { defaultDistributionFields, defaultScatterFields, parseCategoricalFieldId, parseFieldId } from "../src/dashboard-panels.js";
import { bestMetric, durationLabel, formatNumber, metricGoal } from "../src/state.js";
import { WORKSPACE_VIEW_PREFIX } from "./dashboard/state/storage-keys";

import type {
  AlertRow,
  ApiRow,
  Artifact,
  DatasetRow,
  MetricCatalogRow,
  CheckpointRow,
  ReportRow,
  RunMetricRow,
  RunSummary,
  RunTimelineRow,
  TableColumns,
  WorkspacePanel,
  WorkspacePanelSettings,
  WorkspacePanelType,
  WorkspaceSection,
  WorkspaceView,
} from "./dashboard-types";

export const defaultTableColumns: TableColumns = {
  status: true,
  tags: true,
  notes: true,
  started: true,
  duration: true,
  latest: true,
};

export const chartWidth = 560;
export const chartHeight = 360;
export const chartPadding = 56;
export const COMPARE_RUN_LIMIT = 50;
export const COMPARE_ARTIFACT_LIMIT = 12;
export const WORKSPACE_SCHEMA_VERSION = 2;
export const DEFAULT_METRIC_KEY = "eval/return_mean";
export { WORKSPACE_VIEW_PREFIX };
const AUTOMATIC_WORKSPACE_PANEL_LIMIT = 6;
const PREFERRED_AUTOMATIC_METRICS = [
  DEFAULT_METRIC_KEY,
  "train/loss",
  "rollout/ep_rew_mean",
  "eval/mean_reward",
  "eval/accuracy",
  "eval/perplexity",
  "eval/success_rate",
  "train/tokens_per_second",
  "train/grad_norm",
  "system/cpu_percent",
  "gpu/0/utilization_percent",
  "gpu/0/memory_percent",
  "data/loader_wait_ms",
  "time/fps",
];

export const defaultWorkspacePanelSettings: WorkspacePanelSettings = {
  xMode: "step",
  smoothing: 0,
  groupBy: "",
  groupAverage: false,
  maxRuns: 10,
};

export const defaultWorkspacePanelLayout = {
  w: 6,
  h: 4,
};

export function compactValue(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") {
    const absolute = Math.abs(value);
    if (absolute > 0 && absolute < 0.0001) return value.toExponential(1);
    if (absolute > 0 && absolute < 0.01) return value.toPrecision(2);
    return formatNumber(value, 4);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function runConfigSummary(run: RunSummary) {
  const parts = [
    run.config.seed !== undefined ? `seed ${compactValue(run.config.seed)}` : "",
    run.config.learning_rate !== undefined ? `lr ${compactValue(run.config.learning_rate)}` : "",
    run.config.lr !== undefined ? `lr ${compactValue(run.config.lr)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no config summary";
}

export function lastMetricStep(run: RunSummary) {
  const steps = Object.values(run.metric_aggregates ?? {})
    .map((aggregate) => aggregate.best_step)
    .filter((step): step is number => typeof step === "number" && Number.isFinite(step));
  return steps.length ? formatNumber(Math.max(...steps), 0) : "-";
}

export function formatRunTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const month = date.toLocaleString(undefined, { month: "short" });
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month} ${day}, ${hour}:${minute}`;
}

export function shortMetricName(metricKey: string) {
  const parts = metricKey.split("/");
  return parts[parts.length - 1] || metricKey;
}

export function metricNamespace(metricKey: string) {
  return metricKey.includes("/") ? metricKey.split("/")[0] : "custom";
}

export function metricTitle(metricKey: string) {
  return shortMetricName(metricKey)
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function workspaceStorageKey(project: string, scope = "") {
  return `${WORKSPACE_VIEW_PREFIX}${scope || project || "all"}`;
}

function automaticWorkspaceMetricKeys(metricKeys: string[]) {
  const keys = [...new Set(metricKeys.filter(Boolean))].sort();
  if (keys.length <= AUTOMATIC_WORKSPACE_PANEL_LIMIT) return keys;
  const keySet = new Set(keys);
  const preferred = PREFERRED_AUTOMATIC_METRICS.filter((key) => keySet.has(key));
  const remaining = keys.filter((key) => !preferred.includes(key));
  return [...preferred, ...remaining].slice(0, AUTOMATIC_WORKSPACE_PANEL_LIMIT);
}

export function buildAutomaticWorkspace(metricKeys: string[], project: string): WorkspaceView {
  const keys = automaticWorkspaceMetricKeys(metricKeys);
  const sectionsByNamespace = new Map<string, string[]>();
  for (const key of keys) {
    const namespace = metricNamespace(key);
    if (!sectionsByNamespace.has(namespace)) sectionsByNamespace.set(namespace, []);
    sectionsByNamespace.get(namespace)?.push(key);
  }
  const sections: WorkspaceSection[] = [...sectionsByNamespace.entries()].map(([namespace, namespaceKeys]) => ({
    id: `section-${stableId(namespace)}`,
    name: namespace === "custom" ? "Charts" : namespace,
    collapsed: false,
    panels: namespaceKeys.map((key) => workspacePanelForMetric(key)),
  }));
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: `workspace-${stableId(project || "all")}`,
    name: project ? `${project} workspace` : "All projects workspace",
    mode: "automatic",
    project: project || null,
    settings: {
      ...defaultWorkspacePanelSettings,
      hideEmptySections: false,
      sectionOrganization: "prefix",
    },
    sections: sections.length ? sections : [{
      id: "section-charts",
      name: "Charts",
      collapsed: false,
      panels: [],
    }],
    updatedAt: new Date().toISOString(),
  };
}

export function buildManualWorkspace(project: string): WorkspaceView {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: `workspace-manual-${stableId(project || "all")}`,
    name: project ? `${project} manual workspace` : "Manual workspace",
    mode: "manual",
    project: project || null,
    settings: {
      ...defaultWorkspacePanelSettings,
      hideEmptySections: false,
      sectionOrganization: "manual",
    },
    sections: [{
      id: "section-manual",
      name: "Charts",
      collapsed: false,
      panels: [],
    }],
    updatedAt: new Date().toISOString(),
  };
}

export const WORKSPACE_PANEL_TYPES: WorkspacePanelType[] = ["line", "bar", "histogram", "dot", "scatter", "distribution", "histogram_timeline"];
const workspacePanelTypes = new Set<WorkspacePanelType>(WORKSPACE_PANEL_TYPES);

export function workspacePanelTypeLabel(type: WorkspacePanelType) {
  if (type === "bar") return "Bar";
  if (type === "histogram") return "Value histogram";
  if (type === "dot") return "Dot plot";
  if (type === "scatter") return "Scatter";
  if (type === "distribution") return "Distribution";
  if (type === "histogram_timeline") return "Logged histogram timeline";
  return "Line";
}

export function workspacePanelForMetric(metricKey: string, type: WorkspacePanelType = "line"): WorkspacePanel {
  const safeType = workspacePanelTypes.has(type) ? type : "line";
  const metricTitleText = metricTitle(metricKey);
  if (safeType === "scatter") {
    const fields = defaultScatterFields(metricKey);
    return {
      id: `panel-${stableId(`${safeType}-${metricKey}`)}`,
      type: safeType,
      title: `${metricTitleText} Scatter`,
      metricKey,
      xField: fields.xField,
      yField: fields.yField,
      layout: defaultWorkspacePanelLayout,
    };
  }
  if (safeType === "distribution") {
    const fields = defaultDistributionFields(metricKey);
    return {
      id: `panel-${stableId(`${safeType}-${metricKey}`)}`,
      type: safeType,
      title: `${metricTitleText} Distribution`,
      metricKey,
      valueField: fields.valueField,
      groupField: fields.groupField,
      replicateField: fields.replicateField,
      layout: defaultWorkspacePanelLayout,
    };
  }
  if (safeType === "histogram_timeline") {
    return {
      id: `panel-${stableId(`${safeType}-${metricKey}`)}`,
      type: safeType,
      title: `${metricTitleText} timeline`,
      metricKey,
      objectKey: metricKey,
      layout: defaultWorkspacePanelLayout,
    };
  }
  return {
    id: `panel-${stableId(`${safeType}-${metricKey}`)}`,
    type: safeType,
    title: safeType === "line" ? metricTitleText : `${metricTitleText} ${workspacePanelTypeLabel(safeType)}`,
    metricKey,
    layout: defaultWorkspacePanelLayout,
  };
}

export function sanitizeWorkspaceView(raw: unknown, metricKeys: string[], project: string): WorkspaceView {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return buildAutomaticWorkspace(metricKeys, project);
  const candidate = raw as Partial<WorkspaceView>;
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== WORKSPACE_SCHEMA_VERSION) return buildAutomaticWorkspace(metricKeys, project);
  const sections = Array.isArray(candidate.sections)
    ? candidate.sections.slice(0, 50).map((section, sectionIndex) => sanitizeWorkspaceSection(section, sectionIndex)).filter(Boolean) as WorkspaceSection[]
    : [];
  const settings = { ...defaultWorkspacePanelSettings, ...(isPlainObject(candidate.settings) ? candidate.settings : {}) };
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: typeof candidate.id === "string" && candidate.id ? candidate.id.slice(0, 80) : `workspace-${stableId(project || "all")}`,
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.slice(0, 80) : "Runs workspace",
    mode: candidate.mode === "manual" ? "manual" : "automatic",
    project: typeof candidate.project === "string" ? candidate.project : project || null,
    settings: {
      ...defaultWorkspacePanelSettings,
      ...sanitizePanelSettings(settings),
      hideEmptySections: Boolean((settings as any).hideEmptySections),
      sectionOrganization: (settings as any).sectionOrganization === "manual" ? "manual" : "prefix",
    },
    sections: sections.length ? sections : buildAutomaticWorkspace(metricKeys, project).sections,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
  };
}

export function resolvePanelSettings(view: WorkspaceView, section: WorkspaceSection, panel: WorkspacePanel): WorkspacePanelSettings {
  return {
    ...defaultWorkspacePanelSettings,
    ...sanitizePanelSettings(view.settings),
    ...sanitizePanelSettings(section.settings),
    ...sanitizePanelSettings(panel.settings),
  };
}

export function workspaceMetricKeys(view: WorkspaceView, search = "") {
  const needle = search.trim().toLowerCase();
  const keys: string[] = [];
  for (const section of view.sections) {
    for (const panel of section.panels) {
      if (!workspacePanelNeedsMetricSeries(panel)) continue;
      if (needle && !`${section.name} ${panel.title} ${panel.metricKey}`.toLowerCase().includes(needle)) continue;
      keys.push(panel.metricKey);
    }
  }
  return [...new Set(keys)].sort();
}

export function workspacePanelNeedsMetricSeries(panel: WorkspacePanel) {
  return panel.type === "line";
}

export function metricKeysMissingPanels(view: WorkspaceView, metricKeys: string[]) {
  const present = new Set(view.sections.flatMap((section) => section.panels.map((panel) => panel.metricKey)));
  return metricKeys.filter((key) => !present.has(key));
}

export function stableId(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function sanitizeWorkspaceSection(section: unknown, index: number) {
  if (!isPlainObject(section)) return null;
  const id = typeof section.id === "string" && section.id ? section.id.slice(0, 80) : `section-${index}`;
  const name = typeof section.name === "string" && section.name.trim() ? section.name.slice(0, 80) : "Charts";
  const panels = Array.isArray(section.panels)
    ? section.panels.slice(0, 200).map((panel, panelIndex) => sanitizeWorkspacePanel(panel, panelIndex)).filter(Boolean) as WorkspacePanel[]
    : [];
  return {
    id,
    name,
    collapsed: Boolean(section.collapsed),
    settings: sanitizePanelSettings(section.settings),
    panels,
  };
}

function sanitizeWorkspacePanel(panel: unknown, index: number) {
  if (!isPlainObject(panel) || typeof panel.metricKey !== "string" || !panel.metricKey.trim()) return null;
  const type = typeof panel.type === "string" && workspacePanelTypes.has(panel.type as WorkspacePanelType)
    ? panel.type as WorkspacePanelType
    : "line";
  const base = {
    id: typeof panel.id === "string" && panel.id ? panel.id.slice(0, 80) : `panel-${index}`,
    type,
    title: typeof panel.title === "string" && panel.title.trim() ? panel.title.slice(0, 80) : metricTitle(panel.metricKey),
    metricKey: panel.metricKey.slice(0, 256),
    layout: sanitizePanelLayout(panel.layout),
    settings: sanitizePanelSettings(panel.settings),
  };
  if (type === "scatter") {
    const xField = sanitizeFieldRef(panel.xField);
    const yField = sanitizeFieldRef(panel.yField);
    if (!xField || !yField) return null;
    return {
      ...base,
      xField,
      yField,
    };
  }
  if (type === "distribution") {
    const valueField = sanitizeFieldRef(panel.valueField);
    const groupField = sanitizeCategoricalFieldRef(panel.groupField);
    const replicateField = sanitizeCategoricalFieldRef(panel.replicateField);
    if (!valueField) return null;
    return {
      ...base,
      valueField,
      groupField,
      replicateField,
    };
  }
  if (type === "histogram_timeline") {
    const objectKey = sanitizeObjectKey(panel.objectKey ?? panel.metricKey);
    if (!objectKey) return null;
    return {
      ...base,
      metricKey: base.metricKey || objectKey,
      objectKey,
    };
  }
  return base;
}

export function sanitizePanelLayout(layout: unknown) {
  if (!isPlainObject(layout)) return defaultWorkspacePanelLayout;
  return {
    w: Math.round(boundedNumber(layout.w, 3, 12) ?? defaultWorkspacePanelLayout.w),
    h: Math.round(boundedNumber(layout.h, 3, 10) ?? defaultWorkspacePanelLayout.h),
  };
}

function sanitizePanelSettings(settings: unknown): Partial<WorkspacePanelSettings> {
  if (!isPlainObject(settings)) return {};
  return {
    xMode: settings.xMode === "time" ? "time" : settings.xMode === "step" ? "step" : undefined,
    smoothing: boundedNumber(settings.smoothing, 0, 90),
    groupBy: typeof settings.groupBy === "string" ? settings.groupBy.slice(0, 80) : undefined,
    groupAverage: typeof settings.groupAverage === "boolean" ? settings.groupAverage : undefined,
    maxRuns: boundedNumber(settings.maxRuns, 1, 25),
  };
}

function boundedNumber(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : undefined;
}

function sanitizeFieldRef(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const field = value.slice(0, 512);
  return parseFieldId(field) ? field : undefined;
}

function sanitizeCategoricalFieldRef(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const field = value.slice(0, 512);
  return parseCategoricalFieldId(field) ? field : undefined;
}

function sanitizeObjectKey(value: unknown) {
  if (typeof value !== "string") return undefined;
  const key = value.trim().slice(0, 256);
  return key || undefined;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildMetricCatalogRows(runs: RunSummary[], metricKeys: string[], selectedRunIds: string[]): MetricCatalogRow[] {
  const selected = new Set(selectedRunIds);
  return metricKeys.map((key) => {
    const goal = metricGoal(key);
    const carriers = runs
      .map((run) => ({ run, aggregate: run.metric_aggregates?.[key] }))
      .filter((item) => item.aggregate);
    const pointCount = carriers.reduce((sum, item) => sum + (numberValue(item.aggregate?.count, 0) ?? 0), 0);
    const latestValues = carriers.map((item) => numberValue(item.aggregate?.latest, null)).filter(isFiniteNumber);
    const bestCandidate = carriers.reduce<{ run: RunSummary | null; value: number | null; step: number | null }>((best, item) => {
      const value = numberValue(goal === "minimize" ? item.aggregate?.min : item.aggregate?.max, null);
      const step = numberValue(goal === "minimize" ? item.aggregate?.min_step : item.aggregate?.best_step, null);
      if (value === null) return best;
      if (
        best.value === null ||
        (goal === "minimize" ? value < best.value : value > best.value) ||
        (value === best.value && (step ?? -Infinity) > (best.step ?? -Infinity))
      ) {
        return { run: item.run, value, step };
      }
      return best;
    }, { run: null, value: null, step: null });
    const meanNumerator = carriers.reduce((sum, item) => {
      const mean = numberValue(item.aggregate?.mean, null);
      const count = numberValue(item.aggregate?.count, 0) ?? 0;
      return mean === null ? sum : sum + mean * count;
    }, 0);
    const mean = pointCount ? meanNumerator / pointCount : null;
    const mins = carriers.map((item) => numberValue(item.aggregate?.min, null)).filter(isFiniteNumber);
    return {
      key,
      label: metricTitle(key),
      namespace: metricNamespace(key),
      runCount: carriers.length,
      selectedCount: carriers.filter((item) => selected.has(item.run.id)).length,
      pointCount,
      latest: latestValues.length ? latestValues[latestValues.length - 1] : null,
      best: bestCandidate.value,
      min: mins.length ? Math.min(...mins) : null,
      mean,
      bestStep: bestCandidate.step,
      bestRunName: bestCandidate.run?.name ?? "-",
    };
  }).sort((left, right) => right.selectedCount - left.selectedCount || right.runCount - left.runCount || left.key.localeCompare(right.key));
}

export function buildRunMetricRows(run: RunSummary | null): RunMetricRow[] {
  if (!run) return [];
  return Object.entries(run.metric_aggregates ?? {})
    .map(([key, aggregate]) => ({
      key,
      latest: numberValue(aggregate.latest, null),
      min: numberValue(aggregate.min, null),
      max: numberValue(aggregate.max, null),
      mean: numberValue(aggregate.mean, null),
      count: numberValue(aggregate.count, 0) ?? 0,
      latestStep: numberValue(aggregate.latest_step, null),
      bestStep: numberValue(aggregate.best_step, null),
    }))
    .sort((left, right) => metricPriority(left.key) - metricPriority(right.key) || left.key.localeCompare(right.key));
}

export function buildRunTimelineRows(run: RunSummary | null, artifacts: Artifact[], metricKey: string): RunTimelineRow[] {
  if (!run) return [];
  const metric = run.metric_aggregates?.[metricKey];
  const rows: RunTimelineRow[] = [
    {
      id: "created",
      label: "Created",
      detail: run.name,
      value: formatRunTime(run.created_at),
      tone: "neutral",
    },
    {
      id: "started",
      label: "Started",
      detail: run.project,
      value: formatRunTime(run.started_at ?? run.created_at),
      tone: "live",
    },
  ];
  if (metric) {
    rows.push({
      id: "best-metric",
      label: `Best ${shortMetricName(metricKey)}`,
      detail: `step ${compactValue(metric.best_step ?? "-")}`,
      value: compactValue(metric.max ?? "-"),
      tone: "good",
    });
  }
  const checkpoints = artifacts.filter((artifact) => artifact.type === "checkpoint");
  if (checkpoints.length) {
    const lastCheckpoint = [...checkpoints].sort((left, right) => (right.step ?? -1) - (left.step ?? -1))[0];
    rows.push({
      id: "checkpoint",
      label: "Latest checkpoint",
      detail: lastCheckpoint.name,
      value: lastCheckpoint.step === null ? "no step" : `step ${lastCheckpoint.step}`,
      tone: "good",
    });
  }
  const terminalLabel = run.status === "failed" ? "Failed" : run.finished_at ? "Finished" : run.status === "running" ? "Running" : "End state";
  rows.push({
    id: "finished",
    label: terminalLabel,
    detail: durationLabel(run),
    value: run.finished_at ? formatRunTime(run.finished_at) : run.status,
    tone: run.status === "failed" ? "bad" : run.status === "running" ? "live" : "good",
  });
  return rows;
}

function metricPriority(metricKey: string) {
  if (/^(eval|test|val)\//.test(metricKey)) return 0;
  if (/loss/i.test(metricKey)) return 1;
  if (/reward|return|accuracy|f1|r2/i.test(metricKey)) return 2;
  if (/^(train)\//.test(metricKey)) return 3;
  return 4;
}

function numberValue(value: unknown, fallback: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function compareRowRank(path: string) {
  const category = compareCategory(path);
  const order: Record<string, number> = { Status: 0, Metric: 1, Config: 2, Source: 3, Artifact: 4, Attribute: 5 };
  return order[category] ?? 9;
}

export function compareCategory(path: string) {
  const normalized = path.toLowerCase();
  if (normalized.includes("/status") || normalized.endsWith("status")) return "Status";
  if (
    normalized.startsWith("metric/") ||
    normalized.includes("/metric/") ||
    normalized.includes("latest_metrics") ||
    normalized.includes("metric_aggregates") ||
    normalized.startsWith("attribute/eval/") ||
    normalized.startsWith("attribute/test/") ||
    normalized.startsWith("attribute/val/") ||
    normalized.startsWith("attribute/train/")
  ) return "Metric";
  if (normalized.includes("/config") || normalized.startsWith("config/") || normalized.includes("learning_rate") || normalized.includes("seed")) return "Config";
  if (normalized.includes("source") || normalized.includes("git") || normalized.includes("metadata")) return "Source";
  if (normalized.includes("/artifacts") || normalized.includes("artifact") || normalized.includes("checkpoint") || normalized.includes("rollout")) return "Artifact";
  return "Attribute";
}

export function comparePathLabel(path: string) {
  const parts = path.split("/").filter(Boolean);
  const metricIndex = parts.findIndex((part) => ["metric", "latest_metrics", "metric_aggregates"].includes(part));
  if (metricIndex >= 0) {
    const metricParts = parts.slice(metricIndex + 1);
    const reducer = metricParts[metricParts.length - 1] ?? "";
    if (metricParts.length > 1 && ["latest", "last", "max", "min", "mean", "avg"].includes(reducer)) {
      return `${humanMetricPath(metricParts.slice(0, -1).join("/"))} · ${titleCaseLabel(humanComparePathSegment(reducer))}`;
    }
    if (parts[metricIndex] === "metric_aggregates" && metricParts.length > 1) {
      return `${humanMetricPath(metricParts.slice(0, -1).join("/"))} · ${titleCaseLabel(humanComparePathSegment(reducer))}`;
    }
    return humanMetricPath(metricParts.join("/")) || path;
  }
  if (parts[0] === "attribute" && ["eval", "test", "val", "train"].includes(parts[1])) return humanMetricPath(parts.slice(1).join("/"));
  return titleCaseLabel(humanComparePathSegment(parts[parts.length - 1] ?? path));
}

function humanComparePathSegment(value: string) {
  return value.replace(/^config-/, "config ").replace(/[_-]/g, " ");
}

function humanMetricPath(value: string) {
  return value.split("/").filter(Boolean).map((part) => titleCaseLabel(humanComparePathSegment(part))).join(" / ");
}

function titleCaseLabel(value: string) {
  return value.replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

export function shortValue(value: string) {
  if (value.startsWith("demo://")) return value.split("/").pop() ?? value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return safeArtifactUri(value);
  if (value.length > 72) return `${value.slice(0, 69)}...`;
  return value;
}

export function safeArtifactUri(value: unknown) {
  const text = String(value ?? "");
  if (!text) return "-";
  try {
    const url = new URL(text);
    const basename = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? url.hostname);
    return `${url.protocol}//.../${basename || "artifact"}`;
  } catch {
    return text.length > 72 ? `${text.slice(0, 69)}...` : text;
  }
}

export function safeArtifactMediaKind(artifact: Artifact) {
  const mime = String(artifact.mime_type ?? artifact.metadata?.mime_type ?? artifact.metadata?.mimeType ?? artifact.metadata?.content_type ?? artifact.metadata?.contentType ?? "").toLowerCase();
  const name = `${artifact.name} ${artifact.uri}`.toLowerCase();
  if (["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(mime) || /\.(png|jpe?g|webp|gif)(?:$|[?#])/.test(name)) return "image";
  if (["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp4"].includes(mime) || /\.(mp3|m4a|wav|aac)(?:$|[?#])/.test(name)) return "audio";
  if (["video/mp4", "video/webm", "video/quicktime"].includes(mime) || /\.(mp4|mov|webm)(?:$|[?#])/.test(name)) return "video";
  return "";
}

export function artifactHasStoredBytes(artifact: Pick<Artifact, "id" | "storage_backend">) {
  return Boolean(artifact.id) && (artifact.storage_backend === "local" || artifact.storage_backend === "r2");
}

export function buildAlertRows(runs: RunSummary[], metricKey: string): AlertRow[] {
  const rows: AlertRow[] = [];
  for (const run of runs) {
    if (run.status === "failed") {
      rows.push({
        id: `${run.id}:failed`,
        severity: "critical",
        tone: "bad",
        title: `${run.name} failed`,
        detail: `${run.project} / ${formatRunTime(run.started_at ?? run.created_at)}`,
        label: "critical",
      });
    }
    if (run.status === "running") {
      rows.push({
        id: `${run.id}:running`,
        severity: "active",
        tone: "live",
        title: `${run.name} is still running`,
        detail: `${run.project} / started ${formatRunTime(run.started_at ?? run.created_at)}`,
        label: "active",
      });
    }
    if (!run.artifact_counts.checkpoint) {
      rows.push({
        id: `${run.id}:checkpoint`,
        severity: "warning",
        tone: "live",
        title: `${run.name} has no checkpoints`,
        detail: "Checkpoint lineage is unavailable for this run.",
        label: "warning",
      });
    }
    if (bestMetric(run, metricKey) === null) {
      rows.push({
        id: `${run.id}:metric`,
        severity: "warning",
        tone: "live",
        title: `${run.name} is missing ${metricKey}`,
        detail: "The selected metric is not present in latest summaries.",
        label: "warning",
      });
    }
  }
  return rows.slice(0, 20);
}

export function buildDatasetRows(runs: RunSummary[], metricKey: string): DatasetRow[] {
  const rows = new Map<string, DatasetRow>();
  for (const run of runs) {
    const name = datasetNameForRun(run);
    if (!name) continue;
    const existing = rows.get(name) ?? { name, runs: 0, seeds: [], best: null };
    const seed = run.config.seed === undefined ? "" : String(run.config.seed);
    existing.runs += 1;
    if (seed && !existing.seeds.includes(seed)) existing.seeds.push(seed);
    const metric = bestMetric(run, metricKey);
    if (metric !== null && (existing.best === null || metric > existing.best)) existing.best = metric;
    rows.set(name, existing);
  }
  return [...rows.values()].sort((left, right) => right.runs - left.runs || left.name.localeCompare(right.name));
}

function datasetNameForRun(run: RunSummary) {
  const candidates = [
    run.config.dataset,
    run.config.dataset_name,
    run.config.data,
    run.config.env,
    run.metadata.dataset,
    run.metadata.environment,
  ];
  const value = candidates.find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value : null;
}

export function artifactTotalsForRuns(runs: RunSummary[]) {
  return runs.reduce(
    (totals, run) => ({
      checkpoint: totals.checkpoint + (run.artifact_counts?.checkpoint ?? 0),
      rollout: totals.rollout + (run.artifact_counts?.rollout ?? 0),
      file: totals.file + (run.artifact_counts?.file ?? 0),
    }),
    { checkpoint: 0, rollout: 0, file: 0 },
  );
}

export function artifactTotalForRun(run: RunSummary) {
  return (run.artifact_counts?.checkpoint ?? 0) + (run.artifact_counts?.rollout ?? 0) + (run.artifact_counts?.file ?? 0);
}

export function runNoteText(run: RunSummary) {
  const keys = ["notes", "note", "description", "summary", "comment"];
  for (const key of keys) {
    const value = run.metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// Composite hover text for a run row so hovering anywhere on the run reveals its
// full name, every tag, and the note — the per-element title attributes only
// covered fragments and were shadowed by the row's "Open <name>" title.
export function runRailTooltip(run: RunSummary) {
  const lines = [run.name];
  const tags = Array.isArray(run.tags) ? run.tags.filter(Boolean) : [];
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  const note = runNoteText(run);
  if (note) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

export function buildCheckpointRows(run: RunSummary | null, artifacts: Artifact[]): CheckpointRow[] {
  if (!run) return [];
  return artifacts
    .filter((artifact) => artifact.type === "checkpoint")
    .sort((left, right) => (left.step ?? -1) - (right.step ?? -1))
    .map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      uri: artifact.uri,
      step: artifact.step === null ? "no step" : `step ${artifact.step}`,
      evalReturn: compactValue(artifact.metadata.eval_return ?? "-"),
    }));
}

export function buildReportRows(savedViews: Array<string | { label: string; value: string }>): ReportRow[] {
  return savedViews.map((view) => {
    const key = typeof view === "string" ? view : view.value;
    const name = typeof view === "string" ? key.replace("instantml:next:view:", "") : view.label;
    const [scope, metric] = name.split(":");
    return {
      id: key,
      name,
      scope: `${scope || "all"} / ${metric || "metric"}`,
    };
  });
}

export function buildApiRows(metricKey: string, project: string, status: string): ApiRow[] {
  return [
    { method: "GET", path: "/projects", description: "List tracked projects." },
    { method: "GET", path: `/api/overview${queryString({ project, status, metric_key: metricKey })}`, description: "Current run and metric summary." },
    { method: "GET", path: `/api/runs/summary${queryString({ project, status, limit: 100, offset: 0 })}`, description: "Paginated run summaries." },
    { method: "GET", path: `/runs/:id/metrics${queryString({ key: metricKey, limit: 1000 })}`, description: "Bounded metric series for one run." },
    { method: "GET", path: "/api/runs/:id/artifacts", description: "Artifacts for one selected run." },
    { method: "GET", path: "/api/runs/:id/objects", description: "Rich object manifests for one selected run." },
    { method: "GET", path: "/api/objects/:id/rows", description: "Bounded table rows for one logged table object." },
    { method: "GET", path: "/api/runs/side-by-side?run_ids=<ids>", description: "Config and metric comparison rows." },
  ];
}

export function formatBytes(value: unknown) {
  const bytes = typeof value === "number" ? value : null;
  if (bytes === null || Number.isNaN(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, 1)} KB`;
  return `${formatNumber(bytes / 1024 / 1024, 1)} MB`;
}
