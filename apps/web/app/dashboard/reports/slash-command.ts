/**
 * TypeScript-typed wrapper for the slash-command core. The pure-JS helpers
 * live in `slash-command-core.js` so node --test can import them without a
 * TS build step; this file types them and exposes downstream-friendly
 * interfaces.
 */

import {
  detectSlashTrigger as detectSlashTriggerCore,
  filterBlockPicker as filterBlockPickerCore,
  resolvePickerKind as resolvePickerKindCore,
  BLOCK_PICKER_CATALOG as BLOCK_PICKER_CATALOG_CORE,
} from "./slash-command-core.js";

export interface SlashTriggerResult {
  active: boolean;
  query: string;
  triggerOffset: number;
}

export interface BlockPickerEntry {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
}

export interface ResolvedPickerKind {
  kind:
    | "heading"
    | "paragraph"
    | "markdown"
    | "code"
    | "callout"
    | "horizontal_rule"
    | "image"
    | "panel_grid";
  headingLevel?: 1 | 2 | 3;
}

export function detectSlashTrigger(text: string, caret: number): SlashTriggerResult {
  return detectSlashTriggerCore(text, caret) as SlashTriggerResult;
}

export function filterBlockPicker<T extends BlockPickerEntry>(
  query: string,
  entries: readonly T[],
): T[] {
  return filterBlockPickerCore(query, entries as unknown as BlockPickerEntry[]) as T[];
}

export function resolvePickerKind(id: string): ResolvedPickerKind | null {
  return resolvePickerKindCore(id) as ResolvedPickerKind | null;
}

export const BLOCK_PICKER_CATALOG: readonly BlockPickerEntry[] =
  BLOCK_PICKER_CATALOG_CORE as readonly BlockPickerEntry[];
