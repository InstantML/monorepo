// Shared TypeScript type definitions for Notion-style report blocks.
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
  | "panel_grid"
  | "llm_summary";

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

export interface RunsetData {
  name: string;
  /**
   * Cross-project query — a Runset can span multiple projects. The names map
   * to project rows in the org. Empty list = no projects bound yet.
   */
  projects: string[];
  filters?: Record<string, unknown> | null;
  groupby?: string[] | null;
  limit?: number | null;
  frozen_at?: string | null;
  /**
   * Optional explicit list of run IDs to include in the runset regardless of
   * the projects filter. Lets a user pin a specific run (paste a UUID) into
   * a chart so it stays in the view across re-renders.
   */
  pinned_run_ids?: string[] | null;
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

export type PanelData =
  | LinePanelData
  | BarPanelData
  | ScalarPanelData
  | ScatterPanelData;

export type PanelType = PanelData["type"];

export const SUPPORTED_PANEL_TYPES: PanelType[] = [
  "line",
  "bar",
  "scalar",
  "scatter",
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
  }
}

export interface PanelGridBlockData {
  kind: "panel_grid";
  runsets: RunsetData[];
  panels: PanelData[];
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

export const SUPPORTED_CALLOUT_VARIANTS: CalloutVariant[] = ["info", "warn", "success"];
export const SUPPORTED_HEADING_LEVELS: HeadingLevel[] = [1, 2, 3];
export const SUPPORTED_LLM_ANGLES: LlmSummaryAngle[] = [
  "what-worked",
  "outliers",
  "config-diffs",
  "next-steps",
  "free-form",
];
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
    case "llm_summary":
      return { kind: "llm_summary", panelgrid_index: 0, angle: "what-worked" };
  }
}
