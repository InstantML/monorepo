import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySnapshotMode,
  createHistoryController,
  isTextOnlyBlocksDiff,
} from "../app/dashboard/reports/report-history-core.js";

/**
 * Same fake-clock pattern as the auto-save tests — lets us step the
 * coalesce timer deterministically without dealing with node:test's fake
 * timer ceremony.
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

/** Build a controller with deterministic timer + a clean baseline snapshot. */
function setup() {
  const clock = fakeClock();
  const initial = {
    title: "Untitled report",
    description: "",
    visibility: "private",
    blocks: [{ kind: "paragraph", text: "" }],
  };
  const controller = createHistoryController(initial, {
    delayMs: 500,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { controller, clock, initial };
}

test("structural change pushes immediately", () => {
  const { controller, clock } = setup();
  // Insert a second paragraph block — structural mutation.
  const next = {
    title: "Untitled report",
    description: "",
    visibility: "private",
    blocks: [
      { kind: "paragraph", text: "" },
      { kind: "paragraph", text: "" },
    ],
  };
  controller.push(next, "immediate");
  // No timer should be pending — the push committed synchronously.
  assert.equal(clock.pending(), 0, "no pending timer after immediate push");
  assert.equal(controller.canUndo(), true);
  assert.equal(controller.canRedo(), false);
});

test("text typing coalesces — N rapid edits produce one snapshot after the debounce window", () => {
  const { controller, clock } = setup();
  // Six rapid text edits to the same paragraph block.
  for (let i = 1; i <= 6; i += 1) {
    controller.push(
      {
        title: "Untitled report",
        description: "",
        visibility: "private",
        blocks: [{ kind: "paragraph", text: "x".repeat(i) }],
      },
      "coalesce",
    );
  }
  // Before the debounce fires: canUndo reflects the pending edit but the
  // past stack is still empty (until the timer commits).
  assert.equal(controller.canUndo(), true, "canUndo is true while pending");
  const peekBefore = controller._peek();
  assert.equal(peekBefore.past.length, 0, "nothing on past stack yet");
  assert.equal(peekBefore.pending.blocks[0].text, "xxxxxx", "latest payload wins");
  // Advance past 500 ms — the timer fires, the pending snapshot moves the
  // PRE-edit baseline onto the past stack and `current` becomes the latest.
  clock.advance(500);
  const peekAfter = controller._peek();
  assert.equal(peekAfter.past.length, 1, "exactly one snapshot pushed");
  assert.equal(peekAfter.past[0].blocks[0].text, "", "past holds the pre-edit baseline");
  assert.equal(peekAfter.current.blocks[0].text, "xxxxxx", "current is the latest text");
  assert.equal(peekAfter.pending, null);
});

test("undo restores the previous snapshot", () => {
  const { controller, initial } = setup();
  // Push two distinct structural edits.
  const after1 = {
    ...initial,
    blocks: [...initial.blocks, { kind: "heading", level: 1, text: "Hi" }],
  };
  controller.push(after1, "immediate");
  const after2 = {
    ...initial,
    blocks: [
      ...initial.blocks,
      { kind: "heading", level: 1, text: "Hi" },
      { kind: "paragraph", text: "Body" },
    ],
  };
  controller.push(after2, "immediate");
  // Undo once → back to after1.
  const restored = controller.undo();
  assert.equal(restored.blocks.length, 2);
  assert.equal(restored.blocks[1].kind, "heading");
  assert.equal(controller.canUndo(), true, "still one more to undo");
  assert.equal(controller.canRedo(), true);
});

test("redo restores the post-undo state", () => {
  const { controller, initial } = setup();
  const after1 = { ...initial, title: "Step 1" };
  controller.push(after1, "immediate");
  const undone = controller.undo();
  assert.equal(undone.title, "Untitled report");
  const redone = controller.redo();
  assert.equal(redone.title, "Step 1", "redo restores the post-undo state");
  assert.equal(controller.canRedo(), false, "redo stack empty after redo");
});

test("new mutation after undo clears the redo stack", () => {
  const { controller, initial } = setup();
  controller.push({ ...initial, title: "A" }, "immediate");
  controller.push({ ...initial, title: "B" }, "immediate");
  controller.undo(); // back to title="A"
  assert.equal(controller.canRedo(), true);
  // Fresh edit destroys the redo branch.
  controller.push({ ...initial, title: "C" }, "immediate");
  assert.equal(controller.canRedo(), false, "redo stack cleared by new edit");
  const peek = controller._peek();
  assert.equal(peek.current.title, "C");
  assert.equal(peek.future.length, 0);
});

test("past stack is capped at 50 entries — oldest snapshots fall off", () => {
  const { controller, initial } = setup();
  // 60 immediate pushes with distinct titles. After this the past stack
  // should hold the 50 most recent entries; the first 10 should be gone.
  for (let i = 1; i <= 60; i += 1) {
    controller.push({ ...initial, title: `step-${i}` }, "immediate");
  }
  const peek = controller._peek();
  assert.equal(peek.past.length, 50, "stack capped at 50");
  // The oldest reachable snapshot should be step-10 (the original
  // "Untitled report" baseline + steps 1..9 fell off the bottom; the
  // earliest snapshot in past should be the one taken right BEFORE the
  // 11th push — i.e. title === "step-10").
  assert.equal(peek.past[0].title, "step-10", "oldest reachable is step-10");
  assert.equal(peek.current.title, "step-60");
});

test("reset clears both stacks and the pending debounce", () => {
  const { controller, clock, initial } = setup();
  controller.push({ ...initial, title: "A" }, "immediate");
  controller.push({ ...initial, title: "B" }, "immediate");
  controller.undo();
  // Stage a coalesced edit that hasn't fired yet.
  controller.push(
    {
      ...initial,
      blocks: [{ kind: "paragraph", text: "typing…" }],
    },
    "coalesce",
  );
  assert.equal(clock.pending(), 1, "coalesce timer scheduled");
  // Reset to a brand-new report's baseline.
  const fresh = {
    title: "Fresh report",
    description: "",
    visibility: "private",
    blocks: [],
  };
  controller.reset(fresh);
  assert.equal(controller.canUndo(), false, "no past after reset");
  assert.equal(controller.canRedo(), false, "no future after reset");
  assert.equal(clock.pending(), 0, "pending debounce timer cancelled");
  const peek = controller._peek();
  assert.equal(peek.current.title, "Fresh report");
  assert.equal(peek.past.length, 0);
  assert.equal(peek.future.length, 0);
  assert.equal(peek.pending, null);
});

test("isTextOnlyBlocksDiff classifies text-only edits vs structural ones", () => {
  const prev = [
    { kind: "paragraph", text: "hello" },
    { kind: "heading", level: 2, text: "Section" },
  ];
  const textChange = [
    { kind: "paragraph", text: "hello world" },
    { kind: "heading", level: 2, text: "Section" },
  ];
  assert.equal(isTextOnlyBlocksDiff(prev, textChange), true);
  // Adding a block is structural.
  const added = [
    ...prev,
    { kind: "horizontal_rule" },
  ];
  assert.equal(isTextOnlyBlocksDiff(prev, added), false);
  // Changing kind is structural.
  const kindSwap = [
    { kind: "heading", level: 1, text: "hello" },
    { kind: "heading", level: 2, text: "Section" },
  ];
  assert.equal(isTextOnlyBlocksDiff(prev, kindSwap), false);
  // Changing heading level is structural.
  const levelSwap = [
    { kind: "paragraph", text: "hello" },
    { kind: "heading", level: 1, text: "Section" },
  ];
  assert.equal(isTextOnlyBlocksDiff(prev, levelSwap), false);
});

test("classifySnapshotMode treats title / description / visibility as immediate", () => {
  const base = {
    title: "T",
    description: "D",
    visibility: "private",
    blocks: [{ kind: "paragraph", text: "p" }],
  };
  assert.equal(
    classifySnapshotMode(base, { ...base, title: "T2" }),
    "immediate",
  );
  assert.equal(
    classifySnapshotMode(base, { ...base, description: "D2" }),
    "immediate",
  );
  assert.equal(
    classifySnapshotMode(base, { ...base, visibility: "org" }),
    "immediate",
  );
  assert.equal(
    classifySnapshotMode(base, {
      ...base,
      blocks: [{ kind: "paragraph", text: "p2" }],
    }),
    "coalesce",
  );
});

test("undoing while a coalesce timer is pending flushes the burst first", () => {
  const { controller, clock, initial } = setup();
  controller.push({ ...initial, title: "After-A" }, "immediate");
  // Stage a coalesce that hasn't committed yet.
  controller.push(
    { ...initial, title: "After-A", blocks: [{ kind: "paragraph", text: "typing" }] },
    "coalesce",
  );
  assert.equal(clock.pending(), 1);
  const restored = controller.undo();
  // The pending edit should commit, then undo pops back one further —
  // landing on "After-A" (without the typed text).
  assert.equal(restored.title, "After-A");
  assert.equal(restored.blocks[0].text, "");
  assert.equal(clock.pending(), 0, "pending timer was flushed before undo");
});

test("identical-to-current pushes are no-ops", () => {
  const { controller, initial } = setup();
  controller.push({ ...initial }, "immediate");
  // The push above is identical to the controller's `current` (we never
  // mutated anything between init and this push) — should not create a
  // new history entry.
  assert.equal(controller.canUndo(), false);
});

test("flush commits a pending coalesce snapshot synchronously", () => {
  const { controller, initial, clock } = setup();
  controller.push(
    { ...initial, blocks: [{ kind: "paragraph", text: "burst" }] },
    "coalesce",
  );
  assert.equal(controller.canUndo(), true);
  // Before flush, the snapshot has not committed to the past stack yet.
  assert.equal(controller._peek().past.length, 0);
  controller.flush();
  assert.equal(clock.pending(), 0, "timer cleared by flush");
  const peek = controller._peek();
  assert.equal(peek.past.length, 1, "snapshot committed by flush");
  assert.equal(peek.current.blocks[0].text, "burst");
});
