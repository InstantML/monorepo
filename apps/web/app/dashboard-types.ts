import type { LucideIcon } from "lucide-react";

export type RunSummary = {
  id: string;
  project: string;
  name: string;
  status: string;
  tags: string[];
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string;
  finished_at: string | null;
  parent_run_id?: string | null;
  forked_from_step?: number | null;
  forked_from_artifact_id?: string | null;
  latest_metrics: Record<string, number>;
  metric_aggregates: Record<string, Record<string, number>>;
  artifact_counts: { checkpoint: number; rollout: number; file: number };
};

export type Summary = {
  runs: RunSummary[];
  metric_keys: string[];
  total: number;
  next_cursor?: string | null;
  page_info?: {
    pagination?: string;
    has_next_page?: boolean;
  };
};

export type Overview = {
  total_runs: number;
  active_runs: number;
  failed_runs: number;
  best_eval_return: number | null;
  metric_points: number;
};

export type MetricPoint = {
  key: string;
  step: number;
  value: number;
  created_at: string;
  smoothedValue?: number;
};

export type MetricSeries = {
  id: string;
  name: string;
  identifier?: string;
  group: string;
  smoothed?: boolean;
  points: MetricPoint[];
};

export type Artifact = {
  id: string;
  type: string;
  name: string;
  uri: string;
  step: number | null;
  size_bytes?: number | null;
  sha256?: string | null;
  mime_type?: string | null;
  storage_backend?: string | null;
  metadata: Record<string, unknown>;
};

export type RunLineage = {
  run: RunSummary;
  parent: RunSummary | null;
  children: RunSummary[];
  checkpoint_artifact?: Artifact | null;
  children_total: number;
  has_more_children: boolean;
  limit: number;
};

export type LoggedObject = {
  id: number;
  run_id: string;
  key: string;
  kind: "table" | "image" | "video" | "audio" | "histogram" | string;
  step: number | null;
  value: unknown;
  metadata: Record<string, unknown>;
  summary: Record<string, unknown>;
  artifact_id?: string | null;
  artifact?: {
    id: string;
    name?: string | null;
    uri?: string | null;
    mime_type?: string | null;
    size_bytes?: number | null;
  } | null;
  created_at: string;
};

export type LoggedObjectRow = {
  row_index: number;
  row: Record<string, unknown>;
  created_at: string;
};

export type HoverPoint = {
  runId: string;
  runName: string;
  identifier?: string;
  group?: string;
  point: MetricPoint & {
    x: number;
    y: number;
    xValue: number;
    smoothedValue?: number;
    ySmoothed?: number;
    displayY?: number;
  };
  distance: number;
} | null;

export type TableColumns = {
  status: boolean;
  tags: boolean;
  notes: boolean;
  started: boolean;
  duration: boolean;
  latest: boolean;
};

export type CompareLayout = "auto" | "columns" | "rows";

export type CompareRowSort = "signal" | "changed" | "missing" | "category" | "name" | "spread";

export type CompareRunSort =
  | "selected"
  | "name"
  | "newest"
  | "status"
  | "duration"
  | "metric-latest"
  | "metric-best"
  | "artifacts"
  | "tags"
  | "notes"
  | "config";

export type TabId =
  | "runs"
  | "metrics"
  | "distributed"
  | "advanced"
  | "detail"
  | "compare"
  | "alerts"
  | "datasets"
  | "insights"
  | "artifacts"
  | "models"
  | "reports"
  | "settings"
  | "integrations"
  | "api";

export type Tone = "good" | "bad" | "live" | "neutral";

export type AlertRow = {
  id: string;
  severity: string;
  tone: Tone;
  title: string;
  detail: string;
  label: string;
};

export type DatasetRow = {
  name: string;
  runs: number;
  seeds: string[];
  best: number | null;
};

export type ModelRow = {
  id: string;
  name: string;
  uri: string;
  step: string;
  evalReturn: string;
};

export type ReportRow = {
  id: string;
  name: string;
  scope: string;
};

export type IntegrationRow = {
  name: string;
  status: string;
  tone: Tone;
  icon: LucideIcon;
  detail: string;
};

export type ApiRow = {
  method: string;
  path: string;
  description: string;
};

export type MetricCatalogRow = {
  key: string;
  label: string;
  namespace: string;
  runCount: number;
  selectedCount: number;
  pointCount: number;
  latest: number | null;
  best: number | null;
  min: number | null;
  mean: number | null;
  bestStep: number | null;
  bestRunName: string;
};

export type RunMetricRow = {
  key: string;
  latest: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  count: number;
  latestStep: number | null;
  bestStep: number | null;
};

export type RunTimelineRow = {
  id: string;
  label: string;
  detail: string;
  value: string;
  tone: Tone;
};

export type WorkspaceMode = "automatic" | "manual";
export type WorkspacePanelType = "line" | "bar" | "histogram" | "dot";

export type WorkspacePanelSettings = {
  xMode: "step" | "time";
  smoothing: number;
  groupBy: string;
  groupAverage: boolean;
  maxRuns: number;
};

export type WorkspacePanelLayout = {
  w: number;
  h: number;
};

export type WorkspacePanel = {
  id: string;
  type: WorkspacePanelType;
  title: string;
  metricKey: string;
  layout?: WorkspacePanelLayout;
  settings?: Partial<WorkspacePanelSettings>;
};

export type WorkspaceSection = {
  id: string;
  name: string;
  collapsed: boolean;
  settings?: Partial<WorkspacePanelSettings>;
  panels: WorkspacePanel[];
};

export type WorkspaceView = {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  mode: WorkspaceMode;
  project: string | null;
  settings: WorkspacePanelSettings & {
    hideEmptySections: boolean;
    sectionOrganization: "prefix" | "manual";
  };
  sections: WorkspaceSection[];
  updatedAt: string;
};
