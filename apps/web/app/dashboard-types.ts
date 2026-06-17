import type { components } from "../src/types/api.generated";

type GeneratedArtifactCollectionSummary = components["schemas"]["ArtifactCollectionSummary"];
type GeneratedArtifactVersion = components["schemas"]["PublicArtifactVersionRow"];
type GeneratedArtifactManifestEntry = components["schemas"]["PublicArtifactManifestEntryRow"];
export type RunControlSummary = components["schemas"]["RunControlSummary"];

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
  run_control?: RunControlSummary | null;
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
  stopping_runs?: number;
  stopped_runs?: number;
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
  run_id?: string;
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

export type ArtifactVersion = Omit<GeneratedArtifactVersion, "metadata"> & {
  metadata: Record<string, unknown>;
};

export type ArtifactCollection = Omit<GeneratedArtifactCollectionSummary, "metadata" | "latest_version" | "best_version"> & {
  metadata: Record<string, unknown>;
  latest_version?: ArtifactVersion | null;
  best_version?: ArtifactVersion | null;
};

export type ArtifactManifestEntry = GeneratedArtifactManifestEntry;

export type ArtifactCollectionsEnvelope = components["schemas"]["ArtifactCollectionsEnvelope"];
export type ArtifactVersionsEnvelope = components["schemas"]["ArtifactVersionsEnvelope"];
export type ArtifactVersionEnvelope = components["schemas"]["ArtifactVersionEnvelope"];
export type ArtifactManifestEnvelope = components["schemas"]["ArtifactManifestEnvelope"];

export type ArtifactLineageNode = {
  id: string;
  kind: string;
  label: string;
  state?: string | null;
  summary?: Record<string, unknown>;
};

export type ArtifactLineageEdge = {
  from: string;
  to: string;
  direction?: string;
};

export type ArtifactLineageGraph = {
  nodes: ArtifactLineageNode[];
  edges: ArtifactLineageEdge[];
  truncated?: boolean;
  limit?: number;
  depth?: number;
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
    storage_backend?: string | null;
  } | null;
  created_at: string;
};

export type LoggedObjectRow = {
  row_index: number;
  row: Record<string, unknown>;
  created_at: string;
};

export type HistogramTimelineFrame = {
  id: number;
  key: string;
  step: number;
  bins: number[];
  counts: number[];
  total: number;
};

export type HistogramTimelineState = {
  runId: string;
  objectKey: string;
  frames: HistogramTimelineFrame[];
  invalid: number;
  truncated: boolean;
  compatibleBins: boolean;
  capped?: boolean;
  loading?: boolean;
  error?: string;
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
  | "overview"
  | "runs"
  | "metrics"
  | "distributed"
  | "detail"
  | "compare"
  | "alerts"
  | "datasets"
  | "imports"
  | "insights"
  | "artifacts"
  | "reports"
  | "settings"
  | "api";

export type Tone = "good" | "bad" | "live" | "neutral" | "warn";

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

export type ReportRow = {
  id: string;
  name: string;
  scope: string;
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
export type WorkspacePanelType =
  | "line"
  | "bar"
  | "histogram"
  | "dot"
  | "scatter"
  | "distribution"
  | "histogram_timeline";

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

type BaseWorkspacePanel = {
  id: string;
  title: string;
  metricKey: string;
  layout?: WorkspacePanelLayout;
  settings?: Partial<WorkspacePanelSettings>;
};

export type LineWorkspacePanel = BaseWorkspacePanel & {
  type: "line";
  xField?: never;
  yField?: never;
  valueField?: never;
  groupField?: never;
  replicateField?: never;
  axisFields?: never;
  axisScales?: never;
  objectKey?: never;
};

export type SummaryWorkspacePanel = BaseWorkspacePanel & {
  type: "bar" | "histogram" | "dot";
  xField?: never;
  yField?: never;
  valueField?: never;
  groupField?: never;
  replicateField?: never;
  axisFields?: never;
  axisScales?: never;
  objectKey?: never;
};

export type ScatterWorkspacePanel = BaseWorkspacePanel & {
  type: "scatter";
  xField: string;
  yField: string;
  valueField?: never;
  groupField?: never;
  replicateField?: never;
  axisFields?: never;
  axisScales?: never;
  objectKey?: never;
};

export type DistributionWorkspacePanel = BaseWorkspacePanel & {
  type: "distribution";
  valueField: string;
  groupField?: string;
  replicateField?: string;
  xField?: never;
  yField?: never;
  axisFields?: never;
  axisScales?: never;
  objectKey?: never;
};

export type HistogramTimelineWorkspacePanel = BaseWorkspacePanel & {
  type: "histogram_timeline";
  objectKey: string;
  xField?: never;
  yField?: never;
  valueField?: never;
  groupField?: never;
  replicateField?: never;
  axisFields?: never;
  axisScales?: never;
};

export type WorkspacePanel =
  | LineWorkspacePanel
  | SummaryWorkspacePanel
  | ScatterWorkspacePanel
  | DistributionWorkspacePanel
  | HistogramTimelineWorkspacePanel;

export type WorkspaceFieldSource = "metric" | "config" | "metadata" | "run";

export type WorkspaceFieldOption = {
  id: string;
  label: string;
  source: WorkspaceFieldSource;
  valueType: "number";
  availableCount: number;
  missingCount: number;
};

export type WorkspaceCategoricalFieldOption = {
  id: string;
  label: string;
  source: WorkspaceFieldSource;
  valueType: "category";
  availableCount: number;
  missingCount: number;
  groupCount: number;
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
