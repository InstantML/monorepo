"use client";

/**
 * React wrapper around the pure-JS history controller. Mirrors the
 * `auto-save.ts` ↔ `auto-save-core.js` split: the runtime is JS so
 * `node --test` can import it directly; this file adds the React-shaped
 * surface (useRef-backed controller + useState-backed canUndo/canRedo).
 *
 * Usage:
 *
 *   const history = useReportHistory(initialSnapshotFromReport);
 *
 *   // After every editor change:
 *   history.push(snapshotFromReport(next), classifySnapshotMode(prev, next));
 *
 *   // On blur or before navigation:
 *   history.flush();
 *
 *   // Cmd-Z / Cmd-Shift-Z:
 *   const restored = history.undo();
 *   if (restored) onChange(restored);
 *
 *   // On report-switch:
 *   useEffect(() => history.reset(newInitial), [reportId]);
 *
 * Past + future stacks live in a `useRef` so each push doesn't re-render
 * the entire editor. A tiny `useState` mirrors `canUndo` / `canRedo` so the
 * toolbar pill stays in sync without forcing the editor to subscribe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createHistoryController } from "./report-history-core.js";
import type { ReportBlock, ReportRecord } from "./block-types";

export type HistorySnapshot = {
  title: string;
  description: string;
  visibility: ReportRecord["visibility"];
  blocks: ReportBlock[];
};

export type HistoryPushMode = "immediate" | "coalesce";

export interface HistoryController {
  /** True when there's a past state to revert to (or a pending debounce). */
  canUndo: boolean;
  /** True when there's a future state to redo to. */
  canRedo: boolean;
  /**
   * Snapshot the current state. Call:
   *   - "immediate" for structural mutations (insert/delete/reorder, kind
   *     swap, visibility/title/description, panel-grid edits)
   *   - "coalesce" for text typing in paragraph/markdown/heading/code/
   *     callout body fields — these collapse into one snapshot per 500 ms
   *     quiet period.
   * Calling `push` with an identical-to-current snapshot is a no-op.
   */
  push: (snapshot: HistorySnapshot, mode: HistoryPushMode) => void;
  /** Drain any pending coalesce — e.g. before a blur or navigation. */
  flush: () => void;
  /** Pop the past stack onto current. Returns the restored snapshot. */
  undo: () => HistorySnapshot | null;
  /** Pop the future stack onto current. Returns the restored snapshot. */
  redo: () => HistorySnapshot | null;
  /** Wipe both stacks + cancel pending debounce. Used on report-switch. */
  reset: (initial: HistorySnapshot) => void;
}

interface CoreController {
  push(snapshot: HistorySnapshot, mode: HistoryPushMode): void;
  flush(): void;
  undo(): HistorySnapshot | null;
  redo(): HistorySnapshot | null;
  reset(snapshot: HistorySnapshot): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export function useReportHistory(initial: HistorySnapshot): HistoryController {
  // The controller itself is stable across the lifetime of the editor.
  // We rebuild it only when the consumer calls `reset` with a new initial.
  const [stackState, setStackState] = useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  });

  const refreshFlags = useCallback(() => {
    const c = controllerRef.current;
    if (!c) return;
    setStackState((current) => {
      const next = { canUndo: c.canUndo(), canRedo: c.canRedo() };
      if (current.canUndo === next.canUndo && current.canRedo === next.canRedo) {
        return current;
      }
      return next;
    });
  }, []);

  // Build once. We deliberately don't depend on `initial` — the consumer
  // calls `reset` explicitly when the report changes, which is the only
  // moment the controller's identity should change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const controllerRef = useRef<CoreController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createHistoryController(initial, {
      onChange: refreshFlags,
    }) as CoreController;
  }

  // Mirror the initial flags into state on first mount.
  useEffect(() => {
    refreshFlags();
  }, [refreshFlags]);

  // Stable callbacks — the controller methods are bound to `controllerRef`.
  const push = useCallback(
    (snapshot: HistorySnapshot, mode: HistoryPushMode) => {
      controllerRef.current?.push(snapshot, mode);
    },
    [],
  );
  const flush = useCallback(() => {
    controllerRef.current?.flush();
  }, []);
  const undo = useCallback(() => {
    return controllerRef.current?.undo() ?? null;
  }, []);
  const redo = useCallback(() => {
    return controllerRef.current?.redo() ?? null;
  }, []);
  const reset = useCallback((next: HistorySnapshot) => {
    controllerRef.current?.reset(next);
  }, []);

  return useMemo<HistoryController>(
    () => ({
      canUndo: stackState.canUndo,
      canRedo: stackState.canRedo,
      push,
      flush,
      undo,
      redo,
      reset,
    }),
    [stackState.canUndo, stackState.canRedo, push, flush, undo, redo, reset],
  );
}

/**
 * Helper for callers: build a `HistorySnapshot` from a `ReportRecord`-shaped
 * value. Normalizes `description` to a string (the editor model treats
 * undefined and "" identically).
 */
export function snapshotFromReport(
  report: Pick<ReportRecord, "title" | "description" | "blocks" | "visibility">,
): HistorySnapshot {
  return {
    title: report.title,
    description: report.description ?? "",
    visibility: report.visibility,
    blocks: report.blocks,
  };
}
