import assert from "node:assert/strict";
import test from "node:test";

import {
  createAutoSaveScheduler,
  formatRelativeSavedAt,
} from "../app/dashboard/reports/auto-save-core.js";

/**
 * Tiny synchronous timer harness — lets us step time deterministically
 * without dealing with `node:test`'s fake timer ceremony.
 */
function fakeClock() {
  let nextHandle = 1;
  const queue = new Map();
  return {
    setTimer(cb, ms) {
      const handle = nextHandle++;
      queue.set(handle, { cb, ms });
      return handle;
    },
    clearTimer(handle) {
      queue.delete(handle);
    },
    /** Run every timer whose remaining time is <= `tickMs`. */
    advance(tickMs) {
      const ready = [];
      for (const [handle, entry] of queue.entries()) {
        if (entry.ms <= tickMs) ready.push([handle, entry]);
        else queue.set(handle, { cb: entry.cb, ms: entry.ms - tickMs });
      }
      for (const [handle, entry] of ready) {
        queue.delete(handle);
        entry.cb();
      }
    },
    pending: () => queue.size,
  };
}

test("createAutoSaveScheduler coalesces back-to-back edits into a single flush", async () => {
  const clock = fakeClock();
  const flushed = [];
  const scheduler = createAutoSaveScheduler({
    delayMs: 800,
    flush: (payload) => {
      flushed.push(payload);
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  // Three rapid edits — only one flush should fire when the window elapses.
  scheduler.schedule({ title: "Draft 1" });
  scheduler.schedule({ title: "Draft 2" });
  scheduler.schedule({ title: "Draft 3" });
  assert.equal(flushed.length, 0, "no flush before debounce expires");
  assert.equal(scheduler.hasPending(), true);

  // Step the clock past the debounce window.
  clock.advance(800);
  // Let the microtask attached to `doFlush` settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushed.length, 1, "exactly one flush fired");
  assert.deepEqual(flushed[0], { title: "Draft 3" }, "latest payload wins");
});

test("flushNow forces an immediate save without waiting for the timer", async () => {
  const clock = fakeClock();
  const flushed = [];
  const scheduler = createAutoSaveScheduler({
    delayMs: 800,
    flush: (payload) => {
      flushed.push(payload);
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  scheduler.schedule({ title: "Pending" });
  await scheduler.flushNow();
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0], { title: "Pending" });
});

test("dispose cancels any pending timer and drops the payload", async () => {
  const clock = fakeClock();
  const flushed = [];
  const scheduler = createAutoSaveScheduler({
    delayMs: 800,
    flush: (payload) => flushed.push(payload),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  scheduler.schedule({ title: "Will not save" });
  scheduler.dispose();
  clock.advance(800);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushed.length, 0);
  assert.equal(scheduler.hasPending(), false);
});

test("formatRelativeSavedAt produces human-friendly strings", () => {
  const now = 100_000;
  assert.equal(formatRelativeSavedAt(now, now - 1_000), "just now");
  assert.equal(formatRelativeSavedAt(now, now - 5_000), "5s ago");
  assert.equal(formatRelativeSavedAt(now, now - 90_000), "2m ago");
  assert.equal(formatRelativeSavedAt(now, now - 3 * 3600_000), "3h ago");
});
