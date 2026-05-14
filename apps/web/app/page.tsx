"use client";

import { ArrowRight, BarChart3, CheckCircle2, Code2, GitCompare, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiClient } from "../src/api.js";
import { pathFromLegacyHash } from "../src/routes.js";

type AuthConfig = {
  dev_auth_enabled: boolean;
  managed_google_enabled: boolean;
};

export default function LandingPage() {
  const api = useMemo(() => new ApiClient(), []);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState("");

  useEffect(() => {
    const legacyPath = pathFromLegacyHash(window.location.hash);
    if (legacyPath) {
      window.location.replace(legacyPath);
      return;
    }
    const controller = new AbortController();
    api.get("/api/auth/config", { signal: controller.signal })
      .then((payload) => {
        setConfig({
          dev_auth_enabled: Boolean(payload.dev_auth_enabled),
          managed_google_enabled: Boolean(payload.managed_google_enabled),
        });
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setConfigError(error instanceof Error ? error.message : "Provider availability is unavailable.");
      });
    return () => controller.abort();
  }, [api]);

  const primaryHref = config?.dev_auth_enabled ? "/signup" : config?.managed_google_enabled ? "/signin" : "";
  const providerLabel = config
    ? config.dev_auth_enabled
      ? "Local dev Google-style auth enabled"
      : config.managed_google_enabled
        ? "Managed Google enabled"
        : "No sign-in provider enabled"
    : configError || "Checking provider availability...";

  return (
    <main className="landing-page">
      <header className="landing-nav" aria-label="Public navigation">
        <a className="landing-brand" href="/">
          <span className="brand-mark small" aria-hidden="true"><BarChart3 size={17} /></span>
          <span>Training Observability</span>
        </a>
        <nav>
          <a href="/signin">Sign in</a>
          <a className="button-link secondary-link" href="/signup">Start local dev</a>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="landing-copy">
          <p className="eyebrow">Fast training-loop visibility</p>
          <h1>Training Observability</h1>
          <p className="landing-lede">
            Browse runs, compare metrics, inspect artifacts, and hand a fresh SDK key to a training loop without pulling full histories into the first view.
          </p>
          <div className="landing-actions">
            {primaryHref ? (
              <a className="button-link" href={primaryHref}>
                {config?.dev_auth_enabled ? "Continue with Dev Google" : "Continue with Google"} <ArrowRight size={15} />
              </a>
            ) : (
              <button disabled type="button">Google sign-in unavailable</button>
            )}
            <a className="button-link secondary-link" href="/signin">Open sign in</a>
          </div>
          <div className="provider-status" role="status" aria-live="polite">
            <span className={config?.dev_auth_enabled || config?.managed_google_enabled ? "good" : "neutral"} />
            <strong>Provider availability</strong>
            <em>{providerLabel}</em>
          </div>
          {config?.dev_auth_enabled ? <p className="auth-note">Local development uses an explicitly labeled Google-style shortcut. No managed Google OAuth button is shown while it is disabled.</p> : null}
          <div className="landing-proof">
            <span><CheckCircle2 size={14} /> Rust/ClickHouse summaries</span>
            <span><CheckCircle2 size={14} /> Bounded metric charts</span>
            <span><CheckCircle2 size={14} /> Copy-once SDK keys</span>
          </div>
        </div>

        <DashboardPreview />
      </section>
    </main>
  );
}

function DashboardPreview() {
  const chartPoints = "M8 88 L56 72 L104 76 L152 44 L200 50 L248 24 L296 31";
  return (
    <section className="landing-preview" aria-label="Dashboard preview">
      <div className="preview-topbar">
        <span className="brand-mark tiny" aria-hidden="true"><BarChart3 size={14} /></span>
        <strong>Runs</strong>
        <span className="preview-chip">1,000 runs</span>
        <span className="preview-chip good">Operational</span>
      </div>
      <div className="preview-grid">
        <div className="preview-panel run-table-preview">
          <div className="preview-head"><strong>Run table</strong><small>bounded summaries</small></div>
          {[
            ["rl-sweep-seed-44", "finished", "0.91"],
            ["llm-ft-seed-21", "running", "0.87"],
            ["reward-ablation-13", "finished", "0.82"],
          ].map(([name, status, score]) => (
            <div className="preview-row" key={name}>
              <span>{name}</span>
              <em>{status}</em>
              <strong>{score}</strong>
            </div>
          ))}
        </div>
        <div className="preview-panel metric-preview">
          <div className="preview-head"><strong>eval/return_mean</strong><small>step range</small></div>
          <svg viewBox="0 0 304 110" role="img" aria-label="Metric line trending upward">
            <path className="preview-axis" d="M8 98 H296" />
            <path className="preview-line" d={chartPoints} />
            <circle cx="248" cy="24" r="4" />
          </svg>
        </div>
        <div className="preview-panel compare-preview">
          <div className="preview-head"><strong>Compare</strong><small>changed signals</small></div>
          <div className="compare-preview-row"><GitCompare size={14} /> seed <strong>44 beats 21</strong></div>
          <div className="compare-preview-row"><ShieldCheck size={14} /> artifacts <strong>3 matched</strong></div>
          <div className="compare-preview-row"><KeyRound size={14} /> SDK key <strong>ready</strong></div>
        </div>
        <pre className="preview-panel sdk-preview"><Code2 size={15} /> export RLOBS_API_KEY=rlobs_...
python train.py --tracker rlobs</pre>
      </div>
    </section>
  );
}
