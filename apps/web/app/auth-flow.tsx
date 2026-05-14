"use client";

import { ArrowRight, CheckCircle2, Copy, KeyRound, UserPlus } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { ApiClient } from "../src/api.js";
import { sanitizeNextPath } from "../src/routes.js";

type AuthMode = "signin" | "signup" | "onboarding";
type SessionPayload = {
  authenticated?: boolean;
  organization?: { id: string; name: string; slug: string; account_type?: string; seat_limit?: number };
  user?: { primary_email: string; display_name?: string | null };
  membership?: { role: string; status: string };
};
type DevGoogleAuthPayload = {
  email: string;
  display_name?: string;
  account_type?: string;
  org_name?: string;
  seat_emails?: string[];
};
const SHARED_DEMO_EMAIL = "hello@instantml.ai";
const SHARED_DEMO_ORG = "InstantML Demo";

export function AuthFlow({ mode }: { mode: AuthMode }) {
  const api = useMemo(() => new ApiClient(), []);
  const [config, setConfig] = useState({ dev_auth_enabled: false, managed_google_enabled: false, loaded: false });
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [accountType, setAccountType] = useState("customer");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [seatEmails, setSeatEmails] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("Checking provider availability...");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const nextPath = typeof window === "undefined" ? "/dashboard/runs" : sanitizeNextPath(new URLSearchParams(window.location.search).get("next"));

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.get("/api/auth/config", { signal: controller.signal }).catch(() => ({})),
      api.get("/api/auth/session", { signal: controller.signal }).catch(() => ({ authenticated: false })),
    ]).then(([configPayload, sessionPayload]) => {
      setConfig({
        dev_auth_enabled: Boolean((configPayload as any).dev_auth_enabled),
        managed_google_enabled: Boolean((configPayload as any).managed_google_enabled),
        loaded: true,
      });
      if ((sessionPayload as SessionPayload).authenticated) {
        setSession(sessionPayload as SessionPayload);
        setMessage("Signed in. Finish onboarding when you are ready.");
      } else {
        setMessage("Use the local development Google-style flow to continue.");
      }
    }).catch((error) => {
      if (error?.name !== "AbortError") setMessage(error instanceof Error ? error.message : "Unable to load auth state.");
    });
    return () => controller.abort();
  }, [api]);

  async function createDevGoogleSession(payload: DevGoogleAuthPayload) {
    setBusy(true);
    setMessage("Creating your workspace session...");
    try {
      const sessionPayload = await api.post("/api/auth/dev/google", payload);
      setSession(sessionPayload as SessionPayload);
      setMessage("Signed in. Create your first SDK key to finish onboarding.");
      window.history.replaceState(null, "", "/onboarding");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createDevGoogleSession({
      email,
      display_name: displayName,
      account_type: accountType,
      org_name: orgName || undefined,
      seat_emails: seatEmails.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
    });
  }

  async function submitSharedDemo() {
    await createDevGoogleSession({
      email: SHARED_DEMO_EMAIL,
      display_name: SHARED_DEMO_ORG,
      account_type: "business",
      org_name: SHARED_DEMO_ORG,
    });
  }

  async function createKey() {
    if (!session?.organization?.id) return;
    setBusy(true);
    setCopied(false);
    setMessage("Creating a copy-once SDK API key...");
    try {
      const payload = await api.post(`/api/orgs/${session.organization.id}/api-keys`, {
        name: "Onboarding SDK key",
      });
      const secret = typeof (payload as any).api_key === "string" ? (payload as any).api_key : "";
      setApiKey(secret);
      setMessage("API key created. Save it before opening the dashboard.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create API key.");
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!apiKey) return;
    await navigator.clipboard?.writeText(apiKey);
    setCopied(true);
    setMessage("API key copied.");
  }

  const isOnboarding = mode === "onboarding" || Boolean(session?.authenticated);
  const title = isOnboarding ? "Finish onboarding" : mode === "signin" ? "Sign in to your workspace" : "Create your workspace";

  return (
    <main className="auth-page" aria-busy={busy}>
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">{config.loaded ? providerLabel(config) : "Checking provider"}</p>
        <h1 id="auth-title">{title}</h1>
        <p className="auth-copy">
          {isOnboarding
            ? "Create a scoped SDK key, reserve seats when needed, then open the dashboard."
            : "Use the same product-shaped flow as Google auth while local development credentials are not configured."}
        </p>

        {!isOnboarding ? (
          <form className="auth-form" onSubmit={submitAuth}>
            <button className="shared-demo-button" disabled={busy || !config.dev_auth_enabled} onClick={submitSharedDemo} type="button">
              <UserPlus size={15} /> Continue as shared demo <ArrowRight size={15} />
            </button>
            <div className="auth-form-divider" aria-hidden="true"><span /></div>
            <label>
              Email
              <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
            </label>
            <label>
              Name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Ada Lovelace" />
            </label>
            <fieldset className="segmented-field">
              <legend>Account type</legend>
              <label><input checked={accountType === "customer"} name="account-type" onChange={() => setAccountType("customer")} type="radio" /> Customer</label>
              <label><input checked={accountType === "business"} name="account-type" onChange={() => setAccountType("business")} type="radio" /> Business</label>
            </fieldset>
            <label>
              Organization
              <input value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder={accountType === "business" ? "Acme Research" : "Personal Workspace"} />
            </label>
            {accountType === "business" ? (
              <label>
                Reserved seats
                <textarea value={seatEmails} onChange={(event) => setSeatEmails(event.target.value)} placeholder="teammate@example.com" rows={3} />
                <small>No invitations are sent yet; this only reserves org seats.</small>
              </label>
            ) : null}
            <button className="primary-button" disabled={busy || !config.dev_auth_enabled} type="submit">
              <UserPlus size={15} /> Continue with Dev Google <ArrowRight size={15} />
            </button>
          </form>
        ) : (
          <div className="onboarding-stack">
            <div className="onboarding-summary">
              <CheckCircle2 size={16} />
              <div>
                <strong>{session?.organization?.name ?? "Workspace ready"}</strong>
                <span>{session?.user?.primary_email ?? "Signed in"} · {session?.membership?.role ?? "owner"}</span>
              </div>
            </div>
            <button className="primary-button" disabled={busy || !session?.organization?.id} onClick={createKey} type="button">
              <KeyRound size={15} /> Create SDK API key
            </button>
            {apiKey ? (
              <div className="api-key-reveal" role="status" aria-live="polite">
                <strong>Copy-once API key</strong>
                <code>{apiKey}</code>
                <button className="secondary" onClick={copyKey} type="button"><Copy size={14} /> {copied ? "Copied" : "Copy key"}</button>
              </div>
            ) : null}
            <pre className="sdk-snippet">export RLOBS_API_KEY={apiKey || "rlobs_..."}
python train.py</pre>
            <a className="button-link" href={apiKey ? nextPath : "/dashboard/runs"}>Open dashboard <ArrowRight size={15} /></a>
          </div>
        )}

        <p className="auth-status" role="status" aria-live="polite">{message}</p>
      </section>
    </main>
  );
}

function providerLabel(config: { dev_auth_enabled: boolean; managed_google_enabled: boolean }) {
  if (config.dev_auth_enabled) return "Local dev Google-style auth";
  if (config.managed_google_enabled) return "Managed Google auth";
  return "No provider configured";
}
