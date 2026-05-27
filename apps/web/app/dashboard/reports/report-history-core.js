/**
 * Pure-JS core for the report editor's undo/redo history. Kept JS so
 * `node --test` can import it directly. The TS-typed React wrapper lives in
 * `use-report-history.ts`.
 *
 * Architecture: coalesced snapshots + bounded stacks + structural cloning.
 *
 *   - Snapshots are plain JSON-cloneable objects: title, description,
 *     visibility, blocks. At report scale (≤ 200 blocks, ~50 KB JSON) a
 *     `JSON.parse(JSON.stringify(...))` clone is sub-millisecond.
 *   - Text mutations (paragraph/markdown/heading body, code body, callout
 *     body) coalesce into one snapshot per 500 ms quiet period — that's the
 *     "undo a typing burst" behavior users expect from doc editors.
 *   - Structural mutations (insert/delete/reorder/visibility/block-kind
 *     swap, panel-grid edits) snapshot immediately. They always represent a
 *     distinct user intent.
 *   - Past + future stacks are each capped at 50 entries; the oldest is
 *     dropped when we exceed the cap. Memory ceiling: ~50 * 50 KB = 2.5 MB
 *     per stack ≈ 5 MB total ceiling at the editor's 200-block cap.
 *
 *   const history = createHistoryController(initialSnapshot, { delayMs: 500 });
 *   history.push(snapshot, "coalesce");   // debounced — collapses typing
 *   history.push(snapshot, "immediate");  // flushes pending + pushes now
 *   history.undo();                       // returns previous snapshot or null
 *   history.redo();                       // returns next snapshot or null
 *   history.flush();                      // drain any pending debounce
 *   history.reset(snapshot);              // clear stacks (report-switch)
 *   history.canUndo();                    // boolean
 *   history.canRedo();                    // boolean
 */

export const HISTORY_DEFAULT_DELAY_MS = 500;
export const HISTORY_STACK_LIMIT = 50;

/**
 * Deep clone a snapshot. The report shape is JSON-safe (no Dates, no Maps,
 * no functions, no undefined-as-meaningful) so structuredClone or
 * JSON.parse(JSON.stringify(...)) both work. We use JSON.* because:
 *   1. structuredClone is missing in the older test runtime
 *   2. JSON.* is consistent across browser + node + node --test
 *   3. It naturally drops `undefined` fields, which we don't carry
 */
export function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

/**
 * Cheap shallow-ish equality check for two snapshots. Two snapshots are
 * "identical" for history purposes if their JSON serializations match.
 * This is exactly the check we need: if the next snapshot would round-trip
 * to the same bytes as the top of the past stack, pushing it again is
 * pointless and pollutes the undo history.
 */
export function snapshotsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createHistoryController(initial, options = {}) {
  const delayMs = options.delayMs ?? HISTORY_DEFAULT_DELAY_MS;
  const stackLimit = options.stackLimit ?? HISTORY_STACK_LIMIT;
  const setT = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const onChange = options.onChange ?? (() => {});

  // The "current" snapshot — the one the editor is rendering right now.
  // undo() pops past onto this; redo() pulls from future onto this.
  let current = cloneSnapshot(initial);
  let past = []; // oldest first; the most-recent-past snapshot is at the end.
  let future = []; // most-recent-future at the end too.
  let pending = null; // { snapshot } when a coalesce-mode push is in flight.
  let timer = null;

  function clearTimer() {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  }

  function commitPendingToPast() {
    // The pending snapshot was the "live" state when push("coalesce") was
    // called. The previous `current` is what should go onto the past stack;
    // pending replaces `current`. (See `push` for the wiring.)
    if (!pending) return;
    const previous = current;
    current = pending.snapshot;
    pending = null;
    // Skip identical-to-top snapshots — they add no information.
    if (past.length > 0 && snapshotsEqual(past[past.length - 1], previous)) {
      return;
    }
    past.push(previous);
    if (past.length > stackLimit) past.shift();
    // Any new push (coalesced or immediate) invalidates the redo stack.
    if (future.length > 0) future = [];
    onChange();
  }

  function pushImmediate(snapshot) {
    // Drain any pending debounce first so order is preserved.
    if (pending) {
      clearTimer();
      commitPendingToPast();
    }
    if (snapshotsEqual(current, snapshot)) return;
    if (past.length > 0 && snapshotsEqual(past[past.length - 1], current)) {
      // Top of past already equals what we'd push — collapse.
      current = cloneSnapshot(snapshot);
    } else {
      past.push(current);
      if (past.length > stackLimit) past.shift();
      current = cloneSnapshot(snapshot);
    }
    if (future.length > 0) future = [];
    onChange();
  }

  function pushCoalesce(snapshot) {
    // First coalesced edit since the last commit: stash the candidate;
    // schedule a timer to commit it to the past stack on quiet.
    // Subsequent coalesced edits before the timer fires just replace the
    // candidate, restarting the timer.
    if (snapshotsEqual(current, snapshot)) {
      // No-op — same state, no point waking the timer.
      return;
    }
    pending = { snapshot: cloneSnapshot(snapshot) };
    clearTimer();
    timer = setT(() => {
      timer = null;
      commitPendingToPast();
    }, delayMs);
  }

  return {
    push(snapshot, mode) {
      if (mode === "immediate") pushImmediate(snapshot);
      else pushCoalesce(snapshot);
    },
    flush() {
      if (!pending) return;
      clearTimer();
      commitPendingToPast();
    },
    undo() {
      // Flush any pending coalesce first so the undo target is correct.
      // (If the user holds Cmd-Z while typing, we don't want to skip over
      // an unsnapshotted burst.)
      if (pending) {
        clearTimer();
        commitPendingToPast();
      }
      if (past.length === 0) return null;
      const popped = past.pop();
      future.push(current);
      if (future.length > stackLimit) future.shift();
      current = popped;
      onChange();
      return cloneSnapshot(current);
    },
    redo() {
      if (pending) {
        // A pending coalesce shadows any redo opportunity — commit it,
        // which clears the future stack via the standard path. After that
        // there's nothing to redo.
        clearTimer();
        commitPendingToPast();
        return null;
      }
      if (future.length === 0) return null;
      const popped = future.pop();
      past.push(current);
      if (past.length > stackLimit) past.shift();
      current = popped;
      onChange();
      return cloneSnapshot(current);
    },
    reset(snapshot) {
      clearTimer();
      pending = null;
      past = [];
      future = [];
      current = cloneSnapshot(snapshot);
      onChange();
    },
    canUndo() {
      // A pending debounce represents a real undoable edit even if the
      // timer hasn't committed yet. Reflect that in the button state so
      // users don't see the pill blink off mid-burst.
      return past.length > 0 || pending !== null;
    },
    canRedo() {
      return future.length > 0;
    },
    // Inspection — used by the tests.
    _peek() {
      return {
        past: past.map((s) => cloneSnapshot(s)),
        future: future.map((s) => cloneSnapshot(s)),
        current: cloneSnapshot(current),
        pending: pending ? cloneSnapshot(pending.snapshot) : null,
      };
    },
  };
}

/**
 * Classifier used by `reports-tab-pane` to decide whether an edit is a
 * structural mutation (snapshot immediately) or a pure text mutation
 * (coalesce into the 500 ms typing burst).
 *
 * Returns true when *only* the body-text fields of paragraph / markdown /
 * heading / code / callout blocks differ. Anything else — block count,
 * kind, level, code language, callout variant, image url, panel-grid
 * structure — counts as structural.
 */
export function isTextOnlyBlocksDiff(prevBlocks, nextBlocks) {
  if (!Array.isArray(prevBlocks) || !Array.isArray(nextBlocks)) return false;
  if (prevBlocks.length !== nextBlocks.length) return false;
  for (let i = 0; i < prevBlocks.length; i += 1) {
    const a = prevBlocks[i];
    const b = nextBlocks[i];
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case "paragraph":
      case "markdown":
        // Only the `text` field may differ; everything else must match.
        if (!sameExcept(a, b, ["text"])) return false;
        break;
      case "heading":
        if (a.level !== b.level) return false;
        if (!sameExcept(a, b, ["text"])) return false;
        break;
      case "code":
        if (a.language !== b.language) return false;
        if (!sameExcept(a, b, ["code"])) return false;
        break;
      case "callout":
        if (a.variant !== b.variant) return false;
        if (!sameExcept(a, b, ["text"])) return false;
        break;
      default:
        // Any non-text block must be referentially / deeply identical.
        if (JSON.stringify(a) !== JSON.stringify(b)) return false;
    }
  }
  return true;
}

/**
 * Returns true when `a` and `b` have identical JSON serialization once the
 * specified keys are stripped. The text-diff classifier uses this to check
 * "only the body text changed" without writing per-block comparators.
 */
function sameExcept(a, b, ignoreKeys) {
  const aClone = { ...a };
  const bClone = { ...b };
  for (const key of ignoreKeys) {
    delete aClone[key];
    delete bClone[key];
  }
  return JSON.stringify(aClone) === JSON.stringify(bClone);
}

/**
 * High-level classifier called by the tab pane after every edit. Returns
 * the mode to pass to `history.push`. Title / description / visibility
 * changes always count as structural — they're discrete actions, not a
 * typing stream. (The title input is a single line; the description is
 * one-line summary text. Coalescing them works too, but classifying them
 * as immediate keeps the undo granularity sensible.)
 *
 * Heuristic:
 *   - if title / description / visibility changed → "immediate"
 *   - else if blocks-diff is text-only → "coalesce"
 *   - else → "immediate"
 */
export function classifySnapshotMode(prev, next) {
  if (!prev) return "immediate";
  if (prev.title !== next.title) return "immediate";
  if ((prev.description ?? "") !== (next.description ?? "")) return "immediate";
  if (prev.visibility !== next.visibility) return "immediate";
  if (isTextOnlyBlocksDiff(prev.blocks, next.blocks)) return "coalesce";
  return "immediate";
}
