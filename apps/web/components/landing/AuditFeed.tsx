"use client";

// Decorative terminal-style SDK event tail. Entries are HARDCODED examples
// of the SDK -> API protocol shape (run.init, run.metric, run.artifact,
// run.checkpoint, run.finish) — they do not stream from a real backend.

const ENTRIES = [
  { kind: "init",       line: "init cfg=24" },
  { kind: "metric",     line: "loss=1.82 lr=2e-4" },
  { kind: "artifact",   line: "artifact png 128KiB" },
  { kind: "metric",     line: "loss=1.74 grad=.94" },
  { kind: "checkpoint", line: "ckpt model.pt 12.4GiB" },
  { kind: "flush",      line: "flush 2048/2048" },
  { kind: "metric",     line: "loss=1.66 vram=78GiB" },
  { kind: "finish",     line: "finish 4h12m 18k ev" },
];

const KIND_COLOR: Record<string, string> = {
  init:       "var(--accent)",
  metric:     "var(--dim)",
  artifact:   "var(--warm)",
  checkpoint: "var(--blue)",
  flush:      "var(--info)",
  finish:     "var(--green)",
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
