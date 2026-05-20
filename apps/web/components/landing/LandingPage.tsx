"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { LogoMark } from "./LogoMark";
import { NavLogo } from "./NavLogo";
import { HeroSpotlight } from "./HeroSpotlight";
import { MaskingDemo } from "./MaskingDemo";
import { AuditFeed } from "./AuditFeed";
import { TtlRing } from "./TtlRing";
import { ThemeToggle } from "./ThemeToggle";

const DEMO_EMAIL =
  "mailto:hello@instantml.ai?subject=InstantML%20design%20partner&body=Hi%20%E2%80%94%20I%27d%20like%20to%20try%20InstantML.%0A%0ATeam%3A%0AStack%3A%0AModel%2Fworkflow%3A%0ARun%20volume%3A%0ABiggest%20pain%20with%20current%20tool%3A";

function useSectionObserver() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.12 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function Section({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const ref = useSectionObserver();
  return (
    <section
      ref={ref}
      id={id}
      className={`section-fade landing-section ${className}`}
    >
      {children}
    </section>
  );
}

function IconChart() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 14l4-5 4 3 5-7" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
function IconStream() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M3 12h12" />
      <path d="M3 18h18" />
    </svg>
  );
}
function IconBox() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  );
}
function IconMenu() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h18M3 6h18M3 18h18" />
    </svg>
  );
}
function IconArrow() {
  return (
    <svg className="landing-arrow" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ArchitectureDiagram() {
  return (
    <div className="landing-arch-wrap">
      <svg
        viewBox="0 0 920 260"
        className="landing-arch-svg"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="20" y="30" width="320" height="200" rx="10" stroke="#2A2E3D" strokeWidth="1" strokeDasharray="4 4" fill="none" />
        <rect x="32" y="20" width="170" height="20" rx="4" fill="#08080A" />
        <text x="40" y="34" fontFamily="Geist Mono, monospace" fontSize="10" fill="#1FB877" letterSpacing="0.15em">YOUR TRAINING JOB</text>
        <rect x="60" y="92" width="120" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" />
        <text x="120" y="125" textAnchor="middle" fontFamily="Geist, sans-serif" fontSize="13" fontWeight="500" fill="#F8FAFC">Trainer</text>
        <text x="120" y="146" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="10" fill="#64748B">PyTorch · JAX · TRL</text>
        <line x1="180" y1="130" x2="240" y2="130" stroke="#2A2E3D" strokeWidth="1" />
        <rect x="220" y="92" width="100" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" />
        <text x="270" y="121" textAnchor="middle" fontFamily="Geist, sans-serif" fontSize="13" fontWeight="500" fill="#F8FAFC">SDK</text>
        <text x="270" y="140" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#64748B">buffered · async</text>
        <text x="270" y="154" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#64748B">offline spool</text>
        <line x1="340" y1="130" x2="410" y2="130" className="data-flow-line" stroke="#1FB877" strokeWidth="1.5" />
        <polygon points="408,125 420,130 408,135" fill="#1FB877" />
        <rect x="420" y="76" width="180" height="108" rx="10" fill="#0D0F15" stroke="#1FB877" strokeWidth="1.4" className="pulse-node" />
        <text x="510" y="106" textAnchor="middle" fontFamily="Geist, sans-serif" fontSize="14" fontWeight="600" fill="#F8FAFC">InstantML API</text>
        <line x1="440" y1="118" x2="580" y2="118" stroke="#1F1F26" strokeWidth="1" />
        <text x="510" y="138" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="10" fill="#94A3B8">Rust · ClickHouse</text>
        <text x="510" y="156" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#64748B">typed attributes · summaries</text>
        <text x="510" y="172" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#64748B">indexed run search</text>
        <line x1="600" y1="130" x2="670" y2="130" className="data-flow-line" stroke="#1FB877" strokeWidth="1.5" />
        <polygon points="668,125 680,130 668,135" fill="#1FB877" />
        <rect x="680" y="92" width="120" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" />
        <text x="740" y="121" textAnchor="middle" fontFamily="Geist, sans-serif" fontSize="13" fontWeight="500" fill="#F8FAFC">Dashboard</text>
        <text x="740" y="140" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#64748B">runs · compare</text>
        <text x="740" y="154" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#64748B">charts · artifacts</text>
        <line x1="800" y1="130" x2="855" y2="130" stroke="#2A2E3D" strokeWidth="1" />
        <rect x="820" y="92" width="80" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" strokeDasharray="3 3" />
        <text x="860" y="125" textAnchor="middle" fontFamily="Geist, sans-serif" fontSize="12" fontWeight="500" fill="#F8FAFC">Artifacts</text>
        <text x="860" y="146" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#64748B">S3 / R2</text>
        <text x="120" y="208" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#475569" letterSpacing="0.1em">GPU NODES</text>
        <text x="270" y="208" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#475569" letterSpacing="0.1em">PYTHON SDK</text>
        <text x="510" y="208" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#1FB877" letterSpacing="0.1em">HOT PATH</text>
        <text x="740" y="208" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#475569" letterSpacing="0.1em">NEXT/REACT</text>
        <text x="860" y="208" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="9" fill="#475569" letterSpacing="0.1em">OBJECT STORE</text>
      </svg>
    </div>
  );
}

type Lang = "python" | "wandb";

function CodeTabs() {
  const [lang, setLang] = useState<Lang>("python");

  return (
    <div className="landing-code-block">
      <div className="landing-code-block__header">
        <div className="landing-code-block__dots">
          <div className="landing-code-block__dot" style={{ background: "#FF5F57" }} />
          <div className="landing-code-block__dot" style={{ background: "#FEBC2E" }} />
          <div className="landing-code-block__dot" style={{ background: "#28C840" }} />
          <span className="landing-code-block__filename">
            {lang === "python" ? "train.py" : "migrate_wandb.py"}
          </span>
        </div>
        <div className="landing-code-block__tabs">
          <button
            type="button"
            className={`tab-btn ${lang === "python" ? "tab-btn-active" : ""}`}
            onClick={() => setLang("python")}
          >
            New run
          </button>
          <button
            type="button"
            className={`tab-btn ${lang === "wandb" ? "tab-btn-active" : ""}`}
            onClick={() => setLang("wandb")}
          >
            From W&amp;B
          </button>
        </div>
      </div>

      <div className="landing-code-block__cmd">
        <code>
          <span className="landing-code-dim">$ </span>
          {lang === "python" ? (
            <>
              <span className="landing-code-accent">pip</span>
              <span className="landing-code-heading"> install instantml &amp;&amp; python train.py</span>
            </>
          ) : (
            <>
              <span className="landing-code-accent">instantml</span>
              <span className="landing-code-heading"> import wandb ./wandb-export.json</span>
            </>
          )}
        </code>
      </div>

      <div className="landing-code-block__body">
        {lang === "python" ? <PythonSnippet /> : <ImportSnippet />}
      </div>
    </div>
  );
}

function PythonSnippet() {
  return (
    <pre><code>
      <span className="landing-code-dim"># Three calls. No daemon, no dashboard tab to babysit.</span>{"\n"}
      <span className="landing-code-purple">import</span>
      <span className="landing-code-heading"> instantml </span>
      <span className="landing-code-purple">as</span>
      <span className="landing-code-heading"> im</span>{"\n\n"}
      <span className="landing-code-heading">run = im.</span>
      <span className="landing-code-accent">init</span>
      <span className="landing-code-mute">(</span>
      <span className="landing-code-fg">project=</span>
      <span className="landing-code-str">&quot;llm-7b-sft&quot;</span>
      <span className="landing-code-mute">,</span>
      {" "}<span className="landing-code-fg">config=cfg</span>
      <span className="landing-code-mute">)</span>{"\n\n"}
      <span className="landing-code-purple">for</span>
      <span className="landing-code-heading"> step, batch </span>
      <span className="landing-code-purple">in enumerate</span>
      <span className="landing-code-mute">(</span>
      <span className="landing-code-heading">loader</span>
      <span className="landing-code-mute">):</span>{"\n"}
      <span className="landing-code-heading">    loss = train_step(batch)</span>{"\n"}
      <span className="landing-code-heading">    run.</span>
      <span className="landing-code-accent">log</span>
      <span className="landing-code-mute">{"({"}</span>
      <span className="landing-code-str">&quot;loss&quot;</span>
      <span className="landing-code-mute">: </span>
      <span className="landing-code-heading">loss</span>
      <span className="landing-code-mute">,</span>
      {" "}<span className="landing-code-str">&quot;step&quot;</span>
      <span className="landing-code-mute">: </span>
      <span className="landing-code-heading">step</span>
      <span className="landing-code-mute">{"})"})</span>{"\n\n"}
      <span className="landing-code-heading">run.</span>
      <span className="landing-code-accent">log_artifact</span>
      <span className="landing-code-mute">(</span>
      <span className="landing-code-str">&quot;checkpoint&quot;</span>
      <span className="landing-code-mute">, </span>
      <span className="landing-code-str">&quot;./ckpt&quot;</span>
      <span className="landing-code-mute">)</span>{"\n"}
      <span className="landing-code-heading">run.</span>
      <span className="landing-code-accent">finish</span>
      <span className="landing-code-mute">()</span>
    </code></pre>
  );
}

function ImportSnippet() {
  return (
    <pre><code>
      <span className="landing-code-dim"># Bring your history with you. Same charts, same compare, same URLs.</span>{"\n"}
      <span className="landing-code-accent">instantml</span>
      <span className="landing-code-heading"> import wandb </span>
      <span className="landing-code-str">./wandb-export.json</span>
      <span className="landing-code-mute"> \</span>{"\n"}
      <span className="landing-code-heading">    --project </span>
      <span className="landing-code-str">migrated-from-wandb</span>
      <span className="landing-code-mute"> \</span>{"\n"}
      <span className="landing-code-heading">    --dry-run</span>{"\n\n"}
      <span className="landing-code-dim"># Also works:</span>{"\n"}
      <span className="landing-code-accent">instantml</span>
      <span className="landing-code-heading"> import mlflow </span>
      <span className="landing-code-str">./mlruns</span>{"\n"}
      <span className="landing-code-accent">instantml</span>
      <span className="landing-code-heading"> import neptune </span>
      <span className="landing-code-str">./neptune-export.json</span>{"\n\n"}
      <span className="landing-code-dim"># Dual-log during a migration:</span>{"\n"}
      <span className="landing-code-heading">run = im.</span>
      <span className="landing-code-accent">init</span>
      <span className="landing-code-mute">(</span>
      <span className="landing-code-fg">mirror_to=</span>
      <span className="landing-code-str">&quot;wandb&quot;</span>
      <span className="landing-code-mute">)</span>
    </code></pre>
  );
}

function StatCard({ k, v, hint }: { k: string; v: string; hint: string }) {
  return (
    <div className="landing-stat-card">
      <div className="landing-stat-card__key">{k}</div>
      <div className="landing-stat-card__val">{v}</div>
      <div className="landing-stat-card__hint">{hint}</div>
    </div>
  );
}

function PainTile({ num, title, line }: { num: string; title: string; line: string }) {
  return (
    <div className="bento-cell landing-paint-tile">
      <div className="landing-paint-tile__header">
        <span className="font-serif-italic landing-paint-tile__num">{num}</span>
        <span className="landing-paint-tile__tag landing-paint-tile__tag--danger">Today</span>
      </div>
      <h3 className="landing-pain-title">{title}</h3>
      <p className="landing-pain-body">{line}</p>
    </div>
  );
}

function PathTile({ num, title, line, variant }: { num: string; title: string; line: string; variant: "old" | "instantml" }) {
  const tag = variant === "old" ? "Status quo" : "InstantML";
  const tagClass = variant === "old" ? "landing-paint-tile__tag--danger" : "landing-paint-tile__tag--accent";
  return (
    <div className="bento-cell landing-paint-tile">
      <div className="landing-paint-tile__header">
        <span className="font-serif-italic landing-paint-tile__num">{num}</span>
        <span className={`landing-paint-tile__tag ${tagClass}`}>{tag}</span>
      </div>
      <h3 className="landing-pain-title">{title}</h3>
      <p className="landing-pain-body">{line}</p>
    </div>
  );
}

function BentoEyebrow({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="landing-bento-eyebrow">
      <span className="landing-bento-eyebrow__icon">{icon}</span>
      <span className="landing-bento-eyebrow__label">{label}</span>
    </div>
  );
}

function MatrixCell({ label, status, tone }: { label: string; status: string; tone: "ok" | "progress" | "neutral" }) {
  const dotBg =
    tone === "ok" ? "var(--accent)" : tone === "progress" ? "var(--warm)" : "var(--dim)";
  const dotShadow =
    tone === "ok"
      ? "0 0 8px rgba(31,184,119,0.6)"
      : tone === "progress"
        ? "0 0 8px rgba(224,176,122,0.6)"
        : "none";
  return (
    <div className="bento-cell landing-matrix-cell">
      <div className="landing-matrix-cell__row">
        <span className="landing-matrix-cell__label">{label}</span>
        <span className="landing-matrix-cell__dot" style={{ background: dotBg, boxShadow: dotShadow }} aria-hidden />
      </div>
      <span className="landing-matrix-cell__status">{status}</span>
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="landing-footer-col-title">{title}</div>
      <ul className="landing-footer-links">
        {links.map(([label, href]) => (
          <li key={label}>
            <a href={href} className="landing-footer-link">{label}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="landing-root">
      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav__inner">
          <NavLogo size={22} />
          <div className="landing-nav__links">
            <a href="#how" className="landing-nav__link">How it works</a>
            <a href="#capabilities" className="landing-nav__link">Capabilities</a>
            <a href="#developers" className="landing-nav__link landing-nav__link--md">Developers</a>
            <a href="#pricing" className="landing-nav__link landing-nav__link--md">Pricing</a>
            <ThemeToggle />
            <a href="/signup" className="landing-cta-primary landing-cta-primary--sm">
              Get early access
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <div className="landing-hero-wrap">
        <HeroSpotlight />
        <div className="bg-grid landing-bg-overlay" />
        <div className="bg-scan landing-bg-overlay" />
        <Section className="landing-hero-section">
          <div className="landing-hero-content">
            <div className="hero-rise-1 landing-hero-badge">
              <span className="status-live" />
              <span className="landing-hero-badge__text">
                Training observability for serious ML teams
              </span>
            </div>

            <h1 className="hero-rise-2 landing-h1">
              The training tool
              <span className="landing-h1-serif"> you keep open</span>
              {" "}all day.
            </h1>

            <p className="hero-rise-3 landing-lede">
              InstantML is a W&amp;B-style platform built for speed. Sub-second
              metric charts at 90k runs, instant run comparison, real
              artifacts and checkpoints, and predictable pricing — without
              tracked-hour billing.
            </p>

            <div className="hero-rise-4 landing-cta-row">
              <a href="/signup" className="landing-cta-primary">
                Become a design partner
                <IconArrow />
              </a>
              <a href="#developers" className="landing-cta-ghost">
                See the SDK
              </a>
            </div>

            <div className="hero-rise-4 landing-proof-chips">
              <span className="landing-proof-chip">
                <span className="landing-proof-chip__check"><IconCheck /></span>
                Drop-in for W&amp;B / MLflow / Neptune
              </span>
              <span className="landing-proof-chip">
                <span className="landing-proof-chip__check"><IconCheck /></span>
                Self-host or hosted
              </span>
            </div>
          </div>
        </Section>
      </div>

      {/* Stats */}
      <Section className="landing-stats-section">
        <div className="landing-stats-grid">
          <StatCard
            k="Project summary p95"
            v="78 ms"
            hint="Measured at 90,000 runs. Charts open before the cursor stops moving."
          />
          <StatCard
            k="Indexed search p95"
            v="118 ms"
            hint="Server-side search/sort over name, tags, config, and notes — at scale."
          />
          <StatCard
            k="First useful render"
            v="387 ms"
            hint="Time-to-pixels on the production web dashboard. No spinner-driven UX."
          />
        </div>
      </Section>

      {/* How it works */}
      <Section id="how" className="landing-section-py">
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">How it works</p>
          <h2 className="landing-h2">
            One pip install.{" "}
            <span className="font-serif-italic landing-h2-muted">Three SDK calls.</span>
          </h2>
          <p className="landing-section-body">
            The Python SDK is a thin, non-blocking layer over a Rust +
            ClickHouse backend. Metrics buffer in-process and flush
            asynchronously, so your training loop never waits on the
            network. If the server is slow or offline, events spool to
            disk and replay on reconnect.
          </p>
        </div>

        <div className="landing-arch-card">
          <ArchitectureDiagram />
          <div className="landing-arch-legend">
            <div className="landing-arch-legend-item">
              <div className="landing-arch-legend-dot landing-arch-legend-dot--accent" />
              <span className="landing-arch-legend-label">InstantML hot path</span>
            </div>
            <div className="landing-arch-legend-item">
              <div className="landing-arch-legend-dot landing-arch-legend-dot--border" />
              <span className="landing-arch-legend-label">Your trainer</span>
            </div>
            <div className="landing-arch-legend-item">
              <div className="landing-arch-legend-dash" />
              <span className="landing-arch-legend-label">Object storage</span>
            </div>
          </div>
        </div>
      </Section>

      {/* Why teams switch */}
      <Section className="landing-section-py" id="switch">
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">Why teams switch</p>
          <h2 className="landing-h2">
            The old tools work.{" "}
            <span className="font-serif-italic landing-h2-muted">They&apos;re just slow.</span>
          </h2>
          <p className="landing-section-body">
            We&apos;ve watched serious ML teams put up with run-list pages
            that take five seconds to load, charts that lag behind the
            mouse, and pricing that punishes you for actually using the
            product. InstantML is the third option.
          </p>
        </div>

        <div className="landing-bento-3">
          <PathTile num="01" title="Wait on a slow run list" line="Every project entry costs you focus. Spinners are the dominant UI." variant="old" />
          <PathTile num="02" title="Pay per tracked hour" line="Pricing scales with how hard your team is working. The wrong incentive." variant="old" />
          <PathTile num="03" title="InstantML" line="Sub-second charts at 90k runs, flat predictable pricing, and a data model you can self-host." variant="instantml" />
        </div>
      </Section>

      {/* Pain points */}
      <Section className="landing-section-py" id="pain">
        <div className="landing-section-intro-row">
          <div>
            <p className="mono-label landing-mono-label">What we fix</p>
            <h2 className="landing-h2">
              Three places{" "}
              <span className="font-serif-italic landing-h2-muted">the current tools hurt.</span>
            </h2>
          </div>
          <a href="#developers" className="landing-text-link">
            Jump to the SDK
            <IconArrow />
          </a>
        </div>

        <div className="landing-bento-3">
          <PainTile num="01" title="Comparison is the killer" line="Side-by-side runs reload every chart. We render compare from materialized summaries, not raw scans." />
          <PainTile num="02" title="Logging blocks training" line="Synchronous SDKs make your loop wait on HTTP. Ours buffers and spools — your trainer never blocks." />
          <PainTile num="03" title="Your runs aren&apos;t yours" line="Export is a side-feature. Ours is a first-class GET /api/export with deterministic JSONL." />
        </div>
      </Section>

      {/* Capabilities */}
      <Section className="landing-section-py" id="capabilities">
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">Capabilities</p>
          <h2 className="landing-h2">
            The daily workflow,{" "}
            <span className="font-serif-italic landing-h2-muted">measured in milliseconds.</span>
          </h2>
        </div>

        <div className="landing-bento-6">
          {/* Big — live loss chart */}
          <div className="bento-cell landing-bento-big">
            <div className="landing-bento-inner-pad">
              <BentoEyebrow icon={<IconChart />} label="Metric charts" />
              <h3 className="landing-bento-h3">Loss curves that keep up with your loop.</h3>
              <p className="landing-bento-body">
                Streamed scalar series, grouped averages, smoothing, range
                zoom, hover tooltips. The chart you actually watch.
              </p>
            </div>
            <div className="landing-bento-chart-wrap">
              <MaskingDemo />
            </div>
          </div>

          {/* Latency dial */}
          <div className="bento-cell landing-bento-big landing-bento-dial">
            <div className="landing-bento-inner-pad">
              <BentoEyebrow icon={<IconBolt />} label="Benchmarked at scale" />
              <h3 className="landing-bento-h3">90,000 runs. No spinner.</h3>
              <p className="landing-bento-body">
                Project summary p95 78 ms · search p95 118 ms · metric-best
                sort p95 66 ms · chart series p95 22 ms. Measured locally,
                reproducible by the included benchmark.
              </p>
            </div>
            <div className="landing-bento-dial-wrap">
              <TtlRing />
            </div>
          </div>

          {/* SDK tail */}
          <div className="bento-cell landing-bento-sm">
            <div className="landing-bento-inner-pad">
              <BentoEyebrow icon={<IconStream />} label="Non-blocking SDK" />
              <h3 className="landing-bento-h3-sm">Buffered. Async. Offline-safe.</h3>
              <p className="landing-bento-body-sm">init · log · artifact · checkpoint · finish.</p>
            </div>
            <div className="landing-bento-feed-wrap">
              <AuditFeed />
            </div>
          </div>

          {/* Typed attributes */}
          <div className="bento-cell landing-bento-sm landing-bento-padded">
            <BentoEyebrow icon={<IconBox />} label="Real data model" />
            <h3 className="landing-bento-h3-sm">Typed attributes, not stringly-typed dicts.</h3>
            <p className="landing-bento-body-sm landing-bento-body-mb">
              Configs, float series, string series, file series, histograms,
              and tags — first-class. Rich-object tables, audio, MP4
              rollouts, and image artifacts come along for the ride.
            </p>
            <div className="landing-pill-row">
              {["floats", "strings", "files", "histograms", "tags"].map((p) => (
                <span key={p} className="pill">{p}</span>
              ))}
            </div>
          </div>

          {/* Drop-in */}
          <div className="bento-cell landing-bento-sm landing-bento-padded">
            <BentoEyebrow icon={<IconMenu />} label="Drop-in" />
            <h3 className="landing-bento-h3-sm">Import yesterday&apos;s runs.</h3>
            <p className="landing-bento-body-sm landing-bento-body-mb">
              First-class importers for W&amp;B, MLflow, and Neptune JSON
              exports. Dual-log against your old tool during migration.
            </p>
            <div className="landing-pill-row">
              {["W&B", "MLflow", "Neptune", "PyTorch", "JAX", "TRL"].map((p) => (
                <span key={p} className="pill">{p}</span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Developers */}
      <Section className="landing-section-py" id="developers">
        <div className="landing-dev-header">
          <div>
            <p className="mono-label landing-mono-label">For developers</p>
            <h2 className="landing-h2">
              <span className="font-serif-italic landing-h2-muted">pip install instantml.</span>{" "}
              Three lines.
            </h2>
            <p className="landing-section-body landing-dev-body">
              The SDK is intentionally small. Three calls —{" "}
              <code className="landing-code-inline">init</code>,{" "}
              <code className="landing-code-inline">log</code>,{" "}
              <code className="landing-code-inline">finish</code>{" "}
              — cover the daily loop. Artifacts and checkpoints are just
              files. Imports replay history from W&amp;B, MLflow, and
              Neptune so you don&apos;t lose a year of training when you switch.
            </p>
          </div>
          <div className="landing-pill-row landing-dev-pills">
            <span className="pill">Python 3.11+</span>
            <span className="pill">Rust API</span>
            <span className="pill">ClickHouse</span>
            <span className="pill">Open SDK</span>
          </div>
        </div>

        <div className="landing-code-center">
          <CodeTabs />
        </div>
      </Section>

      {/* What ships today */}
      <Section className="landing-section-py" id="pricing">
        <div className="landing-section-intro">
          <p className="mono-label landing-mono-label">What ships today</p>
          <h2 className="landing-h2">
            A real product,{" "}
            <span className="font-serif-italic landing-h2-muted">not a roadmap deck.</span>
          </h2>
        </div>

        <div className="landing-matrix-grid">
          <MatrixCell label="Python SDK"      status="init / log / finish" tone="ok" />
          <MatrixCell label="Run compare"     status="Side-by-side"        tone="ok" />
          <MatrixCell label="Artifacts"       status="Files · checkpoints" tone="ok" />
          <MatrixCell label="W&B import"      status="JSON · CLI"          tone="ok" />
          <MatrixCell label="MLflow import"   status="JSON · CLI"          tone="ok" />
          <MatrixCell label="Neptune import"  status="JSON · CLI"          tone="ok" />
          <MatrixCell label="Docker Compose"  status="One command"         tone="ok" />
          <MatrixCell label="Self-hosted"     status="Available"           tone="ok" />
          <MatrixCell label="Hosted SaaS"     status="Design partners"     tone="progress" />
          <MatrixCell label="Dual-log to W&B" status="In testing"          tone="progress" />
          <MatrixCell label="Flat pricing"    status="No tracked hours"    tone="ok" />
          <MatrixCell label="Data export"     status="GET /api/export"     tone="ok" />
        </div>

        <div className="landing-pricing-footer">
          <a href={DEMO_EMAIL} className="landing-text-link">
            Talk to us about pricing
            <IconArrow />
          </a>
          <span className="landing-pricing-sep">·</span>
          <a href="mailto:hello@instantml.ai" className="landing-text-link">
            hello@instantml.ai
          </a>
        </div>
      </Section>

      {/* CTA */}
      <Section className="landing-section-py">
        <div className="landing-cta-card">
          <div className="bg-grid landing-bg-overlay landing-cta-card__grid" />
          <div className="landing-cta-card__glow" />
          <div className="landing-cta-card__body">
            <div className="landing-cta-card__logo">
              <LogoMark size={28} color="var(--accent)" />
            </div>
            <h2 className="landing-cta-h2">
              Run your next experiment{" "}
              <span className="font-serif-italic landing-h2-muted">on a tool that keeps up</span>.
            </h2>
            <p className="landing-cta-desc">
              We&apos;re onboarding a small first cohort of design partners.
              Send a real email, get a real engineer. No sales calls — just
              your real runs, ingested, with our team helping you compare.
            </p>
            <div className="landing-cta-row">
              <a href="/signup" className="landing-cta-primary">
                Become a design partner
                <IconArrow />
              </a>
              <a href="#developers" className="landing-cta-ghost">
                See the SDK
              </a>
            </div>
            <p className="landing-cta-note">hello@instantml.ai · we reply same business day</p>
          </div>
        </div>
      </Section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__grid">
            <div className="landing-footer__brand">
              <div className="landing-footer__brand-row">
                <LogoMark size={20} color="var(--accent)" />
                <span className="landing-footer__brand-name">InstantML</span>
              </div>
              <p className="landing-footer__brand-desc">
                Training observability that&apos;s actually fast.
                Sub-second charts at 90k runs, flat pricing, and a data
                model your team can own.
              </p>
            </div>
            <FooterCol
              title="Product"
              links={[
                ["How it works", "#how"],
                ["Capabilities", "#capabilities"],
                ["Developers", "#developers"],
                ["What ships today", "#pricing"],
              ]}
            />
            <FooterCol
              title="Migrate"
              links={[
                ["From W&B", "#developers"],
                ["From MLflow", "#developers"],
                ["From Neptune", "#developers"],
              ]}
            />
            <FooterCol
              title="Company"
              links={[
                ["Contact", "mailto:hello@instantml.ai"],
                ["Careers", "mailto:careers@instantml.ai"],
              ]}
            />
          </div>

          <div className="landing-footer__bottom">
            <span className="landing-footer__copy">
              &copy; {new Date().getFullYear()} InstantML
            </span>
            <span className="landing-footer__status">
              <span className="status-live" />
              v0.1 · hello@instantml.ai
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
