"use client";

import { Show, SignInButton, SignUpButton, UserButton, useAuth, useUser } from "@clerk/nextjs";
import { ArrowRight, CheckCircle2, Copy, Crown, HardDrive, KeyRound, Rocket, ShieldCheck, UserPlus, Users } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ApiClient } from "../src/api.js";
import { sanitizeNextPath } from "../src/routes.js";

type AuthMode = "signin" | "signup" | "onboarding";
type PlanTier = "free" | "pro" | "premium";
type SessionPayload = {
  authenticated?: boolean;
  organization?: { id: string; name: string; slug: string; account_type?: string; plan_tier?: string; seat_limit?: number };
  user?: { primary_email: string; display_name?: string | null };
  membership?: { role: string; status: string };
};
type DevGoogleAuthPayload = {
  email: string;
  display_name?: string;
  mode?: "signin" | "signup";
  account_type?: string;
  org_name?: string;
  plan_tier?: PlanTier;
  seat_emails?: string[];
};
type OrgAvailability = {
  available?: boolean;
  message?: string;
  slug?: string;
};
type AuthConfig = {
  dev_auth_enabled: boolean;
  managed_clerk_enabled: boolean;
  loaded: boolean;
};

const SHARED_DEMO_EMAIL = "hello@instantml.ai";
const SHARED_DEMO_ORG = "InstantML Demo";
const PLAN_OPTIONS: Array<{
  id: PlanTier;
  label: string;
  price: string;
  storage: string;
  seats: string;
  icon: typeof Rocket;
}> = [
  { id: "free", label: "Free", price: "$0", storage: "2 GB", seats: "2 seats", icon: Users },
  { id: "pro", label: "Pro", price: "$199", storage: "1 TB", seats: "3 seats", icon: Rocket },
  { id: "premium", label: "Premium", price: "$699", storage: "5 TB", seats: "10 seats", icon: Crown },
];

export function AuthFlow({ mode }: { mode: AuthMode }) {
  const api = useMemo(() => new ApiClient(), []);
  const clerkExchangeAttemptedRef = useRef(false);
  const { getToken, isLoaded: clerkLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [config, setConfig] = useState<AuthConfig>({ dev_auth_enabled: false, managed_clerk_enabled: false, loaded: false });
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [accountType, setAccountType] = useState("customer");
  const [planTier, setPlanTier] = useState<PlanTier>("free");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [seatEmails, setSeatEmails] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("Checking provider availability...");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [orgAvailability, setOrgAvailability] = useState<OrgAvailability>({});
  const nextPath = typeof window === "undefined" ? "/dashboard/runs" : sanitizeNextPath(new URLSearchParams(window.location.search).get("next"));
  const signupMode = mode === "signup";
  const isOnboarding = mode === "onboarding" || Boolean(session?.authenticated);
  const orgNameRequired = signupMode;
  const orgUnavailable = orgNameRequired && (!orgName.trim() || orgAvailability.available === false);
  const managedClerkReady = config.managed_clerk_enabled && clerkLoaded;

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.get("/api/auth/config", { signal: controller.signal }).catch(() => ({})),
      api.get("/api/auth/session", { signal: controller.signal }).catch(() => ({ authenticated: false })),
    ]).then(([configPayload, sessionPayload]) => {
      setConfig({
        dev_auth_enabled: Boolean((configPayload as any).dev_auth_enabled),
        managed_clerk_enabled: Boolean((configPayload as any).managed_clerk_enabled),
        loaded: true,
      });
      if ((sessionPayload as SessionPayload).authenticated) {
        setSession(sessionPayload as SessionPayload);
        setMessage("Signed in. Finish onboarding when you are ready.");
      } else {
        setMessage((configPayload as any).managed_clerk_enabled ? "Sign in with Clerk to access your workspace." : "Use the local development Google-style flow to continue.");
      }
    }).catch((error) => {
      if (error?.name !== "AbortError") setMessage(error instanceof Error ? error.message : "Unable to load auth state.");
    });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (!signupMode || !orgName.trim()) {
      setOrgAvailability({});
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setOrgAvailability({ message: "Checking organization name..." });
      api.get(`/api/orgs/name-availability?name=${encodeURIComponent(orgName.trim())}`, { signal: controller.signal })
        .then((payload) => setOrgAvailability(payload as OrgAvailability))
        .catch((error) => {
          if (error?.name !== "AbortError") setOrgAvailability({ available: false, message: "Unable to check this organization name." });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, orgName, signupMode]);

  useEffect(() => {
    if (!managedClerkReady || !isSignedIn || signupMode || isOnboarding || clerkExchangeAttemptedRef.current) return;
    clerkExchangeAttemptedRef.current = true;
    void createManagedClerkSession();
  }, [isOnboarding, isSignedIn, managedClerkReady, signupMode]);

  async function createDevGoogleSession(payload: DevGoogleAuthPayload) {
    setBusy(true);
    setMessage("Creating your workspace session...");
    try {
      const sessionPayload = await api.post("/api/auth/dev/google", payload);
      setSession(sessionPayload as SessionPayload);
      if (isSharedDemoSession(sessionPayload as SessionPayload)) {
        setMessage("Signed in to the read-only demo. Opening the dashboard...");
        window.location.assign("/dashboard/runs");
        return;
      }
      setMessage("Signed in. Create your first SDK key to finish onboarding.");
      window.history.replaceState(null, "", "/onboarding");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function createManagedClerkSession() {
    if (signupMode && orgUnavailable) {
      setMessage("Choose an available organization name before continuing.");
      return;
    }
    setBusy(true);
    setMessage(signupMode ? "Creating your hosted workspace..." : "Signing in...");
    try {
      const token = await getToken();
      if (!token) throw new Error("Clerk did not return a session token.");
      const payload = await api.post("/api/auth/clerk", {
        token,
        mode: signupMode ? "signup" : "signin",
        account_type: accountType,
        org_name: signupMode ? orgName.trim() : undefined,
        plan_tier: signupMode ? planTier : undefined,
        seat_emails: signupMode && accountType === "business"
          ? seatEmails.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
          : [],
      });
      setSession(payload as SessionPayload);
      setMessage(signupMode ? "Signed in. Create your first SDK key to finish onboarding." : "Signed in. Opening your dashboard...");
      window.location.assign(signupMode ? "/onboarding" : nextPath);
    } catch (error) {
      clerkExchangeAttemptedRef.current = false;
      setMessage(error instanceof Error ? error.message : "Unable to sign in with Clerk.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (orgUnavailable) {
      setMessage("Choose an available organization name before continuing.");
      return;
    }
    await createDevGoogleSession({
      email,
      display_name: displayName,
      mode: signupMode ? "signup" : "signin",
      account_type: accountType,
      org_name: signupMode ? orgName.trim() : orgName || undefined,
      plan_tier: signupMode ? planTier : undefined,
      seat_emails: signupMode ? seatEmails.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) : [],
    });
  }

  async function submitSharedDemo() {
    await createDevGoogleSession({
      email: SHARED_DEMO_EMAIL,
      display_name: SHARED_DEMO_ORG,
      mode: "signup",
      account_type: "business",
      org_name: SHARED_DEMO_ORG,
      plan_tier: "free",
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
      if (!secret) {
        setMessage(typeof (payload as any).message === "string" ? (payload as any).message : "No SDK API key was revealed.");
        return;
      }
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

  const title = isOnboarding ? "Finish onboarding" : mode === "signin" ? "Sign in to your workspace" : "Create your workspace";
  const clerkEmail = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "";
  const demoSession = isSharedDemoSession(session);

  return (
    <main className="auth-page" aria-busy={busy}>
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">{config.loaded ? providerLabel(config) : "Checking provider"}</p>
        <h1 id="auth-title">{title}</h1>
        <p className="auth-copy">
          {isOnboarding
            ? "Create a scoped SDK key, reserve seats when needed, then open the dashboard."
            : config.managed_clerk_enabled
              ? "Clerk handles sign in. InstantML then creates a scoped workspace session for your org."
              : "Use the same product-shaped flow as hosted auth while local development credentials are not configured."}
        </p>

        {!isOnboarding ? (
          <form className="auth-form" onSubmit={submitAuth}>
            {signupMode ? <SignupFields
              accountType={accountType}
              availability={orgAvailability}
              onAccountType={setAccountType}
              onOrgName={setOrgName}
              onPlanTier={setPlanTier}
              onSeatEmails={setSeatEmails}
              orgName={orgName}
              planTier={planTier}
              seatEmails={seatEmails}
            /> : null}
            {config.managed_clerk_enabled ? (
              <div className="clerk-auth-stack">
                <Show when="signed-out">
                  <div className="clerk-actions">
                    <SignInButton mode="modal">
                      <button className="secondary" disabled={!managedClerkReady || busy} type="button">Sign in</button>
                    </SignInButton>
                    <SignUpButton mode="modal">
                      <button className="primary-button" disabled={!managedClerkReady || busy || orgUnavailable} type="button">
                        <ShieldCheck size={15} /> Sign up with Clerk <ArrowRight size={15} />
                      </button>
                    </SignUpButton>
                  </div>
                </Show>
                <Show when="signed-in">
                  <div className="onboarding-summary">
                    <UserButton />
                    <div>
                      <strong>{user?.fullName || clerkEmail || "Clerk account"}</strong>
                      <span>{clerkEmail || "Signed in with Clerk"}</span>
                    </div>
                  </div>
                  <button className="primary-button" disabled={busy || orgUnavailable} onClick={createManagedClerkSession} type="button">
                    <ShieldCheck size={15} /> {signupMode ? "Create InstantML workspace" : "Continue to dashboard"} <ArrowRight size={15} />
                  </button>
                </Show>
              </div>
            ) : null}
            {config.dev_auth_enabled ? (
              <>
                {config.managed_clerk_enabled ? <div className="auth-form-divider" aria-hidden="true"><span /></div> : null}
                <button className="shared-demo-button" disabled={busy} onClick={submitSharedDemo} type="button">
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
                {!signupMode ? (
                  <label>
                    Organization
                    <input value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder="Personal Workspace" />
                  </label>
                ) : null}
                <button className="primary-button" disabled={busy || orgUnavailable} type="submit">
                  <UserPlus size={15} /> Continue with Dev Google <ArrowRight size={15} />
                </button>
              </>
            ) : null}
          </form>
        ) : (
          <div className="onboarding-stack">
            <div className="onboarding-summary">
              <CheckCircle2 size={16} />
              <div>
                <strong>{session?.organization?.name ?? "Workspace ready"}</strong>
                <span>{session?.user?.primary_email ?? "Signed in"} · {session?.membership?.role ?? "owner"} · {planLabel(session?.organization?.plan_tier)}</span>
              </div>
            </div>
            {demoSession ? (
              <div className="api-key-reveal" role="status" aria-live="polite">
                <strong>Read-only demo</strong>
                <span>The shared demo does not reveal SDK keys. Use it for browsing sample data, not ingestion.</span>
              </div>
            ) : (
              <button className="primary-button" disabled={busy || !session?.organization?.id} onClick={createKey} type="button">
                <KeyRound size={15} /> Create SDK API key
              </button>
            )}
            {apiKey ? (
              <div className="api-key-reveal" role="status" aria-live="polite">
                <strong>Copy-once API key</strong>
                <code>{apiKey}</code>
                <button className="secondary" onClick={copyKey} type="button"><Copy size={14} /> {copied ? "Copied" : "Copy key"}</button>
              </div>
            ) : null}
            {!demoSession ? <pre className="sdk-snippet">export INSTANTML_API_KEY={apiKey || "instantml_..."}
python train.py</pre>
              : null}
            <a className="button-link" href={apiKey ? nextPath : "/dashboard/runs"}>Open dashboard <ArrowRight size={15} /></a>
          </div>
        )}

        <p className="auth-status" role="status" aria-live="polite">{message}</p>
      </section>
    </main>
  );
}

function SignupFields({
  accountType,
  availability,
  onAccountType,
  onOrgName,
  onPlanTier,
  onSeatEmails,
  orgName,
  planTier,
  seatEmails,
}: {
  accountType: string;
  availability: OrgAvailability;
  onAccountType: (value: string) => void;
  onOrgName: (value: string) => void;
  onPlanTier: (value: PlanTier) => void;
  onSeatEmails: (value: string) => void;
  orgName: string;
  planTier: PlanTier;
  seatEmails: string;
}) {
  return (
    <>
      <fieldset className="plan-picker">
        <legend>Plan</legend>
        {PLAN_OPTIONS.map((plan) => {
          const Icon = plan.icon;
          return (
            <label className={planTier === plan.id ? "selected" : ""} key={plan.id}>
              <input checked={planTier === plan.id} name="plan-tier" onChange={() => onPlanTier(plan.id)} type="radio" />
              <span className="plan-picker-head"><Icon size={15} /> {plan.label}</span>
              <strong>{plan.price}<small>/mo</small></strong>
              <span><Users size={13} /> {plan.seats}</span>
              <span><HardDrive size={13} /> {plan.storage}</span>
            </label>
          );
        })}
      </fieldset>
      <fieldset className="segmented-field">
        <legend>Account type</legend>
        <label><input checked={accountType === "customer"} name="account-type" onChange={() => onAccountType("customer")} type="radio" /> Customer</label>
        <label><input checked={accountType === "business"} name="account-type" onChange={() => onAccountType("business")} type="radio" /> Business</label>
      </fieldset>
      <label>
        Organization
        <input required value={orgName} onChange={(event) => onOrgName(event.target.value)} placeholder={accountType === "business" ? "Acme Research" : "Personal Workspace"} />
        {availability.message ? (
          <small className={availability.available ? "availability-ok" : "availability-error"}>{availability.message}</small>
        ) : null}
      </label>
      {accountType === "business" ? (
        <label>
          Reserved seats
          <textarea value={seatEmails} onChange={(event) => onSeatEmails(event.target.value)} placeholder="teammate@example.com" rows={3} />
          <small>No invitations are sent yet; this only reserves org seats.</small>
        </label>
      ) : null}
    </>
  );
}

function providerLabel(config: AuthConfig) {
  if (config.dev_auth_enabled) return "Local dev Google-style auth";
  if (config.managed_clerk_enabled) return "Managed Clerk auth";
  return "No provider configured";
}

function planLabel(value?: string) {
  return PLAN_OPTIONS.find((plan) => plan.id === value)?.label ?? "Free";
}

function isSharedDemoSession(session: SessionPayload | null) {
  return session?.user?.primary_email === SHARED_DEMO_EMAIL
    || session?.organization?.name === SHARED_DEMO_ORG
    || session?.organization?.slug === "instantml-demo";
}
