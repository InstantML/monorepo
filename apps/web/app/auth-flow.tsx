"use client";

import { Show, SignInButton, SignUpButton, UserButton, useAuth, useUser } from "@clerk/nextjs";
import { AlertCircle, ArrowRight, CheckCircle2, Copy, Crown, HardDrive, KeyRound, Rocket, ShieldCheck, UserPlus, Users } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ApiClient } from "../src/api.js";
import { sanitizeNextPath } from "../src/routes.js";
import { deriveClerkSlug } from "../src/workspace.js";
import { InstantMlMark } from "./instantml-mark";

type AuthMode = "signin" | "signup" | "onboarding";
type PlanTier = "free" | "pro" | "premium";
type SessionPayload = {
  authenticated?: boolean;
  organization?: { id: string; name: string; slug: string; account_type?: string; plan_tier?: string; seat_limit?: number };
  user?: { primary_email: string; display_name?: string | null };
  membership?: { role: string; status: string };
  onboarding_api_key?: { plaintext: string; prefix: string; id: string } | null;
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

function Brand() {
  return (
    <div className="iml-brand">
      <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
      InstantML
    </div>
  );
}

export function AuthFlow({ mode }: { mode: AuthMode }) {
  const api = useMemo(() => new ApiClient(), []);
  const clerkExchangeAttemptedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { getToken, isLoaded: clerkLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [config, setConfig] = useState<AuthConfig>({ dev_auth_enabled: false, managed_clerk_enabled: false, loaded: false });
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [accountType, setAccountType] = useState("customer");
  const [planTier, setPlanTier] = useState<PlanTier>("free");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  // orgNameOverride: non-empty string means the user has manually overridden the auto-derived name.
  const [orgNameOverride, setOrgNameOverride] = useState("");
  const [seatEmails, setSeatEmails] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("Checking provider availability...");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [orgAvailability, setOrgAvailability] = useState<OrgAvailability>({});
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const nextPath = typeof window === "undefined" ? "/dashboard/runs" : sanitizeNextPath(new URLSearchParams(window.location.search).get("next"));
  const signupMode = mode === "signup";
  // Route-based onboarding, plus the in-place post-signup reveal: after a
  // managed Clerk sign-up exchange we replaceState to /onboarding WITHOUT a
  // reload (to preserve the copy-once key in memory), so signup+authenticated
  // must also render the onboarding view. Sign-in stays route-only so a
  // returning signed-in visitor is still redirected to the app, not onboarding.
  const isOnboarding = mode === "onboarding" || (signupMode && Boolean(session?.authenticated));

  // For managed Clerk signups the server auto-derives the workspace slug from
  // the Clerk profile; mirror it for a live preview + optional override.
  const clerkDisplayName = user?.fullName ?? "";
  const clerkEmail = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "";
  const autoSlug = useMemo(() => deriveClerkSlug(clerkDisplayName, clerkEmail), [clerkDisplayName, clerkEmail]);
  const managedClerkSignup = config.managed_clerk_enabled && signupMode;
  const effectiveOrgName = managedClerkSignup ? (orgNameOverride.trim() || autoSlug) : orgName;
  const orgNameRequired = signupMode && !managedClerkSignup;
  const orgUnavailable = orgNameRequired && (!orgName.trim() || orgAvailability.available === false);
  const managedClerkReady = config.managed_clerk_enabled && clerkLoaded;
  const demoSession = isSharedDemoSession(session);

  function note(text: string) {
    setIsError(false);
    setMessage(text);
  }
  function fail(text: string) {
    setIsError(true);
    setMessage(text);
  }

  // Load provider config + session with a bounded retry. A transient backend
  // hiccup (e.g. Cloud Run cold start) must NOT make the page falsely claim
  // "no provider configured" — that state is only shown when config genuinely
  // returns both providers disabled. On repeated failure we surface a Retry.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function fetchConfigWithRetry() {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await api.get("/api/auth/config", { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted || attempt >= 2) throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
    }

    (async () => {
      setLoadFailed(false);
      try {
        const configPayload = await fetchConfigWithRetry();
        if (cancelled) return;
        const sessionPayload = await api.get("/api/auth/session", { signal: controller.signal }).catch(() => ({ authenticated: false }));
        if (cancelled) return;
        setConfig({
          dev_auth_enabled: Boolean((configPayload as any).dev_auth_enabled),
          managed_clerk_enabled: Boolean((configPayload as any).managed_clerk_enabled),
          loaded: true,
        });
        const authed = Boolean((sessionPayload as SessionPayload).authenticated);
        if (authed && mode !== "onboarding" && !clerkExchangeAttemptedRef.current && !busy) {
          // Returning, already-signed-in visitor: go straight to the app
          // instead of stranding them on the sign-in/up screen. Guarded so it
          // can never race / pre-empt an in-flight Clerk exchange (which owns
          // its own redirect, e.g. sign-up -> /onboarding).
          window.location.assign(nextPath);
          return;
        }
        if (authed) {
          setSession(sessionPayload as SessionPayload);
          note("Workspace ready. Create your SDK key to finish onboarding.");
        } else {
          note((configPayload as any).managed_clerk_enabled
            ? "Sign in with Clerk to access your workspace."
            : "Use the local development flow to continue.");
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setLoadFailed(true);
        fail("Couldn’t reach InstantML. Check your connection and retry.");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, reloadKey]);

  useEffect(() => {
    // For managed Clerk signups: only check availability when the user has explicitly overridden
    // the auto-derived name (the server handles collision fallback for the auto-derived path).
    const nameToCheck = managedClerkSignup ? orgNameOverride.trim() : orgName.trim();
    if (!signupMode || !nameToCheck) {
      setOrgAvailability({});
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setOrgAvailability({ message: "Checking organization name..." });
      api.get(`/api/orgs/name-availability?name=${encodeURIComponent(nameToCheck)}`, { signal: controller.signal })
        .then((payload) => setOrgAvailability(payload as OrgAvailability))
        .catch((error) => {
          if (error?.name !== "AbortError") setOrgAvailability({ available: false, message: "Unable to check this organization name." });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, orgName, orgNameOverride, managedClerkSignup, signupMode]);

  // Auto-exchange the verified Clerk session for a scoped InstantML session so
  // there is no second "continue" click. Sign-up only exchanges once an
  // available org name exists; the attempt ref is reset on every early-out so
  // a later valid submit is never silently suppressed.
  useEffect(() => {
    if (!managedClerkReady || !isSignedIn || isOnboarding || clerkExchangeAttemptedRef.current) return;
    if (signupMode && (!orgName.trim() || orgAvailability.available !== true)) {
      // Only auto-create the workspace once the org name is *confirmed*
      // available — `available` is briefly undefined while the debounced
      // check is in flight, so guarding on `!== true` (not `=== false`)
      // prevents creating an org with an unvalidated/duplicate name.
      note("Signed in with Clerk. Choose an available organization name to create your workspace.");
      return;
    }
    clerkExchangeAttemptedRef.current = true;
    void createManagedClerkSession();
  }, [isOnboarding, isSignedIn, managedClerkReady, signupMode, orgName, orgAvailability.available]);

  // Move focus to the page heading on first paint and on each major view
  // change (busy, key revealed, error) so keyboard/SR users land in context.
  const viewKey = `${mode}|${apiKey ? "key" : ""}|${isError ? "err" : ""}|${busy ? "busy" : ""}`;
  useEffect(() => {
    const id = window.setTimeout(() => headingRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [viewKey]);

  async function createDevGoogleSession(payload: DevGoogleAuthPayload) {
    setBusy(true);
    note("Creating your workspace session...");
    try {
      const sessionPayload = await api.post("/api/auth/dev/google", payload);
      setSession(sessionPayload as SessionPayload);
      if (isSharedDemoSession(sessionPayload as SessionPayload)) {
        note("Signed in to the read-only demo. Opening the dashboard...");
        window.location.assign("/dashboard/runs");
        return;
      }
      if (payload.mode === "signin") {
        note("Signed in. Opening your dashboard...");
        window.location.assign(nextPath);
      } else {
        note("Workspace created. Opening onboarding...");
        window.location.assign("/onboarding");
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function createManagedClerkSession() {
    if (signupMode && orgUnavailable) {
      clerkExchangeAttemptedRef.current = false;
      fail("Choose an available organization name before continuing.");
      return;
    }
    setBusy(true);
    note(signupMode ? "Creating your hosted workspace..." : "Signing in...");
    try {
      const token = await getToken();
      if (!token) throw new Error("Clerk did not return a session token.");
      // For managed Clerk signups: send org_name only when the user has explicitly overridden
      // the auto-derived name. When absent, the server auto-derives from the Clerk profile.
      const explicitOrgName = managedClerkSignup
        ? (orgNameOverride.trim() || undefined)
        : (signupMode ? orgName.trim() : undefined);
      const payload = await api.post("/api/auth/clerk", {
        token,
        mode: signupMode ? "signup" : "signin",
        account_type: managedClerkSignup ? undefined : accountType,
        org_name: explicitOrgName,
        plan_tier: signupMode ? planTier : undefined,
        seat_emails: signupMode && accountType === "business"
          ? seatEmails.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
          : [],
      }) as SessionPayload;
      setSession(payload);
      // If the server auto-issued an onboarding key, reveal it immediately
      // in-place (no reload — keeps the copy-once plaintext in memory).
      const onboardingKey = payload.onboarding_api_key?.plaintext;
      if (onboardingKey) {
        setApiKey(onboardingKey);
        note("Workspace created. Save your API key before opening the dashboard.");
        window.history.replaceState(null, "", "/onboarding");
      } else {
        note(signupMode ? "Workspace created. Opening onboarding..." : "Signed in. Opening your dashboard...");
        window.location.assign(signupMode ? "/onboarding" : nextPath);
      }
    } catch (error) {
      clerkExchangeAttemptedRef.current = false;
      fail(error instanceof Error ? error.message : "Unable to sign in with Clerk.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (orgUnavailable) {
      fail("Choose an available organization name before continuing.");
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
      plan_tier: "premium",
    });
  }

  async function createKey() {
    if (!session?.organization?.id) return;
    setBusy(true);
    setCopied(false);
    note("Creating a copy-once SDK API key...");
    try {
      const payload = await api.post(`/api/orgs/${session.organization.id}/api-keys`, {
        name: "Onboarding SDK key",
      });
      const secret = typeof (payload as any).api_key === "string" ? (payload as any).api_key : "";
      if (!secret) {
        fail(typeof (payload as any).message === "string" ? (payload as any).message : "No SDK API key was revealed.");
        return;
      }
      setApiKey(secret);
      note("API key created. Save it before opening the dashboard.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Unable to create API key.");
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      note("API key copied to the clipboard. Save it before opening the dashboard.");
    } catch {
      fail("Couldn’t copy automatically — select the key above and copy it manually.");
    }
  }

  const eyebrow = config.loaded ? providerLabel(config) : "Checking provider";
  const seatCount = seatEmails.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).length;
  const seatLimit = session?.organization?.seat_limit ?? (accountType === "business" ? 3 : 1);

  const headline = isOnboarding
    ? (apiKey ? <>Save it, then <span className="iml-em">go.</span></> : <>Create your <span className="iml-em">SDK key</span></>)
    : signupMode
      ? <>Set up your <span className="iml-em">{accountType === "business" ? "team org" : "org"}</span></>
      : <>Sign in to your <span className="iml-em">workspace</span></>;

  const statusRole = isError ? "alert" : "status";
  const statusClass = isError ? "iml-status is-err" : busy ? "iml-status is-busy" : "iml-status";

  return (
    <div className="iml-auth">
      <header className="iml-bar">
        <Brand />
        <div className="iml-bar-actions">
          {!isOnboarding ? (
            <a className="iml-btn iml-btn--ghost" href={signupMode ? "/signin" : "/signup"}>
              {signupMode ? "Sign in" : "Create workspace"}
            </a>
          ) : null}
        </div>
      </header>

      <main className="iml-stage">
        <section
          className={isOnboarding || managedClerkReady ? "iml-card" : "iml-card iml-card--single"}
          aria-busy={busy}
          aria-labelledby="iml-auth-title"
        >
          {isOnboarding ? (
            <OnboardingAside session={session} keyDone={Boolean(apiKey)} demo={demoSession} />
          ) : managedClerkReady ? (
            signupMode ? <SignupAside accountType={accountType} /> : <SigninAside />
          ) : null}

          <div className="iml-main">
            <div className="iml-head">
              <p className={`iml-eyebrow${isError ? " is-danger" : isOnboarding ? " is-accent" : ""}`}>
                {isError ? "Something went wrong" : eyebrow}
              </p>
              <h1 className="iml-headline" id="iml-auth-title" ref={headingRef} tabIndex={-1}>{headline}</h1>
              <p className="iml-sub">
                {isOnboarding
                  ? (demoSession
                    ? "The shared demo signs you into sample data — read-only, no SDK key. Look around, then sign up for a real workspace."
                    : apiKey
                      ? "This is the only time the plaintext key is shown. Put it in your environment and you’re logging."
                      : <>A scoped, copy-once key for <code>sdk:ingest</code>, <code>artifacts:write</code>, and <code>export:read</code>. We never store the plaintext.</>)
                  : signupMode
                    ? "Name your workspace — Clerk verifies you next, then the workspace is created in one pass."
                    : "One step: Clerk verifies your identity, then InstantML opens the scoped session for your org."}
              </p>
            </div>

            {loadFailed ? (
              <div className="iml-actions">
                <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" type="button" onClick={() => setReloadKey((k) => k + 1)}>
                  Retry connection
                </button>
              </div>
            ) : isOnboarding ? (
              <OnboardingBody
                session={session}
                demo={demoSession}
                apiKey={apiKey}
                copied={copied}
                busy={busy}
                nextPath={nextPath}
                onCreateKey={createKey}
                onCopy={copyKey}
              />
            ) : (
              <>
                {signupMode && managedClerkSignup ? (
                  <WorkspacePreview
                    autoSlug={autoSlug}
                    availability={orgAvailability}
                    effectiveName={effectiveOrgName}
                    override={orgNameOverride}
                    onOverride={setOrgNameOverride}
                  />
                ) : signupMode && config.dev_auth_enabled ? (
                  <SignupFields
                    accountType={accountType}
                    availability={orgAvailability}
                    orgName={orgName}
                    seatEmails={seatEmails}
                    seatCount={seatCount}
                    seatLimit={seatLimit}
                    planTier={planTier}
                    onAccountType={setAccountType}
                    onOrgName={setOrgName}
                    onPlanTier={setPlanTier}
                    onSeatEmails={setSeatEmails}
                  />
                ) : null}

                {managedClerkReady ? (
                  <div className="iml-actions">
                    <Show when="signed-out">
                      {signupMode ? (
                        <SignUpButton mode="modal">
                          <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy || orgUnavailable} type="button">
                            <ShieldCheck size={16} /> Continue with Clerk <ArrowRight className="iml-arrow" size={15} />
                          </button>
                        </SignUpButton>
                      ) : (
                        <SignInButton mode="modal">
                          <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy} type="button">
                            <ShieldCheck size={16} /> Continue with Clerk <ArrowRight className="iml-arrow" size={15} />
                          </button>
                        </SignInButton>
                      )}
                    </Show>
                    <Show when="signed-in">
                      <div className="iml-org">
                        <span className="iml-org-badge"><UserButton /></span>
                        <div className="iml-org-m">
                          <strong>{user?.fullName || clerkEmail || "Clerk account"}</strong>
                          <span>{clerkEmail || "Signed in with Clerk"}</span>
                        </div>
                      </div>
                      <button
                        className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block"
                        disabled={busy || orgUnavailable}
                        onClick={() => { clerkExchangeAttemptedRef.current = true; void createManagedClerkSession(); }}
                        type="button"
                      >
                        {busy ? <span className="iml-spin on-fill" aria-hidden="true" /> : <ShieldCheck size={16} />}
                        {busy ? "Opening your workspace…" : signupMode ? "Create InstantML workspace" : "Continue to dashboard"}
                        {!busy ? <ArrowRight className="iml-arrow" size={15} /> : null}
                      </button>
                    </Show>
                  </div>
                ) : null}

                {config.dev_auth_enabled ? (
                  <form className="iml-actions" onSubmit={submitAuth} aria-label="Local development sign in">
                    {managedClerkReady ? <p className="iml-hint" style={{ textAlign: "center" }}>— or use the local development flow —</p> : null}
                    <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" disabled={busy} onClick={submitSharedDemo} type="button">
                      <UserPlus size={15} /> Continue as shared demo <ArrowRight className="iml-arrow" size={15} />
                    </button>
                    <div className="iml-field">
                      <label htmlFor="iml-email">Email</label>
                      <input className="iml-input" id="iml-email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                    </div>
                    <div className="iml-field">
                      <label htmlFor="iml-name">Name</label>
                      <input className="iml-input" id="iml-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ada Lovelace" />
                    </div>
                    {!signupMode ? (
                      <div className="iml-field">
                        <label htmlFor="iml-org-dev">Organization</label>
                        <input className="iml-input" id="iml-org-dev" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Personal Workspace" />
                      </div>
                    ) : null}
                    <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy || orgUnavailable} type="submit">
                      <UserPlus size={15} /> Continue with Dev Google <ArrowRight className="iml-arrow" size={15} />
                    </button>
                  </form>
                ) : null}

                {!managedClerkReady && !config.dev_auth_enabled && config.loaded ? (
                  <div className="iml-status is-err" role="alert">
                    <AlertCircle size={14} /> No sign-in provider is configured for this environment.
                  </div>
                ) : null}
              </>
            )}

            <p className={statusClass} role={statusRole} aria-live={isError ? "assertive" : "polite"}>
              {isError ? <AlertCircle size={14} aria-hidden="true" /> : busy ? <span className="iml-spin" aria-hidden="true" /> : null}
              {message}
            </p>

            {!isOnboarding ? (
              <p className="iml-foot">
                {signupMode ? "Already have a workspace?" : "New to InstantML?"}
                <a href={signupMode ? "/signin" : "/signup"}>{signupMode ? "Sign in" : "Create a workspace"}</a>
              </p>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

function SignupAside({ accountType }: { accountType: string }) {
  return (
    <aside className="iml-aside">
      <div className="iml-aside-brand">
        <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
        <span className="iml-aside-name">InstantML</span>
      </div>
      <p className="iml-aside-tag">
        {accountType === "business"
          ? <>A workspace your whole team can <span className="iml-em">trust.</span></>
          : <>The training tool you keep <span className="iml-em">open all day.</span></>}
      </p>
      <ol className="iml-steps" aria-label="Sign-up steps">
        <li className="iml-step is-active"><span className="idx" aria-hidden="true">01</span><div><div className="st-t">Name your workspace</div><div className="st-s">Account type + org</div></div></li>
        <li className="iml-step"><span className="idx" aria-hidden="true">02</span><div><div className="st-t">Verify with Clerk</div><div className="st-s">Google / email</div></div></li>
        <li className="iml-step"><span className="idx" aria-hidden="true">03</span><div><div className="st-t">Create an SDK key</div><div className="st-s">Start logging</div></div></li>
      </ol>
    </aside>
  );
}

function SigninAside() {
  return (
    <aside className="iml-aside">
      <div className="iml-aside-brand">
        <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
        <span className="iml-aside-name">InstantML</span>
      </div>
      <p className="iml-aside-tag">Pick up exactly where your <span className="iml-em">last run</span> left off.</p>
      <div className="iml-proof" aria-hidden="true">
        <div className="iml-proof-h"><span className="iml-dot is-running" /> Recent runs</div>
        <div className="iml-proof-r"><span className="nm">rl-ppo-seed-44</span><span className="sc">0.91</span></div>
        <div className="iml-proof-r"><span className="nm">llm-ft-seed-21</span><span className="sc dim">0.87</span></div>
        <div className="iml-proof-r"><span className="nm">reward-ablation-13</span><span className="sc dim">0.82</span></div>
      </div>
    </aside>
  );
}

function OnboardingAside({ session, keyDone, demo }: { session: SessionPayload | null; keyDone: boolean; demo: boolean }) {
  if (demo) {
    return (
      <aside className="iml-aside">
        <div className="iml-aside-brand">
          <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
          <span className="iml-aside-name">InstantML</span>
        </div>
        <p className="iml-aside-tag">A quick look at the <span className="iml-em">real thing.</span></p>
        <div className="iml-proof" aria-hidden="true">
          <div className="iml-proof-h"><span className="iml-dot is-running" /> Sample runs</div>
          <div className="iml-proof-r"><span className="nm">rl-ppo-seed-44</span><span className="sc">0.91</span></div>
          <div className="iml-proof-r"><span className="nm">llm-ft-seed-21</span><span className="sc dim">0.87</span></div>
          <div className="iml-proof-r"><span className="nm">reward-ablation-13</span><span className="sc dim">0.82</span></div>
        </div>
      </aside>
    );
  }
  return (
    <aside className="iml-aside">
      <div className="iml-aside-brand">
        <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
        <span className="iml-aside-name">InstantML</span>
      </div>
      <p className="iml-aside-tag">You’re <span className="iml-em">almost</span> logging.</p>
      <ol className="iml-steps" aria-label="Onboarding steps">
        <li className="iml-step is-done"><span className="idx" aria-hidden="true">✓</span><div><div className="st-t">Workspace created</div><div className="st-s">{session?.organization?.name ?? "Your org"} · {planLabel(session?.organization?.plan_tier)} plan</div></div></li>
        <li className="iml-step is-done"><span className="idx" aria-hidden="true">✓</span><div><div className="st-t">Identity verified</div><div className="st-s">via Clerk</div></div></li>
        <li className={`iml-step ${keyDone ? "is-done" : "is-active"}`}><span className="idx" aria-hidden="true">{keyDone ? "✓" : "03"}</span><div><div className="st-t">{keyDone ? "SDK key created" : "Create an SDK key"}</div><div className="st-s">{keyDone ? "Copy it now" : "Then open the dashboard"}</div></div></li>
      </ol>
    </aside>
  );
}

function OnboardingBody({
  session, demo, apiKey, copied, busy, nextPath, onCreateKey, onCopy,
}: {
  session: SessionPayload | null;
  demo: boolean;
  apiKey: string;
  copied: boolean;
  busy: boolean;
  nextPath: string;
  onCreateKey: () => void;
  onCopy: () => void;
}) {
  return (
    <>
      <div className="iml-org">
        <span className="iml-org-badge">
          {demo ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
        </span>
        <div className="iml-org-m">
          <strong>{session?.organization?.name ?? "Workspace ready"}</strong>
          <span>{session?.user?.primary_email ?? "Signed in"} · {demo ? "read-only" : (session?.membership?.role ?? "owner")}{demo ? null : ` · ${planLabel(session?.organization?.plan_tier)} plan`}</span>
        </div>
      </div>

      {demo ? (
        <div className="iml-actions">
          <a className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" href="/dashboard/runs">
            Open the demo dashboard <ArrowRight className="iml-arrow" size={15} />
          </a>
          <a className="iml-btn iml-btn--ghost iml-btn--block" href="/signup">Create a real workspace instead</a>
        </div>
      ) : !apiKey ? (
        <div className="iml-actions">
          <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy || !session?.organization?.id} onClick={onCreateKey} type="button">
            {busy ? <span className="iml-spin on-fill" aria-hidden="true" /> : <KeyRound size={16} />}
            {busy ? "Creating key…" : "Create SDK API key"}
          </button>
        </div>
      ) : (
        <>
          <div className="iml-term">
            <div className="iml-term-bar">
              <span className="tl">instantml · sdk key</span>
              <span className="sp" />
              <button className="iml-copy" onClick={onCopy} type="button">
                <Copy size={12} /> {copied ? "Copied" : "Copy key"}
              </button>
            </div>
            <div className="iml-term-body">
              <span className="ln"><span className="cm"># copy-once — store it in your secret manager</span></span>
              <span className="ln"><code className="key">{apiKey}</code></span>
            </div>
          </div>
          <div className="iml-term">
            <div className="iml-term-bar"><span className="tl">your machine</span><span className="sp" /></div>
            <div className="iml-term-body">
              <span className="ln"><span className="pr">$ </span>export INSTANTML_API_KEY=<span className="key">{apiKey}</span></span>
              <span className="ln"><span className="pr">$ </span>python train.py</span>
            </div>
          </div>
          <div className="iml-actions">
            <a className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" href={nextPath}>
              Open dashboard <ArrowRight className="iml-arrow" size={15} />
            </a>
          </div>
        </>
      )}
    </>
  );
}

function WorkspacePreview({
  autoSlug, availability, effectiveName, override, onOverride,
}: {
  autoSlug: string;
  availability: OrgAvailability;
  effectiveName: string;
  override: string;
  onOverride: (value: string) => void;
}) {
  return (
    <div className="iml-field">
      <span className="iml-legend">Your workspace</span>
      <div className="iml-wsprev">
        <span className="iml-wsprev-host">instantml.ai/</span>
        <strong className="iml-wsprev-slug">{effectiveName || autoSlug || "workspace"}</strong>
      </div>
      <details className="iml-wsprev-adv">
        <summary>Use a different name</summary>
        <input
          className="iml-input"
          id="iml-ws-override"
          value={override}
          onChange={(e) => onOverride(e.target.value)}
          placeholder={autoSlug}
          aria-label="Override workspace name"
          aria-describedby={availability.message ? "iml-ws-avail" : undefined}
        />
        {availability.message ? (
          <span id="iml-ws-avail" className={`iml-hint ${availability.available ? "is-ok" : availability.available === false ? "is-err" : ""}`}>
            {availability.available ? "✓ " : ""}{availability.message}
          </span>
        ) : null}
      </details>
    </div>
  );
}

function SignupFields({
  accountType, availability, orgName, seatEmails, seatCount, seatLimit, planTier,
  onAccountType, onOrgName, onPlanTier, onSeatEmails,
}: {
  accountType: string;
  availability: OrgAvailability;
  orgName: string;
  seatEmails: string;
  seatCount: number;
  seatLimit: number;
  onAccountType: (value: string) => void;
  onOrgName: (value: string) => void;
  onPlanTier: (value: PlanTier) => void;
  onSeatEmails: (value: string) => void;
  planTier: PlanTier;
}) {
  const overLimit = seatCount > Math.max(0, seatLimit - 1);
  return (
    <>
      <fieldset className="iml-field iml-fieldset">
        <legend className="iml-legend">Plan</legend>
        <div className="iml-plans">
          {PLAN_OPTIONS.map((plan) => {
            const Icon = plan.icon;
            return (
              <label className="iml-plan" key={plan.id}>
                <input checked={planTier === plan.id} name="iml-plan-tier" onChange={() => onPlanTier(plan.id)} type="radio" />
                <span className="iml-plan-h"><Icon size={15} aria-hidden="true" /> {plan.label}</span>
                <strong className="iml-plan-p">{plan.price}<small>/mo</small></strong>
                <span className="iml-plan-m"><Users size={12} aria-hidden="true" /> {plan.seats}</span>
                <span className="iml-plan-m"><HardDrive size={12} aria-hidden="true" /> {plan.storage}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="iml-field iml-fieldset">
        <legend className="iml-legend">Account type</legend>
        <div className="iml-seg">
          <label className="iml-seg-opt">
            <input checked={accountType === "customer"} name="iml-account-type" onChange={() => onAccountType("customer")} type="radio" />
            <span className="iml-seg-t"><span className="iml-tick" aria-hidden="true">✓</span> Customer</span>
            <span className="iml-seg-d">Personal workspace · 1 seat</span>
          </label>
          <label className="iml-seg-opt">
            <input checked={accountType === "business"} name="iml-account-type" onChange={() => onAccountType("business")} type="radio" />
            <span className="iml-seg-t"><span className="iml-tick" aria-hidden="true">✓</span> Business</span>
            <span className="iml-seg-d">Team org · 3 seats, reservable</span>
          </label>
        </div>
      </fieldset>

      <div className="iml-field">
        <label htmlFor="iml-org">Organization <span className="iml-hint">required</span></label>
        <input
          className="iml-input"
          id="iml-org"
          required
          value={orgName}
          onChange={(e) => onOrgName(e.target.value)}
          placeholder={accountType === "business" ? "Acme Research" : "Personal Workspace"}
          aria-describedby={availability.message ? "iml-org-avail" : undefined}
        />
        {availability.message ? (
          <span id="iml-org-avail" className={`iml-hint ${availability.available ? "is-ok" : availability.available === false ? "is-err" : ""}`}>
            {availability.available ? "✓ " : ""}{availability.message}
          </span>
        ) : null}
      </div>

      {accountType === "business" ? (
        <div className="iml-field">
          <label htmlFor="iml-seats">
            Reserved seats
            <span className={`iml-chip ${overLimit ? "" : "is-muted"}`}>{seatCount} / {seatLimit} reserved</span>
          </label>
          <textarea
            className="iml-input"
            id="iml-seats"
            value={seatEmails}
            onChange={(e) => onSeatEmails(e.target.value)}
            placeholder="teammate@example.com"
            rows={3}
            aria-describedby="iml-seats-hint"
          />
          <span id="iml-seats-hint" className={`iml-hint ${overLimit ? "is-err" : ""}`}>
            {overLimit
              ? `Over the ${seatLimit}-seat limit (you take one seat as owner).`
              : "No invitations are sent yet — this only reserves org seats for these emails."}
          </span>
        </div>
      ) : null}
    </>
  );
}

function providerLabel(config: AuthConfig) {
  if (config.managed_clerk_enabled) return "Managed Clerk auth";
  if (config.dev_auth_enabled) return "Local dev Google-style auth";
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
