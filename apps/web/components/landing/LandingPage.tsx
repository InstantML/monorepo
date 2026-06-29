"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { LogoMark } from "./LogoMark";
import { NavLogo } from "./NavLogo";
import { MaskingDemo } from "./MaskingDemo";
import { AuditFeed } from "./AuditFeed";
import { TtlRing } from "./TtlRing";
import { ThemeToggle } from "./ThemeToggle";

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

const FLOW_STEPS: {
  num: string;
  title: string;
  body: ReactNode;
  tags: string[];
  accent?: boolean;
}[] = [
  {
    num: "01",
    title: "Log from your loop",
    body: (
      <>
        The Python SDK buffers <code className="landing-code-inline">init</code>,{" "}
        <code className="landing-code-inline">log</code>, and{" "}
        <code className="landing-code-inline">finish</code> straight from the
        trainer, and spools offline when the network drops.
      </>
    ),
    tags: ["PyTorch", "JAX", "TRL"],
  },
  {
    num: "02",
    title: "Rust + ClickHouse hot path",
    body: (
      <>
        Metrics land as typed summaries with indexed search, so run lists and
        best-metric sorting stay sub-second on large projects.
      </>
    ),
    tags: ["typed summaries", "indexed search"],
    accent: true,
  },
  {
    num: "03",
    title: "Read, compare, export",
    body: (
      <>
        Open charts, compare runs side by side, and pull everything back out.
        Artifacts and checkpoints live in your own S3 / R2.
      </>
    ),
    tags: ["charts", "compare", "S3 / R2"],
  },
];

function FlowArrow() {
  return (
    <div className="landing-flow-arrow" aria-hidden>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14M13 5l7 7-7 7" />
      </svg>
    </div>
  );
}

function PipelineFlow() {
  return (
    <div className="landing-flow">
      {FLOW_STEPS.map((step, i) => (
        <Fragment key={step.num}>
          {i > 0 && <FlowArrow />}
          <div className={`landing-flow-step ${step.accent ? "landing-flow-step--accent" : ""}`}>
            <span className="landing-flow-step__num">{step.num}</span>
            <h3 className="landing-flow-step__title">{step.title}</h3>
            <p className="landing-flow-step__body">{step.body}</p>
            <div className="landing-pill-row">
              {step.tags.map((t) => (
                <span key={t} className="pill">{t}</span>
              ))}
            </div>
          </div>
        </Fragment>
      ))}
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

        <PipelineFlow />
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
              v0.1 · hello@instantml.ai
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
