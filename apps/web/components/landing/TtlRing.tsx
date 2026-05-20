"use client";

// Decorative p95-latency dial. Number reflects the 100,000-run local
// benchmark p95 for project summary (78 ms) — see
// apps/rust-server README. Visual sweep is CSS-driven and cosmetic.

import { useEffect, useRef, useState } from "react";

const MAX_MS = 200;
const TARGET_MS = 78;
const CYCLE_S = 4;

export function TtlRing() {
  const size = 168;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;

  const [t, setT] = useState(TARGET_MS);
  const startedRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const tick = (ts: number) => {
      if (startedRef.current === null) startedRef.current = ts;
      const elapsed = ((ts - startedRef.current) / 1000) % CYCLE_S;
      const fraction = elapsed / CYCLE_S;
      const eased = fraction < 0.5 ? fraction * 2 : 1;
      setT(TARGET_MS * eased);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      startedRef.current = null;
    };
  }, []);

  const fillFraction = Math.min(1, t / MAX_MS);
  const offset = circumference * (1 - fillFraction);
  const display = Math.round(t);

  return (
    <div className="landing-ttl-ring">
      <div
        className="landing-ttl-ring__glow"
        aria-hidden
      />

      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="landing-ttl-ring__svg"
        aria-hidden
      >
        <defs>
          <linearGradient id="ttlGradWeb" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#86EFAC" />
            <stop offset="100%" stopColor="#34D399" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--line, #1c1f2a)"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#ttlGradWeb)"
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>

      <div className="landing-ttl-ring__label">
        <div className="landing-ttl-ring__eyebrow">project p95</div>
        <div className="landing-ttl-ring__value">{display}</div>
        <div className="landing-ttl-ring__unit">ms · at 100k runs</div>
      </div>
    </div>
  );
}
