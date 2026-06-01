"use client";

import { useEffect, useRef } from "react";

function focusableChildren(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(
    "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )).filter((node) => !node.closest("[aria-hidden='true']"));
}

export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onClose: () => void,
  initialSelector?: string,
  returnFocusSelector?: string,
) {
  const rootRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function focusInitial() {
      const root = rootRef.current;
      if (!root) return;
      const preferred = initialSelector ? root.querySelector<HTMLElement>(initialSelector) : null;
      (preferred ?? focusableChildren(root)[0] ?? root).focus({ preventScroll: true });
    }

    const focusTimer = window.setTimeout(focusInitial, 0);

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableChildren(root);
      if (!focusable.length) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (!root.contains(current)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown, true);
      const previous = previousFocusRef.current;
      const fallback = returnFocusSelector ? document.querySelector<HTMLElement>(returnFocusSelector) : null;
      const returnTarget = previous && previous !== document.body && document.contains(previous)
        ? previous
        : fallback;
      returnTarget?.focus({ preventScroll: true });
    };
  }, [active, initialSelector, returnFocusSelector]);

  return rootRef;
}
