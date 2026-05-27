/**
 * Pure-JS core for the auto-save scheduler. Kept JS so node --test can
 * import it directly. The TS re-exports a typed wrapper from
 * `auto-save.ts`.
 */

export function createAutoSaveScheduler({
  delayMs,
  flush,
  setTimer,
  clearTimer,
} = {}) {
  const setT = setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = clearTimer ?? ((handle) => clearTimeout(handle));
  let pending = null;
  let timer = null;
  let flushing = false;

  function clear() {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  }

  async function doFlush() {
    if (!pending) return;
    const next = pending.payload;
    pending = null;
    flushing = true;
    try {
      await flush(next);
    } finally {
      flushing = false;
    }
  }

  return {
    schedule(payload) {
      pending = { payload };
      clear();
      timer = setT(() => {
        timer = null;
        void doFlush();
      }, delayMs);
    },
    flushNow() {
      clear();
      return doFlush();
    },
    dispose() {
      clear();
      pending = null;
    },
    isFlushing() {
      return flushing;
    },
    hasPending() {
      return pending !== null;
    },
  };
}

export function formatRelativeSavedAt(now, savedAt) {
  const deltaSec = Math.max(0, Math.round((now - savedAt) / 1000));
  if (deltaSec < 2) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  return new Date(savedAt).toLocaleString();
}
