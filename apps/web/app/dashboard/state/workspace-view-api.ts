import {
  workspaceViewFromPayload as workspaceViewFromPayloadRaw,
  workspaceViewSummariesFromPayload as workspaceViewSummariesFromPayloadRaw,
} from "../../../src/workspace-view-api.js";
import type { components } from "../../../src/types/api.generated";

export type WorkspaceViewSummaryRow = components["schemas"]["WorkspaceViewSummary"];
export type WorkspaceViewRow = components["schemas"]["WorkspaceViewRow"];

export function workspaceViewSummariesFromPayload(payload: unknown): WorkspaceViewSummaryRow[] {
  return workspaceViewSummariesFromPayloadRaw(payload) as WorkspaceViewSummaryRow[];
}

export function workspaceViewFromPayload(payload: unknown): WorkspaceViewRow | null {
  return workspaceViewFromPayloadRaw(payload) as WorkspaceViewRow | null;
}
