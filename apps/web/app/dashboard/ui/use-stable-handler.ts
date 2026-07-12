"use client";

import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * Returns a referentially-stable wrapper that always invokes the latest
 * render's callback (the "useEvent" pattern). The dashboard shell recreates
 * its handler closures on every render; passing those raw into memo()'d
 * children (workspace panel cards, table rows) defeats the memo boundary on
 * every interaction. The wrapper's identity never changes, while the ref is
 * refreshed in useInsertionEffect so the newest closure (with current state)
 * runs when the event fires.
 *
 * Only for event handlers — the returned function must not be called during
 * render, where the ref may still hold the previous render's closure.
 */
export function useStableHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useInsertionEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}
