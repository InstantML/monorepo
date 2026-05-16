"use client";

import { Show, useClerk } from "@clerk/nextjs";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiClient } from "../src/api.js";
import { pathFromLegacyHash } from "../src/routes.js";
import { InstantMlMark } from "./instantml-mark";

type AuthConfig = {
  dev_auth_enabled: boolean;
  managed_clerk_enabled: boolean;
};

export default function LandingPage() {
  const api = useMemo(() => new ApiClient(), []);
  const clerk = useClerk();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const legacyPath = pathFromLegacyHash(window.location.hash);
    if (legacyPath) {
      window.location.replace(legacyPath);
      return;
    }
    const controller = new AbortController();
    (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const payload = await api.get("/api/auth/config", { signal: controller.signal });
          setConfigError("");
          setConfig({
            dev_auth_enabled: Boolean(payload.dev_auth_enabled),
            managed_clerk_enabled: Boolean(payload.managed_clerk_enabled),
          });
          return;
        } catch (error: any) {
          if (controller.signal.aborted || error?.name === "AbortError") return;
          if (attempt >= 2) {
            setConfigError(error instanceof Error ? error.message : "Provider availability is unavailable.");
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
    })();
    return () => controller.abort();
  }, [api]);

  // Sign-out must be robust. The InstantML logout POST can intermittently
  // ETIMEDOUT against the hosted API; the old code awaited it before
  // clerk.signOut(), so one timeout left the user fully signed in. Logout is
  // idempotent, so retry it (bounded) best-effort to actually revoke the
  // server session, then ALWAYS clear the Clerk session so a failed logout
  // can never strand the user on a signed-in page.
  async function bestEffortLogout() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 6000);
      try {
        await api.post("/api/auth/logout", {}, { signal: ctrl.signal });
        window.clearTimeout(timer);
        return;
      } catch {
        window.clearTimeout(timer);
      }
    }
  }

  async function signOut() {
    setSigningOut(true);
    await bestEffortLogout();
    // Safety net: if clerk.signOut() hangs (no rejection), don't leave the
    // button stuck — force navigation home after a bounded wait.
    const safety = window.setTimeout(() => window.location.assign("/"), 8000);
    try {
      await clerk.signOut({ redirectUrl: "/" });
    } catch {
      window.location.assign("/");
    } finally {
      window.clearTimeout(safety);
    }
  }

  const providerReady = Boolean(config?.dev_auth_enabled || config?.managed_clerk_enabled);

  return (
    <div className="iml-landing">
      <header className="iml-bar">
        <a className="iml-brand" href="/">
          <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
          InstantML
        </a>
        <nav className="iml-bar-actions" aria-label="Account">
          {config?.managed_clerk_enabled ? (
            <>
              <Show when="signed-out">
                <a className="iml-btn iml-btn--ghost" href="/signin">Sign in</a>
                <a className="iml-btn iml-btn--primary" href="/signup">Start workspace</a>
              </Show>
              <Show when="signed-in">
                <a className="iml-btn iml-btn--primary" href="/dashboard/runs">Open app</a>
                <button className="iml-btn iml-btn--ghost" disabled={signingOut} onClick={signOut} type="button">
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </Show>
            </>
          ) : (
            <>
              <a className="iml-btn iml-btn--ghost" href="/signin">Sign in</a>
              <a className="iml-btn iml-btn--primary" href="/signup">Start workspace</a>
            </>
          )}
        </nav>
      </header>

      <main className="iml-stage">
        <section className="iml-hero">
          <p className="iml-eyebrow is-accent">Training observability for serious ML teams</p>
          <h1>The training tool you keep <span className="iml-em">open all day.</span></h1>
          <p className="iml-lede">
            Fast logging, fast comparison, clear artifacts, and a Rust/ClickHouse backend your team
            can trust. One <code>pip install</code>, three SDK calls.
          </p>

          {config?.managed_clerk_enabled ? (
            <>
              <Show when="signed-in">
                <div className="iml-cta">
                  <a className="iml-btn iml-btn--primary iml-btn--lg" href="/dashboard/runs">
                    Open app <ArrowRight className="iml-arrow" size={15} />
                  </a>
                  <button className="iml-btn iml-btn--outline iml-btn--lg" disabled={signingOut} onClick={signOut} type="button">
                    {signingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              </Show>
              <Show when="signed-out">
                <div className="iml-cta">
                  <a className="iml-btn iml-btn--primary iml-btn--lg" href="/signup">
                    Start a workspace <ArrowRight className="iml-arrow" size={15} />
                  </a>
                  <a className="iml-btn iml-btn--outline iml-btn--lg" href="/signin">Sign in</a>
                </div>
              </Show>
            </>
          ) : (
            <div className="iml-cta">
              {providerReady ? (
                <a className="iml-btn iml-btn--primary iml-btn--lg" href="/signup">
                  Start a workspace <ArrowRight className="iml-arrow" size={15} />
                </a>
              ) : (
                <button className="iml-btn iml-btn--primary iml-btn--lg" disabled type="button">
                  Sign-in unavailable
                </button>
              )}
              <a className="iml-btn iml-btn--outline iml-btn--lg" href="/signin">Sign in</a>
            </div>
          )}

          <div className="iml-proof-chips">
            <span className="iml-chip is-accent"><span className="iml-dot is-running" /> Bounded metric charts</span>
            <span className="iml-chip"><CheckCircle2 size={12} /> Copy-once SDK keys</span>
            <span className="iml-chip"><CheckCircle2 size={12} /> Rust / ClickHouse storage</span>
          </div>

          {config && !providerReady ? (
            <p className="iml-hint is-err" role="status">
              No sign-in provider is configured for this environment.
            </p>
          ) : configError ? (
            <p className="iml-hint" role="status">{configError}</p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
