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
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);
  return {
    width: size.width || fallbackWidth,
    height: size.height || fallbackHeight,
  };
}
