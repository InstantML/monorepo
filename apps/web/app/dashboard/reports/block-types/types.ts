// Shared TypeScript type definitions for block-based report blocks.
// Mirrors the Rust block validation in apps/rust-server/src/store/reports/.

export type HeadingLevel = 1 | 2 | 3;
export type CalloutVariant = "info" | "warn" | "success";
export type LlmSummaryAngle =
  | "what-worked"
  | "outliers"
  | "config-diffs"
  | "next-steps"
  | "free-form";
export type CodeLanguage =
  | "python"
  | "javascript"
  | "typescript"
  | "json"
  | "yaml"
  | "markdown"
  | "rust"
  | "bash"
  | "sql"
  | "plain";

export type ReportBlockKind =
  | "heading"
  | "paragraph"
  | "markdown"
  | "code"
  | "callout"
  | "horizontal_rule"
  | "image"
  | "panel_grid";

export interface HeadingBlockData {
  kind: "heading";
  level: HeadingLevel;
  text: string;
}

export interface ParagraphBlockData {
  kind: "paragraph";
  text: string;
}

export interface MarkdownBlockData {
  kind: "markdown";
  text: string;
}

export interface CodeBlockData {
  kind: "code";
  language: CodeLanguage;
  code: string;
}

export interface CalloutBlockData {
  kind: "callout";
  variant: CalloutVariant;
  text: string;
}

export interface HorizontalRuleBlockData {
  kind: "horizontal_rule";
}

export interface ImageBlockData {
  kind: "image";
  url: string;
  caption?: string;
}

/**
 * Per-run rendering settings persisted on a Runset. `color` picks the chart
 * color; `disabled` excludes a run from chart aggregations entirely (also
 * unchecks it in the run-set table); `hidden` keeps the run in the runset
 * spec but suppresses it from chart rendering (eye-closed in the table).
 */
export interface RunsetRunSettings {
  color?: string | null;
  disabled?: boolean | null;
  hidden?: boolean | null;
}

export interface RunsetFilters {
  /** Subset of run.status values to include. Empty / undefined ⇒ no filter. */
  status?: string[] | null;
  /** Subset of run.project values to include (in addition to projects[]). */
  projects?: string[] | null;
  [key: string]: unknown;
}

export interface RunsetData {
  name: string;
  /**
   * Cross-project query — a Runset can span multiple projects. The names map
   * to project rows in the org. Empty list = no projects bound yet.
   */
  projects: string[];
  filters?: RunsetFilters | null;
  /**
   * Optional grouping key: a config field path (e.g. `config.lr`) or a
   * summary metric (`summary.val_acc`). When set, chart renderers aggregate
   * to one series per group instead of one per run.
   */
  groupby?: string | null;
  /** Sort order key, applied to the resolved run list. */
  order?: string | null;
  limit?: number | null;
  frozen_at?: string | null;
  /**
   * Optional explicit list of run IDs to include in the runset regardless of
   * the projects filter. Lets a user pin a specific run (paste a UUID) into
   * a chart so it stays in the view across re-renders.
   */
  pinned_run_ids?: string[] | null;
  /**
   * Per-run render settings keyed by run id (UUID or pinned shorthand). Used
   * by the run-set table to persist color, disabled, hidden flags.
   */
  run_settings?: Record<string, RunsetRunSettings> | null;
}

export interface LinePanelData {
  type: "line";
  metric_key: string;
  runset_index: number;
  smoothing?: number | null;
}

export interface BarPanelData {
  type: "bar";
  metric_key: string;
  runset_index: number;
  group_by?: string | null;
}

export type ScalarAggregation = "min" | "max" | "mean" | "latest";

export interface ScalarPanelData {
  type: "scalar";
  metric_key: string;
  runset_index: number;
  agg: ScalarAggregation;
}

export interface ScatterPanelData {
  type: "scatter";
  x_metric: string;
  y_metric: string;
  runset_index: number;
  color_by?: string | null;
}

export interface ParallelCoordinatesDimension {
  /** Either a metric key (`summary.val_acc`) or a config key (`config.lr`). */
  metric_key?: string | null;
  config_key?: string | null;
}

export interface ParallelCoordinatesPanelData {
  type: "parallel_coordinates";
  dimensions: ParallelCoordinatesDimension[];
  runset_index: number;
}

export interface RunComparerPanelData {
  type: "run_comparer";
  run_ids: string[];
  fields: string[];
  runset_index: number;
}

export interface MarkdownPanelData {
  type: "markdown_panel";
  text: string;
}

export interface CodePanelData {
  type: "code_panel";
  code: string;
  language: string;
}

export interface ImagePanelData {
  type: "image_panel";
  url: string;
  caption?: string | null;
}

export type PanelData =
  | LinePanelData
  | BarPanelData
  | ScalarPanelData
  | ScatterPanelData
  | ParallelCoordinatesPanelData
  | RunComparerPanelData
  | MarkdownPanelData
  | CodePanelData
  | ImagePanelData;

export type PanelType = PanelData["type"];

export const SUPPORTED_PANEL_TYPES: PanelType[] = [
  "line",
  "bar",
  "scalar",
  "scatter",
  "parallel_coordinates",
  "run_comparer",
  "markdown_panel",
  "code_panel",
  "image_panel",
];

/**
 * Catalog of panel cells shown in the add-panel picker. Keep this limited to
 * implemented panels so the report editor does not advertise placeholder
 * roadmap surface.
 */
export type PanelPickerCategory = "charts" | "media" | "data";

export interface PanelPickerEntry {
  type: PanelType | string;
  label: string;
  category: PanelPickerCategory;
  /** When true, the cell is interactive and adds a real panel. */
  implemented: boolean;
}

export const PANEL_PICKER_CATALOG: PanelPickerEntry[] = [
  { type: "line", label: "Line", category: "charts", implemented: true },
  { type: "bar", label: "Bar", category: "charts", implemented: true },
  { type: "scalar", label: "Scalar", category: "charts", implemented: true },
  { type: "scatter", label: "Scatter", category: "charts", implemented: true },
  {
    type: "parallel_coordinates",
    label: "Parallel coords",
    category: "charts",
    implemented: true,
  },
  { type: "run_comparer", label: "Run comparer", category: "charts", implemented: true },
  { type: "code_panel", label: "Code", category: "charts", implemented: true },
  { type: "markdown_panel", label: "Markdown", category: "charts", implemented: true },
  { type: "image_panel", label: "Image", category: "media", implemented: true },
];

export const SUPPORTED_SCALAR_AGGREGATIONS: ScalarAggregation[] = [
  "min",
  "max",
  "mean",
  "latest",
];

export function defaultPanel(type: PanelType): PanelData {
  switch (type) {
    case "line":
      return { type: "line", metric_key: "", runset_index: 0 };
    case "bar":
      return { type: "bar", metric_key: "", runset_index: 0 };
    case "scalar":
      return {
        type: "scalar",
        metric_key: "",
        runset_index: 0,
        agg: "latest",
      };
    case "scatter":
      return {
        type: "scatter",
        x_metric: "",
        y_metric: "",
        runset_index: 0,
      };
    case "parallel_coordinates":
      return {
        type: "parallel_coordinates",
        dimensions: [],
        runset_index: 0,
      };
    case "run_comparer":
      return {
        type: "run_comparer",
        run_ids: [],
        fields: [],
        runset_index: 0,
      };
    case "markdown_panel":
      return { type: "markdown_panel", text: "" };
    case "code_panel":
      return { type: "code_panel", code: "", language: "python" };
    case "image_panel":
      return { type: "image_panel", url: "", caption: "" };
  }
}

/**
 * Org-wide panel inventory entry surfaced by `/api/reports/panels` and the
 * "from other reports" tab of the add-panel picker.
 */
export interface PanelInventoryEntry {
  report_id: string;
  report_title: string;
  panel_index: number;
  panel_spec: PanelData;
}

export interface PanelGridBlockData {
  kind: "panel_grid";
  runsets: RunsetData[];
  panels: PanelData[];
}

export interface InRunsetCandidate {
  /** Index in the parent report's blocks array. */
  blockIndex: number;
  /** Display title, typically a nearby heading or "PanelGrid #N". */
  label: string;
  /** Index of the panel inside that grid. */
  panelIndex: number;
  panel: PanelData;
}

export interface LlmSummaryBlockData {
  kind: "llm_summary";
  panelgrid_index: number;
  angle: LlmSummaryAngle;
  custom_prompt?: string;
  generated_at?: string;
  generated_text?: string;
  provider?: string;
}

export type ReportBlock =
  | HeadingBlockData
  | ParagraphBlockData
  | MarkdownBlockData
  | CodeBlockData
  | CalloutBlockData
  | HorizontalRuleBlockData
  | ImageBlockData
  | PanelGridBlockData
  | LlmSummaryBlockData;

export interface ReportRecord {
  id: string;
  org_id: string;
  project_id: string | null;
  title: string;
  description?: string | null;
  blocks: ReportBlock[];
  created_at: string;
  updated_at: string;
  author_user_id?: string | null;
  share_token?: string | null;
  visibility: "private" | "org" | "public";
}

export interface ReportSummary {
  id: string;
  title: string;
  description?: string | null;
  project_id?: string | null;
  visibility: string;
  has_share_token: boolean;
  author_user_id?: string | null;
  created_at: string;
  updated_at: string;
  block_count: number;
}

/**
 * 8-color accent palette for the run-set table color dot picker. First slot
 * is the dashboard's primary accent token (Bolt-green); the rest are
 * distinguishable hues that pair well against the surface tokens.
 */
export const RUN_COLOR_PALETTE: string[] = [
  "#5d89dd",
  "#dc5b55",
  "#f59e0b",
  "#8b7cf6",
  "#2ec4b6",
  "#10b981",
  "#ec4899",
  "#6366f1",
];

export const SUPPORTED_CALLOUT_VARIANTS: CalloutVariant[] = ["info", "warn", "success"];
export const SUPPORTED_HEADING_LEVELS: HeadingLevel[] = [1, 2, 3];
export const SUPPORTED_CODE_LANGUAGES: CodeLanguage[] = [
  "python",
  "javascript",
  "typescript",
  "json",
  "yaml",
  "markdown",
  "rust",
  "bash",
  "sql",
  "plain",
];

export function defaultBlock(kind: ReportBlockKind): ReportBlock {
  switch (kind) {
    case "heading":
      return { kind: "heading", level: 1, text: "Heading" };
    case "paragraph":
      return { kind: "paragraph", text: "" };
    case "markdown":
      return { kind: "markdown", text: "" };
    case "code":
      return { kind: "code", language: "python", code: "" };
    case "callout":
      return { kind: "callout", variant: "info", text: "" };
    case "horizontal_rule":
      return { kind: "horizontal_rule" };
    case "image":
      return { kind: "image", url: "", caption: "" };
    case "panel_grid":
      return {
        kind: "panel_grid",
        runsets: [{ name: "runset-1", projects: [] }],
        panels: [],
      };
  }
}
