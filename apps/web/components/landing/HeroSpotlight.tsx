"use client";

import { useEffect, useRef } from "react";

/**
 * Two layered radial spotlights behind the hero. Both:
 *   1. drift continuously on independent sine paths (so the background
 *      moves even when the visitor is sitting still), and
 *   2. parallax with scroll position (the primary spotlight rises slightly
 *      as the user scrolls into the page).
 *
 * Falls back to pure CSS keyframe drift when JS hasn't hydrated yet, and
 * fully disables motion when prefers-reduced-motion is set.
 */
export function HeroSpotlight() {
  const primary = useRef<HTMLDivElement>(null);
  const secondary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    // Take over from CSS keyframes once JS is in charge.
    primary.current?.classList.remove("css-drift");
    secondary.current?.classList.remove("css-drift");

    let raf = 0;
    let scrollY = window.scrollY;
    const start = performance.now();

    const onScroll = () => {
      scrollY = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const tick = (now: number) => {
      const t = (now - start) / 1000;

      // Lissajous-style drift — two different periods so the lights
      // never repeat the same pose on screen.
      const p1x = Math.sin(t * 0.18) * 80 + Math.cos(t * 0.05) * 24;
      const p1y = Math.cos(t * 0.13) * 28 + Math.sin(t * 0.07) * 12;

      const p2x = Math.sin(t * 0.27 + 1.3) * 130 + Math.cos(t * 0.11) * 30;
      const p2y = Math.cos(t * 0.21 + 0.7) * 36 + Math.sin(t * 0.09) * 16;

      // Scroll parallax — slow rise as the user scrolls past.
      const parallax1 = -scrollY * 0.18;
      const parallax2 = -scrollY * 0.32;

      if (primary.current) {
        primary.current.style.transform = `translate(-50%, ${parallax1}px) translate(${p1x}px, ${p1y}px)`;
      }
      if (secondary.current) {
        secondary.current.style.transform = `translate(-50%, ${parallax2}px) translate(${p2x}px, ${p2y}px) scale(${1 + Math.sin(t * 0.4) * 0.04})`;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <>
      <div
        ref={primary}
        className="hero-spotlight css-drift"
        aria-hidden
      />
      <div
        ref={secondary}
        className="hero-spotlight-secondary css-drift"
        aria-hidden
      />
    </>
  );
}
