"use client";

import { HelpCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

export function ChartHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tipId = useId();

  useEffect(() => {
    if (!open) return undefined;
    function handlePointer(event: globalThis.PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="chart-help" ref={rootRef}>
      <button
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        aria-label={`What does the ${label} chart show?`}
        className="chart-help-trigger"
        onBlur={(event) => {
          if (!rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
        }}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <HelpCircle size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="chart-help-pop" id={tipId} role="tooltip">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function AnalysisCard({
  title,
  badge,
  help,
  children,
}: {
  title: string;
  badge?: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="analysis-card">
      <div className="analysis-card-head">
        <h2>{title}{badge ? <span className="card-badge">{badge}</span> : null}</h2>
        {help ? <ChartHelp label={title}>{help}</ChartHelp> : null}
      </div>
      <div className="analysis-card-body">{children}</div>
    </article>
  );
}
