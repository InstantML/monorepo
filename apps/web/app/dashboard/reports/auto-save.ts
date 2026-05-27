/**
 * Typed wrapper around the pure-JS auto-save scheduler core. The TS surface
 * here is documentation + types — the runtime lives in
 * `auto-save-core.js`.
 *
 *   const scheduler = createAutoSaveScheduler({ delayMs: 800, flush });
 *   scheduler.schedule(payload);   // queues a save 800 ms in the future
 *   scheduler.schedule(payload2);  // back-to-back edits coalesce
 *   scheduler.flushNow();          // forces an immediate flush
 *   scheduler.dispose();           // cancels any pending timer
 *
 * Rapid edits collapse into one `flush()` call carrying the latest payload.
 */

import {
  createAutoSaveScheduler as createCore,
  formatRelativeSavedAt as formatCore,
} from "./auto-save-core.js";

export type AutoSaveFlush<T> = (payload: T) => Promise<void> | void;

export interface AutoSaveOptions<T> {
  delayMs: number;
  flush: AutoSaveFlush<T>;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface AutoSaveScheduler<T> {
  schedule(payload: T): void;
  flushNow(): Promise<void> | void;
  dispose(): void;
  isFlushing(): boolean;
  hasPending(): boolean;
}

export function createAutoSaveScheduler<T>(
  options: AutoSaveOptions<T>,
): AutoSaveScheduler<T> {
  return createCore(options) as AutoSaveScheduler<T>;
}

export function formatRelativeSavedAt(now: number, savedAt: number): string {
  return formatCore(now, savedAt) as string;
}
