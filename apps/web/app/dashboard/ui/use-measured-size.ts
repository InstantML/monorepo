"use client";

import { useLayoutEffect, useState } from "react";

/**
 * Measure an element's border-box size in CSS pixels, tracking resizes.
 * Charts render their SVG viewBox at this size so text and strokes stay at
 * constant pixel size instead of scaling with the container.
 */
export function useMeasuredSize(
  ref: { current: HTMLElement | null },
  fallbackWidth: number,
  fallbackHeight: number,
) {
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const measure = () => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
  };

  // Measure after EVERY commit. `ref.current` is reliably the current element
  // here (refs attach before layout effects fire), so this catches the element
  // appearing on a later render — e.g. a chart that renders an empty state first
  // and only mounts its frame once series load. Keying the effect on
  // `[ref.current]` instead would silently miss that: the dependency is read at
  // render time, when the ref is still null, so it never re-runs when the frame
  // arrives — leaving the chart stuck at its fallback viewBox (the Run Detail
  // "Metrics" tab rendered centered in the left ~40% until the next resize).
  // `setSize` bails when the size is unchanged, so re-measuring every render is
  // cheap and never loops.
  useLayoutEffect(() => {
    measure();
  });

  // Track resizes that happen without a React re-render (container or window
  // resize, sidebar collapse). The per-render measure above owns the initial
  // size; this observer keeps it current afterwards.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // Coalesce resize ticks to one re-measure per frame: consumers re-normalize
    // series on every size change, which is too expensive to run per
    // ResizeObserver callback during a drag-resize.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    });
    observer.observe(element);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);

  return {
    width: size.width || fallbackWidth,
    height: size.height || fallbackHeight,
  };
}
