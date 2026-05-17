"use client";

// Decorative terminal-style SDK event tail. Entries are HARDCODED examples
// of the SDK -> API protocol shape (run.init, run.metric, run.artifact,
// run.checkpoint, run.finish) — they do not stream from a real backend.

const ENTRIES = [
  { kind: "init",       line: "run.init        project=llm-7b-sft  id=r_a4e2  config=24 keys" },
  { kind: "metric",     line: "run.metric      step=4200   loss=1.82  lr=2.0e-4  thr=41k tok/s" },
  { kind: "artifact",   line: "run.artifact    name=eval/confusion  bytes=128KiB  mime=image/png" },
  { kind: "metric",     line: "run.metric      step=4800   loss=1.74  grad_norm=0.94" },
  { kind: "checkpoint", line: "run.checkpoint  step=5000   shard=0    bytes=12.4GiB  sha=4f9c…" },
  { kind: "flush",      line: "sdk.flush       queued=2,048  uploaded=2,048  spool=0" },
  { kind: "metric",     line: "run.metric      step=5400   loss=1.66  vram_used=78.2GiB" },
  { kind: "finish",     line: "run.finish      status=ok    duration=4h12m  events=18,420" },
];

const KIND_COLOR: Record<string, string> = {
  init:       "var(--accent)",
  metric:     "#94A3B8",
  artifact:   "#E0B07A",
  checkpoint: "#A78BFA",
  flush:      "#60A5FA",
  finish:     "#4ADE80",
};

function timestamp(i: number) {
  const m = ((42 - i * 3) % 60 + 60) % 60;
  const s = ((58 - i * 11) % 60 + 60) % 60;
  return `12:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function AuditFeed() {
  return (
    <div className="landing-audit-feed">
      <div className="landing-audit-feed__header">
        <div className="landing-audit-feed__label">
          sdk.tail · run r_a4e2
        </div>
        <div className="landing-audit-feed__live">
          <span className="status-live" />
          tailing
        </div>
      </div>

      <div className="landing-audit-feed__body">
        <div className="landing-audit-feed__scroll marquee-vert-slow">
          {[...ENTRIES, ...ENTRIES].map((e, i) => (
            <div
              key={i}
              className="landing-audit-feed__row"
            >
              <span
                className="landing-audit-feed__dot"
                style={{ background: KIND_COLOR[e.kind] }}
                aria-hidden
              />
              <span className="landing-audit-feed__ts">
                {timestamp(i)}
              </span>
              <span className="landing-audit-feed__line">
                {e.line}
              </span>
            </div>
          ))}
        </div>

        <div className="landing-audit-feed__fade-top" />
        <div className="landing-audit-feed__fade-bottom" />
      </div>
    </div>
  );
}
