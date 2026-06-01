import assert from "node:assert/strict";
import test from "node:test";

import { selectMenuViewportPosition } from "../src/select-menu-position.js";

test("select menu clamp uses the positioned anchor coordinate space", () => {
  const position = selectMenuViewportPosition({
    anchorRect: { left: 80 },
    triggerRect: { left: 120, right: 220, width: 100 },
    viewportWidth: 240,
    menuAlign: "left",
  });
  const viewportLeft = 80 + position.left;

  assert.equal(position.width, 196);
  assert.equal(viewportLeft, 32);
  assert.equal(viewportLeft + position.width, 228);
});

test("right aligned select menus clamp against the left viewport edge", () => {
  const position = selectMenuViewportPosition({
    anchorRect: { left: 180 },
    triggerRect: { left: 16, right: 116, width: 100 },
    viewportWidth: 320,
    menuAlign: "right",
  });
  const viewportLeft = 180 + position.left;

  assert.equal(position.width, 196);
  assert.equal(viewportLeft, 12);
});

test("select menus shrink to the padded viewport on very small screens", () => {
  const position = selectMenuViewportPosition({
    anchorRect: { left: 0 },
    triggerRect: { left: 20, right: 160, width: 140 },
    viewportWidth: 180,
  });

  assert.equal(position.width, 156);
  assert.equal(position.left, 12);
});
