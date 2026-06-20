"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Dismisses a `<details>` popover like every other dropdown in the app:
 * an outside pointerdown closes it, and Escape closes it and returns focus
 * to its `<summary>` trigger.
 */
export function useDetailsDismiss(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const details = ref.current;
      if (!details?.open) return;
      if (event.target instanceof Node && details.contains(event.target)) return;
      details.open = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const details = ref.current;
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false;
      const summary = details.querySelector("summary");
      if (summary instanceof HTMLElement) summary.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
}
