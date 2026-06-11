"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { LogoMark } from "./LogoMark";
import { NavLogo } from "./NavLogo";
import { MaskingDemo } from "./MaskingDemo";
import { AuditFeed } from "./AuditFeed";
import { TtlRing } from "./TtlRing";
import { ThemeToggle } from "./ThemeToggle";

const DEMO_EMAIL =
  "mailto:hello@instantml.ai?subject=InstantML%20design%20partner&body=Hi%20%E2%80%94%20I%27d%20like%20to%20try%20InstantML.%0A%0ATeam%3A%0AStack%3A%0AModel%2Fworkflow%3A%0ARun%20volume%3A%0ABiggest%20pain%20with%20current%20tool%3A";
const COPYRIGHT_YEAR = new Date().getFullYear();

function useSectionObserver() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Content is visible by default (no-JS and first paint stay readable).
    // Only sections still below the viewport at mount opt into the fade, and
    // never when the user prefers reduced motion.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.classList.add("section-pre");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          entry.target.classList.remove("section-pre");
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.12 }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      el.classList.remove("section-pre");
    };
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
        <text x="40" y="34" fontFamily="var(--font-mono)" fontSize="12" fill="#1FB877" letterSpacing="0.1em">YOUR TRAINING JOB</text>
        <rect x="60" y="92" width="120" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" />
        <text x="120" y="125" textAnchor="middle" fontFamily="var(--font-display)" fontSize="13" fontWeight="500" fill="#F8FAFC">Trainer</text>
        <text x="120" y="146" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">PyTorch · JAX · TRL</text>
        <line x1="180" y1="130" x2="240" y2="130" stroke="#2A2E3D" strokeWidth="1" />
        <rect x="220" y="92" width="100" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" />
        <text x="270" y="121" textAnchor="middle" fontFamily="var(--font-display)" fontSize="13" fontWeight="500" fill="#F8FAFC">SDK</text>
        <text x="270" y="140" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">buffered</text>
        <text x="270" y="154" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">offline spool</text>
        <line x1="340" y1="130" x2="410" y2="130" className="data-flow-line" stroke="#1FB877" strokeWidth="1.5" />
        <polygon points="408,125 420,130 408,135" fill="#1FB877" />
        <rect x="420" y="76" width="180" height="108" rx="10" fill="#0D0F15" stroke="#1FB877" strokeWidth="1.4" className="pulse-node" />
        <text x="510" y="106" textAnchor="middle" fontFamily="var(--font-display)" fontSize="14" fontWeight="600" fill="#F8FAFC">InstantML API</text>
        <line x1="440" y1="118" x2="580" y2="118" stroke="#1F1F26" strokeWidth="1" />
        <text x="510" y="138" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#94A3B8">Rust · ClickHouse</text>
        <text x="510" y="156" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">typed summaries</text>
        <text x="510" y="172" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">indexed search</text>
        <line x1="600" y1="130" x2="670" y2="130" className="data-flow-line" stroke="#1FB877" strokeWidth="1.5" />
        <polygon points="668,125 680,130 668,135" fill="#1FB877" />
        <rect x="680" y="92" width="120" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" />
        <text x="740" y="121" textAnchor="middle" fontFamily="var(--font-display)" fontSize="13" fontWeight="500" fill="#F8FAFC">Dashboard</text>
        <text x="740" y="140" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">runs · compare</text>
        <text x="740" y="154" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">charts · artifacts</text>
        <line x1="800" y1="130" x2="855" y2="130" stroke="#2A2E3D" strokeWidth="1" />
        <rect x="820" y="92" width="80" height="76" rx="8" fill="#0D0F15" stroke="#2A2E3D" strokeWidth="1" strokeDasharray="3 3" />
        <text x="860" y="125" textAnchor="middle" fontFamily="var(--font-display)" fontSize="12" fontWeight="500" fill="#F8FAFC">Artifacts</text>
        <text x="860" y="146" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#64748B">S3 / R2</text>
        <text x="120" y="208" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#475569" letterSpacing="0.06em">GPU NODES</text>
        <text x="270" y="208" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#475569" letterSpacing="0.06em">PYTHON SDK</text>
        <text x="510" y="208" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#1FB877" letterSpacing="0.06em">HOT PATH</text>
        <text x="740" y="208" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#475569" letterSpacing="0.06em">NEXT/REACT</text>
        <text x="860" y="208" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="12" fill="#475569" letterSpacing="0.06em">OBJECT STORE</text>
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
              <span className="landing-code-accent">node</span>
              <span className="landing-code-heading"> tools/import-wandb-json.mjs ./wandb-export.json --dry-run</span>
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
      <span className="landing-code-dim"># Start a run, log metrics, finish.</span>{"\n"}
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
      <span className="landing-code-mute">{"}, step=step)"}</span>{"\n\n"}
      <span className="landing-code-heading">run.</span>
      <span className="landing-code-accent">log_checkpoint_file</span>
      <span className="landing-code-mute">(</span>
      <span className="landing-code-str">&quot;./ckpt/model.pt&quot;</span>
      <span className="landing-code-mute">, step=step)</span>{"\n"}
      <span className="landing-code-heading">run.</span>
      <span className="landing-code-accent">finish</span>
      <span className="landing-code-mute">()</span>
    </code></pre>
  );
}

function ImportSnippet() {
  return (
    <pre><code>
      <span className="landing-code-dim"># Import JSON exports.</span>{"\n"}
      <span className="landing-code-accent">node</span>
      <span className="landing-code-heading"> tools/import-wandb-json.mjs </span>
      <span className="landing-code-str">./wandb-export.json</span>
      <span className="landing-code-mute"> \</span>{"\n"}
      <span className="landing-code-heading">    --project </span>
      <span className="landing-code-str">migrated-from-wandb</span>
      <span className="landing-code-mute"> \</span>{"\n"}
      <span className="landing-code-heading">    --dry-run</span>{"\n\n"}
      <span className="landing-code-dim"># Also works:</span>{"\n"}
      <span className="landing-code-accent">node</span>
      <span className="landing-code-heading"> tools/import-mlflow-json.mjs </span>
      <span className="landing-code-str">./mlflow-export.json</span>{"\n"}
      <span className="landing-code-accent">node</span>
      <span className="landing-code-heading"> tools/import-neptune-json.mjs </span>
      <span className="landing-code-str">./neptune-export.json</span>{"\n\n"}
      <span className="landing-code-dim"># Shadow W&B scalar logs while you switch:</span>{"\n"}
      <span className="landing-code-heading">run = im.</span>
      <span className="landing-code-accent">init</span>
      <span className="landing-code-mute">(</span>
      <span className="landing-code-fg">shadow_wandb=</span>
      <span className="landing-code-str">True</span>
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

function HeroProductPreview() {
  const runs = [
    ["r_8f21", "hosted-scale-cp", "188.95", "running"],
    ["r_77ac", "hosted-scale-ci", "198.82", "finished"],
    ["r_3c18", "sweep-baseline", "186.76", "finished"],
    ["r_52de", "eval-regression", "199.49", "running"],
  ];

  return (
    <div className="landing-product-preview" aria-label="InstantML dashboard preview">
      <div className="landing-product-preview__rail">
        <div className="landing-product-preview__rail-head">
          <span>Runs</span>
          <strong>100 selected</strong>
        </div>
        {runs.map(([id, name, value, status], index) => (
          <div className={`landing-product-preview__run ${index === 1 ? "is-selected" : ""}`} key={id}>
            <span className={`landing-product-preview__status is-${status}`} />
            <div>
              <strong>{name}</strong>
              <small>{id} · {value}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="landing-product-preview__main">
        <div className="landing-product-preview__toolbar">
          <div>
            <span className="landing-product-preview__eyebrow">Line · eval/return_mean</span>
            <strong>Return Mean</strong>
          </div>
          <div className="landing-product-preview__chips">
            <span>Grouped</span>
            <span>Full fidelity</span>
            <span>Step 124</span>
          </div>
        </div>
        <svg className="landing-product-preview__chart" viewBox="0 0 620 250" role="img" aria-label="Return mean curves">
          <g className="landing-product-preview__grid">
            {[44, 88, 132, 176, 220].map((y) => <line key={y} x1="36" x2="600" y1={y} y2={y} />)}
            {[124, 236, 348, 460, 572].map((x) => <line key={x} x1={x} x2={x} y1="28" y2="224" />)}
          </g>
          <path className="landing-product-preview__line is-blue" d="M42 212 C72 170 102 142 138 124 C190 98 254 84 320 72 C390 60 470 53 596 46" />
          <path className="landing-product-preview__line is-green" d="M42 216 C82 164 120 136 162 116 C226 86 300 70 380 60 C462 49 520 43 596 38" />
          <path className="landing-product-preview__line is-amber" d="M42 218 C74 176 112 154 156 138 C228 112 306 94 392 82 C474 72 532 65 596 58" />
          <path className="landing-product-preview__line is-coral" d="M42 220 C86 182 122 164 176 148 C254 124 324 110 414 98 C500 87 552 80 596 74" />
          <circle cx="518" cy="43" r="4" className="landing-product-preview__point is-green" />
          <circle cx="518" cy="66" r="4" className="landing-product-preview__point is-amber" />
          <g className="landing-product-preview__axis">
            <text x="36" y="242">0</text>
            <text x="592" y="242">20k</text>
            <text x="6" y="222">140</text>
            <text x="6" y="48">200</text>
          </g>
        </svg>
      </div>
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
      ? "0 0 0 1px rgba(31,184,119,0.18)"
      : tone === "progress"
        ? "0 0 0 1px rgba(224,176,122,0.18)"
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
            {href.startsWith("/") ? (
              <Link href={href} className="landing-footer-link">{label}</Link>
            ) : (
              <a href={href} className="landing-footer-link">{label}</a>
            )}
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
            <a href="#developers" className="landing-nav__link">SDK</a>
            <Link href="/docs" className="landing-nav__link">Docs</Link>
            <Link href="/pricing" className="landing-nav__link landing-nav__link--mobile">Pricing</Link>
            <Link href="/signin" className="landing-nav__link landing-nav__link--md">Sign in</Link>
            <ThemeToggle />
            <Link href="/signup" className="landing-cta-primary landing-cta-primary--sm">
              Start free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <div className="landing-hero-wrap">
        <Section className="landing-hero-section">
          <div className="landing-hero-content">
            <h1 className="hero-rise-2 landing-h1">
              Experiment tracking that keeps up with training.
            </h1>

            <p className="hero-rise-3 landing-lede">
              Log runs, compare metrics, inspect artifacts, and export your
              data without waiting on the dashboard.
            </p>

            <div className="hero-rise-4 landing-cta-row">
              <Link href="/signup" className="landing-cta-primary">
                Start free
                <IconArrow />
              </Link>
              {/* A2: demo story entry — routes to sign-in with the shared
                  read-only demo action spotlighted. */}
              <Link href="/signin?intent=demo" className="landing-cta-ghost">Try the live demo</Link>
              <Link href="/docs" className="landing-cta-ghost">Read docs</Link>
            </div>

            <div className="hero-rise-4 landing-proof-chips">
              <span className="landing-proof-chip">
                <span className="landing-proof-chip__check"><IconCheck /></span>
                Python SDK
              </span>
              <span className="landing-proof-chip">
                <span className="landing-proof-chip__check"><IconCheck /></span>
                W&amp;B, MLflow, Neptune imports
              </span>
              <span className="landing-proof-chip">
                <span className="landing-proof-chip__check"><IconCheck /></span>
                Hosted + Premium BYOC
              </span>
            </div>

            <div className="hero-rise-4">
              <HeroProductPreview />
            </div>
          </div>
        </Section>
      </div>

      {/* Stats */}
      <Section className="landing-stats-section">
        <div className="landing-stats-grid">
          <StatCard
            k="Large run history"
            v="50k runs"
            hint="Newest-page reads are 236 ms p95."
          />
          <StatCard
            k="Best-run sorting"
            v="<1 sec"
            hint="Sort by metric best from maintained summaries."
          />
          <StatCard
            k="Fast chart opens"
            v="<1 sec"
            hint="1,000 chart points read in 224 ms p95."
          />
        </div>
      </Section>

      {/* How it works */}
      <Section id="how" className="landing-section-py">
        <div className="landing-section-intro">
          <h2 className="landing-h2">
            Install the SDK.{" "}
            <span className="font-serif-italic landing-h2-muted">Log the run.</span>
          </h2>
          <p className="landing-section-body">
            The Python SDK buffers metrics and sends them to a Rust +
            ClickHouse backend. Run lists stay summary-backed. Charts fetch
            bounded series.
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

      {/* Capabilities */}
      <Section className="landing-section-py" id="capabilities">
        <div className="landing-section-intro">
          <h2 className="landing-h2">
            The parts teams use{" "}
            <span className="font-serif-italic landing-h2-muted">every day.</span>
          </h2>
        </div>

        <div className="landing-bento-6">
          {/* Big — live loss chart */}
          <div className="bento-cell landing-bento-big">
            <div className="landing-bento-inner-pad">
              <BentoEyebrow icon={<IconChart />} label="Metric charts" />
              <h3 className="landing-bento-h3">Readable curves for selected runs.</h3>
              <p className="landing-bento-body">
                Streamed scalar series, grouped averages, smoothing, zoom,
                and hover readouts.
              </p>
            </div>
            <div className="landing-bento-chart-wrap">
              <MaskingDemo />
            </div>
          </div>

          {/* Latency dial */}
          <div className="bento-cell landing-bento-big landing-bento-dial">
            <div className="landing-bento-inner-pad">
              <BentoEyebrow icon={<IconBolt />} label="Benchmarked reads" />
              <h3 className="landing-bento-h3">Fast reads on large projects.</h3>
              <p className="landing-bento-body">
                Current hosted benchmarks keep a 50k-run project sub-second for
                newest pages, best-metric sorting, and 1,000-point chart reads.
              </p>
            </div>
            <div className="landing-bento-dial-wrap">
              <TtlRing />
            </div>
          </div>

          {/* SDK tail */}
          <div className="bento-cell landing-bento-sm">
            <div className="landing-bento-inner-pad">
              <BentoEyebrow icon={<IconStream />} label="SDK queue" />
              <h3 className="landing-bento-h3-sm">Buffered logging.</h3>
              <p className="landing-bento-body-sm">init · log · artifact · checkpoint · finish.</p>
            </div>
            <div className="landing-bento-feed-wrap">
              <AuditFeed />
            </div>
          </div>

          {/* Typed attributes */}
          <div className="bento-cell landing-bento-sm landing-bento-padded">
            <BentoEyebrow icon={<IconBox />} label="Run data" />
            <h3 className="landing-bento-h3-sm">Typed fields.</h3>
            <p className="landing-bento-body-sm landing-bento-body-mb">
              Configs, metrics, tags, artifacts, histograms, and media stay
              queryable.
            </p>
            <div className="landing-pill-row">
              {["floats", "strings", "files", "histograms", "tags"].map((p) => (
                <span key={p} className="pill">{p}</span>
              ))}
            </div>
          </div>

          {/* Import paths */}
          <div className="bento-cell landing-bento-sm landing-bento-padded">
            <BentoEyebrow icon={<IconMenu />} label="Migration" />
            <h3 className="landing-bento-h3-sm">Bring old runs with you.</h3>
            <p className="landing-bento-body-sm landing-bento-body-mb">
              Import W&amp;B, MLflow, and Neptune JSON. Shadow W&amp;B scalar
              logs during migration.
            </p>
            <div className="landing-pill-row">
              {["W&B JSON", "MLflow JSON", "Neptune JSON", "shadow_wandb"].map((p) => (
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
            <h2 className="landing-h2">
              Three calls{" "}
              <span className="font-serif-italic landing-h2-muted">cover the loop.</span>
            </h2>
            <p className="landing-section-body landing-dev-body">
              The SDK is small on purpose:{" "}
              <code className="landing-code-inline">init</code>,{" "}
              <code className="landing-code-inline">log</code>,{" "}
              and <code className="landing-code-inline">finish</code> cover the
              daily loop. Artifacts and checkpoints are files.
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
          <h2 className="landing-h2">
            Shipping now.
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
          <MatrixCell label="BYOC ClickHouse" status="Premium option"      tone="ok" />
          <MatrixCell label="Hosted SaaS"     status="Design partners"     tone="progress" />
          <MatrixCell label="Dual-log to W&B" status="In testing"          tone="progress" />
          <MatrixCell label="Predictable pricing" status="No tracked hours" tone="ok" />
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
            <h2 className="landing-cta-h2">
              Bring one project.
            </h2>
            <p className="landing-cta-desc">
              We&apos;ll help you import it, compare real runs, and decide if
              InstantML earns a place in your training loop.
            </p>
            <div className="landing-cta-row">
              <Link href="/signup" className="landing-cta-primary">
                Start free
                <IconArrow />
              </Link>
              <Link href="/docs" className="landing-cta-ghost">Read docs</Link>
            </div>
            <p className="landing-cta-note">hello@instantml.ai</p>
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
                Experiment tracking that keeps up with training.
              </p>
            </div>
            <FooterCol
              title="Product"
              links={[
                ["How it works", "#how"],
                ["Capabilities", "#capabilities"],
                ["Developers", "#developers"],
                ["Docs", "/docs"],
                ["Pricing", "/pricing"],
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
              &copy; {COPYRIGHT_YEAR} InstantML
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
