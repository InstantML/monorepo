"use client";

import { Show, SignInButton, SignUpButton, UserButton, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { AlertCircle, ArrowRight, CheckCircle2, Cloud, Copy, Crown, Database, HardDrive, KeyRound, LogOut, RefreshCw, Rocket, ServerCog, ShieldCheck, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ApiClient, ApiError } from "../src/api.js";
import { clerkIssuerConfigError } from "../src/clerk-config.js";
import { roleLabel } from "../src/roles.js";
import { organizationRequiresStorageOnboarding, postAuthRedirectPath, safeCheckoutRedirectUrl, sanitizeNextPath } from "../src/routes.js";
import { deriveClerkSlug } from "../src/workspace.js";
import { InstantMlMark } from "./instantml-mark";

type AuthMode = "signin" | "signup" | "onboarding";
type PlanTier = "free" | "pro" | "premium";
type StorageChoice = "instantml-hosted" | "customer-clickhouse";
type SessionPayload = {
  authenticated?: boolean;
  organization?: {
    id: string;
    name: string;
    slug: string;
    account_type?: string;
    plan_tier?: string;
    seat_limit?: number;
    storage_choice?: StorageChoice | string;
    storage_state?: string;
  };
  user?: { primary_email: string; display_name?: string | null };
  membership?: { role: string; status: string };
  onboarding_api_key?: { plaintext: string; prefix: string; id: string } | null;
  billing_checkout?: { intent_id?: string; status?: string; session_id?: string | null; url?: string | null } | null;
  // Set by the backend when a signin-mode request just auto-provisioned a
  // brand-new workspace (the first-time-Clerk-signin path). The frontend
  // routes auto-provisioned sessions to the onboarding view even when the
  // original request was `mode="signin"`, so the user lands directly in the
  // SDK-key step instead of the signin card.
  auto_provisioned?: boolean;
};
type DevGoogleAuthPayload = {
  email: string;
  display_name?: string;
  mode?: "signin" | "signup";
  account_type?: string;
  org_name?: string;
  plan_tier?: PlanTier;
  storage_choice?: StorageChoice;
  seat_emails?: string[];
};
type ClickHouseConnectionStatus = {
  status: string;
  storage_choice: string;
  storage_state: string;
  provisioner?: string | null;
  warehouse_kind?: string | null;
  endpoint?: string | null;
  endpoint_host?: string | null;
  database?: string | null;
  username?: string | null;
  required_egress_cidrs?: string[];
  egress_description?: string;
  egress_set_version?: string;
  last_validated_at?: string | null;
  validation_error_code?: string | null;
  message?: string | null;
};
type ClickHouseConnectionValidation = {
  status: string;
  server_version?: string | null;
  current_user?: string | null;
  database: string;
  required_egress_cidrs: string[];
  egress_description: string;
  egress_set_version: string;
  can_migrate_schema: boolean;
  can_insert_validation_record: boolean;
};
type ByocForm = {
  endpoint: string;
  database: string;
  username: string;
  password: string;
};
type OrgAvailability = {
  available?: boolean;
  message?: string;
  slug?: string;
};
type AuthConfig = {
  dev_auth_enabled: boolean;
  managed_clerk_enabled: boolean;
  clerk_jwt_issuer?: string | null;
  clerk_config_error?: string;
  loaded: boolean;
};
type ClerkExchangeOptions = {
  forceFreshToken?: boolean;
};

const SHARED_DEMO_EMAIL = "hello@instantml.ai";
const SHARED_DEMO_ORG = "InstantML Demo";
const STORAGE_HOSTED: StorageChoice = "instantml-hosted";
const STORAGE_BYOC: StorageChoice = "customer-clickhouse";
const CLERK_SESSION_RECOVERY_MESSAGE =
  "InstantML could not refresh your workspace session from this browser sign-in. Try a fresh token, or sign out and sign back in.";
const PLAN_OPTIONS: Array<{
  id: PlanTier;
  label: string;
  price: string;
  storage: string;
  seats: string;
  icon: typeof Rocket;
}> = [
  { id: "free", label: "Free", price: "$0", storage: "2 GiB", seats: "2 seats", icon: Users },
  { id: "pro", label: "Pro", price: "$199", storage: "1 TiB", seats: "3 seats", icon: Rocket },
  { id: "premium", label: "Premium", price: "$699", storage: "5 TiB", seats: "10 seats", icon: Crown },
];

function planTierFromSearchParam(value: string | null): PlanTier | null {
  return value === "free" || value === "pro" || value === "premium" ? value : null;
}

// Stash the freshly issued onboarding key in sessionStorage so the dashboard's
// empty-workspace SDK snippet can offer a "Copy with your key" action without
// re-requesting a copy-once secret. Cleared on tab close; never persisted.
const ONBOARDING_KEY_STORAGE = "instantml_onboarding_key";
function stashOnboardingKey(plaintext: string) {
  if (typeof window === "undefined" || !plaintext) return;
  try {
    window.sessionStorage.setItem(ONBOARDING_KEY_STORAGE, JSON.stringify({
      createdAt: Date.now(),
      plaintext,
    }));
  } catch {
    // sessionStorage can throw in private-mode / quota-exceeded; ignore.
  }
}

function isUnauthorizedError(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

function isMissingClerkSessionToken(error: unknown) {
  return error instanceof Error && error.message.includes("Clerk did not return a session token");
}

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
  const byocValidationRequestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { getToken, isLoaded: clerkLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const { user } = useUser();
  const [config, setConfig] = useState<AuthConfig>({ dev_auth_enabled: false, managed_clerk_enabled: false, loaded: false });
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [accountType, setAccountType] = useState("personal");
  const [planTier, setPlanTier] = useState<PlanTier>("free");
  const [storageChoice, setStorageChoice] = useState<StorageChoice>(STORAGE_HOSTED);
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
  const [showSessionRecovery, setShowSessionRecovery] = useState(false);
  const [byocStatus, setByocStatus] = useState<ClickHouseConnectionStatus | null>(null);
  const [byocValidation, setByocValidation] = useState<ClickHouseConnectionValidation | null>(null);
  const [byocForm, setByocForm] = useState<ByocForm>({
    endpoint: "",
    database: "instantml",
    username: "instantml_writer",
    password: "",
  });
  const nextPath = typeof window === "undefined" ? "/dashboard/runs" : sanitizeNextPath(new URLSearchParams(window.location.search).get("next"));
  const signupMode = mode === "signup";
  // Route-based onboarding, plus the in-place post-signup reveal: after a
  // managed Clerk sign-up exchange we replaceState to /onboarding WITHOUT a
  // reload (to preserve the copy-once key in memory), so signup+authenticated
  // must also render the onboarding view. The third case is the new
  // first-time-signin auto-provision path: when the user lands on /signin but
  // the backend just created their workspace (signaled by
  // session.auto_provisioned), we render the onboarding view too so they get
  // the SDK-key step immediately instead of being stranded on the signin card.
  // A returning signed-in visitor (auto_provisioned=undefined/false) is still
  // redirected to the app, not onboarding.
  const isOnboarding =
    mode === "onboarding"
    || (signupMode && Boolean(session?.authenticated))
    || Boolean(session?.auto_provisioned);

  // For managed Clerk signups the server auto-derives the workspace slug from
  // the Clerk profile; mirror it for a live preview + optional override.
  const clerkDisplayName = user?.fullName ?? "";
  const clerkEmail = user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "";
  const autoSlug = useMemo(() => deriveClerkSlug(clerkDisplayName, clerkEmail), [clerkDisplayName, clerkEmail]);
  const clerkConfigError = config.clerk_config_error || "";
  const managedClerkSignup = config.managed_clerk_enabled && !clerkConfigError && signupMode;
  const effectiveOrgName = managedClerkSignup ? (orgNameOverride.trim() || autoSlug) : orgName;
  const orgNameRequired = signupMode && !managedClerkSignup;
  const orgUnavailable = orgNameRequired && (!orgName.trim() || orgAvailability.available === false);
  const managedClerkReady = config.managed_clerk_enabled && !clerkConfigError && clerkLoaded;
  const demoSession = isSharedDemoSession(session);

  useEffect(() => {
    if (!signupMode || typeof window === "undefined") return;
    const requestedPlan = planTierFromSearchParam(new URLSearchParams(window.location.search).get("plan"));
    if (!requestedPlan) return;
    setPlanTier(requestedPlan);
    if (requestedPlan !== "premium") {
      setStorageChoice((current) => current === STORAGE_BYOC ? STORAGE_HOSTED : current);
    }
  }, [signupMode]);

  function choosePlanTier(next: PlanTier) {
    setPlanTier(next);
    if (next !== "premium" && storageChoice === STORAGE_BYOC) {
      setStorageChoice(STORAGE_HOSTED);
    }
  }

  function chooseStorageChoice(next: StorageChoice) {
    setStorageChoice(next);
    if (next === STORAGE_BYOC) {
      setPlanTier("premium");
    }
  }

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
        const managedClerkEnabled = Boolean((configPayload as any).managed_clerk_enabled);
        const clerkConfig = managedClerkEnabled
          ? clerkIssuerConfigError(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "", (configPayload as any).clerk_jwt_issuer)
          : { message: "", diagnostic: "" };
        if (clerkConfig.diagnostic) console.warn(clerkConfig.diagnostic);
        setConfig({
          dev_auth_enabled: Boolean((configPayload as any).dev_auth_enabled),
          managed_clerk_enabled: managedClerkEnabled,
          clerk_jwt_issuer: typeof (configPayload as any).clerk_jwt_issuer === "string" ? (configPayload as any).clerk_jwt_issuer : null,
          clerk_config_error: clerkConfig.message,
          loaded: true,
        });
        const authed = Boolean((sessionPayload as SessionPayload).authenticated);
        if (authed && mode !== "onboarding" && !clerkExchangeAttemptedRef.current && !busy) {
          // Returning, already-signed-in visitor: go straight to the app
          // instead of stranding them on the sign-in/up screen. Guarded so it
          // can never race / pre-empt an in-flight Clerk exchange (which owns
          // its own redirect, e.g. sign-up -> /onboarding).
          window.location.replace(postAuthRedirectPath(sessionPayload, nextPath));
          return;
        }
        if (authed) {
          setSession(sessionPayload as SessionPayload);
          note(workspaceStorageReady(sessionPayload as SessionPayload)
            ? "Workspace ready. Create your SDK key to finish onboarding."
            : "Finish storage setup to unlock SDK key creation.");
        } else if (clerkConfig.message) {
          note("Sign-in configuration needs attention.");
        } else {
          note(managedClerkEnabled
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
    if (!isOnboarding || demoSession || !session?.organization?.id || !workspaceUsesByoc(session) || workspaceStorageReady(session)) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const payload = await api.get("/api/storage/clickhouse-connections/current", { signal: controller.signal });
        if (cancelled) return;
        const connection = (payload as { connection?: ClickHouseConnectionStatus }).connection ?? null;
        setByocStatus(connection);
        if (connection) {
          setByocForm((current) => ({
            endpoint: current.endpoint || connection.endpoint || "",
            database: current.database || connection.database || "instantml",
            username: current.username || connection.username || "instantml_writer",
            password: current.password,
          }));
        }
      } catch (error) {
        if (!cancelled && (error as { name?: string })?.name !== "AbortError") {
          setByocStatus(null);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    api,
    demoSession,
    isOnboarding,
    session?.organization?.id,
    session?.organization?.storage_choice,
    session?.organization?.storage_state,
  ]);

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
    if (signupMode && managedClerkSignup && orgNameOverride.trim() && orgAvailability.available !== true) {
      note("Signed in with Clerk. Choose an available organization name to create your workspace.");
      return;
    }
    if (signupMode && !managedClerkSignup && (!orgName.trim() || orgAvailability.available !== true)) {
      // Only auto-create the workspace once the org name is *confirmed*
      // available — `available` is briefly undefined while the debounced
      // check is in flight, so guarding on `!== true` (not `=== false`)
      // prevents creating an org with an unvalidated/duplicate name.
      note("Signed in with Clerk. Choose an available organization name to create your workspace.");
      return;
    }
    clerkExchangeAttemptedRef.current = true;
    void createManagedClerkSession();
  }, [isOnboarding, isSignedIn, managedClerkReady, managedClerkSignup, signupMode, orgName, orgNameOverride, orgAvailability.available]);

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
      const checkoutUrl = safeCheckoutRedirectUrl((sessionPayload as SessionPayload).billing_checkout?.url);
      if (checkoutUrl) {
        note("Workspace created. Opening Stripe Checkout...");
        window.location.assign(checkoutUrl);
        return;
      }
      if ((sessionPayload as SessionPayload).billing_checkout?.url) throw new Error("Billing checkout URL was not trusted.");
      if ((sessionPayload as SessionPayload).billing_checkout) {
        note("Workspace created, but checkout could not be opened. Opening billing settings...");
        window.location.assign("/dashboard/settings");
        return;
      }
      if (isSharedDemoSession(sessionPayload as SessionPayload)) {
        note("Signed in to the read-only demo. Opening the dashboard...");
        window.location.replace("/dashboard/runs");
        return;
      }
      if (payload.mode === "signin") {
        // `postAuthRedirectPath` already routes auto-provisioned workspaces
        // to /onboarding via the organization.storage_state check, so the
        // mode==="signin" path no longer needs to special-case auto_provisioned
        // explicitly here. The `auto_provisioned` flag is still used elsewhere
        // (the in-page onboardingView render) for the SDK-key step.
        const destination = postAuthRedirectPath(sessionPayload, nextPath);
        note(destination.startsWith("/onboarding") ? "Signed in. Opening storage setup..." : "Signed in. Opening your dashboard...");
        window.location.replace(destination);
      } else {
        note("Workspace created. Opening onboarding...");
        window.location.replace("/onboarding");
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function exchangeManagedClerkSession(forceFreshToken: boolean) {
    const token = await getToken(forceFreshToken ? { skipCache: true } : undefined);
    if (!token) throw new Error("Clerk did not return a session token.");
    // For managed Clerk signups: send org_name only when the user has explicitly overridden
    // the auto-derived name. When absent, the server auto-derives from the Clerk profile.
    const explicitOrgName = managedClerkSignup
      ? (orgNameOverride.trim() || undefined)
      : (signupMode ? orgName.trim() : undefined);
    return await api.post("/api/auth/clerk", {
      token,
      mode: signupMode ? "signup" : "signin",
      account_type: managedClerkSignup ? undefined : accountType,
      org_name: explicitOrgName,
      plan_tier: signupMode ? planTier : undefined,
      storage_choice: signupMode ? storageChoice : undefined,
      seat_emails: signupMode && accountType === "business"
        ? seatEmails.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
        : [],
    }) as SessionPayload;
  }

  async function createManagedClerkSession(options: ClerkExchangeOptions = {}) {
    if (signupMode && orgUnavailable) {
      clerkExchangeAttemptedRef.current = false;
      fail("Choose an available organization name before continuing.");
      return;
    }
    setBusy(true);
    setShowSessionRecovery(false);
    note(signupMode ? "Creating your hosted workspace..." : "Signing in...");
    try {
      let payload: SessionPayload;
      try {
        payload = await exchangeManagedClerkSession(Boolean(options.forceFreshToken));
      } catch (error) {
        if (options.forceFreshToken || !isUnauthorizedError(error)) throw error;
        note("Refreshing your browser sign-in...");
        payload = await exchangeManagedClerkSession(true);
      }
      setSession(payload);
      const checkoutUrl = safeCheckoutRedirectUrl(payload.billing_checkout?.url);
      if (checkoutUrl) {
        note("Workspace created. Opening Stripe Checkout...");
        window.location.assign(checkoutUrl);
        return;
      }
      if (payload.billing_checkout?.url) throw new Error("Billing checkout URL was not trusted.");
      if (payload.billing_checkout) {
        note("Workspace created, but checkout could not be opened. Opening billing settings...");
        window.location.assign("/dashboard/settings");
        return;
      }
      // If the server auto-issued an onboarding key, reveal it immediately
      // in-place (no reload — keeps the copy-once plaintext in memory).
      const onboardingKey = payload.onboarding_api_key?.plaintext;
      // `auto_provisioned` is set when the backend just created the workspace
      // for a first-time user — this matters for the new signin auto-provision
      // path: even when `mode="signin"` was sent, the user should land in the
      // onboarding view (not the dashboard) so they pick up the SDK-key step.
      const onboardingView = signupMode || Boolean(payload.auto_provisioned);
      if (onboardingKey) {
        setApiKey(onboardingKey);
        stashOnboardingKey(onboardingKey);
        note("Workspace created. Save your API key before opening the dashboard.");
        window.history.replaceState(null, "", "/onboarding");
      } else {
        const destination = signupMode ? "/onboarding" : postAuthRedirectPath(payload, nextPath);
        note(destination.startsWith("/onboarding")
          ? "Workspace ready for onboarding. Opening setup..."
          : "Signed in. Opening your dashboard...");
        window.location.replace(destination);
      }
    } catch (error) {
      clerkExchangeAttemptedRef.current = false;
      if (isUnauthorizedError(error) || isMissingClerkSessionToken(error)) {
        setShowSessionRecovery(true);
        fail(CLERK_SESSION_RECOVERY_MESSAGE);
      } else {
        fail(error instanceof Error ? error.message : "Unable to sign in with Clerk.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function restartClerkSignIn() {
    setBusy(true);
    setShowSessionRecovery(false);
    note("Restarting your browser sign-in...");
    try {
      await api.post("/api/auth/logout", {}).catch(() => undefined);
      await clerk.signOut({ redirectUrl: `/signin?next=${encodeURIComponent(nextPath)}` });
    } catch (error) {
      clerkExchangeAttemptedRef.current = false;
      setShowSessionRecovery(true);
      fail(error instanceof Error ? error.message : "Unable to restart sign-in. Use the account menu to sign out, then sign in again.");
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
      storage_choice: signupMode ? storageChoice : undefined,
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
      storage_choice: STORAGE_HOSTED,
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
      stashOnboardingKey(secret);
      note("API key created. Save it before opening the dashboard.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Unable to create API key.");
    } finally {
      setBusy(false);
    }
  }

  function updateByocField(field: keyof ByocForm, value: string) {
    setByocForm((current) => ({ ...current, [field]: value }));
    setByocValidation(null);
  }

  function byocPayload() {
    if (!session?.organization?.id) return null;
    return {
      org_id: session.organization.id,
      endpoint: byocForm.endpoint.trim(),
      database: byocForm.database.trim(),
      username: byocForm.username.trim(),
      password: byocForm.password,
      storage_choice: STORAGE_BYOC,
      allow_create_database: false,
    };
  }

  function byocPayloadSignature(payload: ReturnType<typeof byocPayload>) {
    if (!payload) return "";
    return JSON.stringify([
      payload.org_id,
      payload.endpoint,
      payload.database,
      payload.username,
      payload.password,
      payload.storage_choice,
    ]);
  }

  async function validateByocConnection() {
    const payload = byocPayload();
    if (!payload) return;
    const requestId = byocValidationRequestRef.current + 1;
    byocValidationRequestRef.current = requestId;
    const requestSignature = byocPayloadSignature(payload);
    setBusy(true);
    note("Validating ClickHouse from the data plane...");
    try {
      const response = await api.post("/api/storage/clickhouse-connections/validate", payload);
      if (requestId !== byocValidationRequestRef.current || requestSignature !== byocPayloadSignature(byocPayload())) return;
      const validation = (response as { validation?: ClickHouseConnectionValidation }).validation ?? null;
      setByocValidation(validation);
      if (validation) {
        note("ClickHouse validated. Save the connection to unlock SDK key creation.");
      } else {
        fail("ClickHouse validation returned an unexpected response.");
      }
    } catch (error) {
      if (requestId === byocValidationRequestRef.current) {
        setByocValidation(null);
        fail(error instanceof Error ? error.message : "Unable to validate ClickHouse.");
      }
    } finally {
      if (requestId === byocValidationRequestRef.current) setBusy(false);
    }
  }

  async function saveByocConnection() {
    const payload = byocPayload();
    if (!payload) return;
    setBusy(true);
    note("Saving customer-owned ClickHouse connection...");
    try {
      const response = await api.post("/api/storage/clickhouse-connections", payload);
      const connection = (response as { connection?: ClickHouseConnectionStatus }).connection ?? null;
      if (!connection) {
        fail("ClickHouse save returned an unexpected response.");
        return;
      }
      setByocStatus(connection);
      setByocValidation(null);
      setByocForm((current) => ({ ...current, password: "" }));
      setSession((current) => current ? {
        ...current,
        organization: current.organization ? {
          ...current.organization,
          storage_choice: connection.storage_choice || STORAGE_BYOC,
          storage_state: connection.storage_state || "storage_ready",
        } : current.organization,
      } : current);
      note("ClickHouse connected. Create your SDK key to finish onboarding.");
    } catch (error) {
      fail(error instanceof Error ? error.message : "Unable to save ClickHouse connection.");
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
  const storageSetupRequired = isOnboarding && !demoSession && !workspaceStorageReady(session);
  const byocSetupRequired = storageSetupRequired && workspaceUsesByoc(session);

  const headline = isOnboarding
    ? (storageSetupRequired
      ? (byocSetupRequired
        ? <>Connect your <span className="iml-em">ClickHouse</span></>
        : <>Finish <span className="iml-em">storage setup</span></>)
      : apiKey ? <>Save it, then <span className="iml-em">go.</span></> : <>Create your <span className="iml-em">SDK key</span></>)
    : signupMode
      ? <>Set up your <span className="iml-em">{accountType === "business" ? "team org" : "personal workspace"}</span></>
      : <>Sign in to your <span className="iml-em">workspace</span></>;

  const statusRole = isError ? "alert" : "status";
  const statusClass = isError ? "iml-status is-err" : busy ? "iml-status is-busy" : "iml-status";

  // Stable "ready" gate covers both the /api/auth/config fetch and
  // Clerk's React init. Until both land, the action buttons render a
  // single disabled skeleton so the dev-auth form doesn't flash before
  // the Clerk path is available (or vice versa).
  const authReady = config.loaded && (!config.managed_clerk_enabled || Boolean(clerkConfigError) || clerkLoaded);

  return (
    <div className="iml-auth">
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
                    : byocSetupRequired
                      ? "Allowlist the InstantML data-plane egress IPs, connect a pre-created ClickHouse database, then create your SDK key."
                    : storageSetupRequired
                      ? "InstantML is still provisioning your workspace storage. Keep this step open until it is ready, then create your SDK key."
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
                byocStatus={byocStatus}
                byocValidation={byocValidation}
                byocForm={byocForm}
                onByocField={updateByocField}
                onValidateByoc={validateByocConnection}
                onSaveByoc={saveByocConnection}
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
                    planTier={planTier}
                    storageChoice={storageChoice}
                    onOverride={setOrgNameOverride}
                    onPlanTier={choosePlanTier}
                    onStorageChoice={chooseStorageChoice}
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
                    storageChoice={storageChoice}
                    onAccountType={setAccountType}
                    onOrgName={setOrgName}
                    onPlanTier={choosePlanTier}
                    onStorageChoice={chooseStorageChoice}
                    onSeatEmails={setSeatEmails}
                  />
                ) : null}

                {!authReady ? (
                  <div className="iml-actions" aria-live="polite" aria-busy="true">
                    <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled type="button">
                      <span className="iml-spin on-fill" aria-hidden="true" />
                      Loading sign-in…
                    </button>
                  </div>
                ) : null}

                {authReady && managedClerkReady ? (
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
                      <button
                        className="iml-btn iml-btn--ghost iml-btn--block"
                        disabled={busy}
                        onClick={restartClerkSignIn}
                        type="button"
                      >
                        <LogOut size={15} /> Sign out
                      </button>
                      {showSessionRecovery ? (
                        <div className="iml-recovery" role="note" aria-label="Refresh sign-in instructions">
                          <strong>Refresh your sign-in</strong>
                          <span>Clerk still remembers this browser, but InstantML could not create a workspace session from that cached sign-in.</span>
                          <span>Try a fresh token first. If the message returns, sign out and sign in again.</span>
                          <div className="iml-recovery-actions">
                            <button
                              className="iml-btn iml-btn--outline iml-btn--block"
                              disabled={busy}
                              onClick={() => { clerkExchangeAttemptedRef.current = true; void createManagedClerkSession({ forceFreshToken: true }); }}
                              type="button"
                            >
                              <RefreshCw size={15} /> Try fresh token
                            </button>
                            <button className="iml-btn iml-btn--ghost iml-btn--block" disabled={busy} onClick={restartClerkSignIn} type="button">
                              <LogOut size={15} /> Sign out and restart
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </Show>
                  </div>
                ) : null}

                {authReady && config.dev_auth_enabled ? (
                  <form className="iml-actions" onSubmit={submitAuth} aria-label="Local development sign in">
                    {managedClerkReady ? <p className="iml-hint" style={{ textAlign: "center" }}>— or use the local development flow —</p> : null}
                    <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" disabled={busy} onClick={submitSharedDemo} type="button">
                      <UserPlus size={15} /> Continue as shared demo <ArrowRight className="iml-arrow" size={15} />
                    </button>
                    <div className="iml-field">
                      <label htmlFor="iml-email">Email</label>
                      <input aria-label="Email" className="iml-input" id="iml-email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                    </div>
                    <div className="iml-field">
                      <label htmlFor="iml-name">Name</label>
                      <input aria-label="Name" className="iml-input" id="iml-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ada Lovelace" />
                    </div>
                    {!signupMode ? (
                      <div className="iml-field">
                        <label htmlFor="iml-org-dev">Organization</label>
                        <input aria-label="Organization" className="iml-input" id="iml-org-dev" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Personal Workspace" />
                      </div>
                    ) : null}
                    <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy || orgUnavailable} type="submit">
                      <UserPlus size={15} /> Continue with Dev Google <ArrowRight className="iml-arrow" size={15} />
                    </button>
                  </form>
                ) : null}

                {authReady && clerkConfigError && !config.dev_auth_enabled ? (
                  <div className="iml-status is-err" role="alert">
                    <AlertCircle size={14} /> {clerkConfigError}
                  </div>
                ) : null}

                {authReady && !managedClerkReady && !config.dev_auth_enabled && !clerkConfigError ? (
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
                <Link href={signupMode ? "/signin" : "/signup"}>{signupMode ? "Sign in" : "Create a workspace"}</Link>
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
        <li className="iml-step is-active"><span className="idx" aria-hidden="true">01</span><div><div className="st-t">Name your workspace</div><div className="st-s">Personal or org</div></div></li>
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
  const byoc = workspaceUsesByoc(session);
  const storageReady = workspaceStorageReady(session);
  const hostedStoragePending = !byoc && !storageReady;
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
        {byoc ? (
          <li className={`iml-step ${storageReady ? "is-done" : "is-active"}`}><span className="idx" aria-hidden="true">{storageReady ? "✓" : "03"}</span><div><div className="st-t">{storageReady ? "ClickHouse connected" : "Connect ClickHouse"}</div><div className="st-s">{storageReady ? "Customer database ready" : "Validate from data plane"}</div></div></li>
        ) : null}
        {hostedStoragePending ? (
          <li className="iml-step is-active"><span className="idx" aria-hidden="true">03</span><div><div className="st-t">Provision storage</div><div className="st-s">Waiting for tenant route</div></div></li>
        ) : null}
        <li className={`iml-step ${keyDone ? "is-done" : storageReady ? "is-active" : ""}`}><span className="idx" aria-hidden="true">{keyDone ? "✓" : byoc || hostedStoragePending ? "04" : "03"}</span><div><div className="st-t">{keyDone ? "SDK key created" : "Create an SDK key"}</div><div className="st-s">{keyDone ? "Copy it now" : "Then open the dashboard"}</div></div></li>
      </ol>
    </aside>
  );
}

function OnboardingBody({
  session, demo, apiKey, copied, busy, nextPath, byocStatus, byocValidation, byocForm,
  onByocField, onValidateByoc, onSaveByoc, onCreateKey, onCopy,
}: {
  session: SessionPayload | null;
  demo: boolean;
  apiKey: string;
  copied: boolean;
  busy: boolean;
  nextPath: string;
  byocStatus: ClickHouseConnectionStatus | null;
  byocValidation: ClickHouseConnectionValidation | null;
  byocForm: ByocForm;
  onByocField: (field: keyof ByocForm, value: string) => void;
  onValidateByoc: () => void;
  onSaveByoc: () => void;
  onCreateKey: () => void;
  onCopy: () => void;
}) {
  const storageSetupRequired = !workspaceStorageReady(session);
  const byocRequired = workspaceUsesByoc(session) && storageSetupRequired;
  const canManageStorage = canManageWorkspaceStorage(session);
  return (
    <>
      <div className="iml-org">
        <span className="iml-org-badge">
          {demo ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
        </span>
        <div className="iml-org-m">
          <strong>{session?.organization?.name ?? "Workspace ready"}</strong>
          <span>{session?.user?.primary_email ?? "Signed in"} · {demo ? "Read only" : roleLabel(session?.membership?.role ?? "owner")}{demo ? null : ` · ${planLabel(session?.organization?.plan_tier)} plan`}</span>
        </div>
      </div>

      {demo ? (
        <div className="iml-actions">
          <Link className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" href="/dashboard/runs">
            Open the demo dashboard <ArrowRight className="iml-arrow" size={15} />
          </Link>
          <Link className="iml-btn iml-btn--ghost iml-btn--block" href="/signup">Create a real workspace instead</Link>
        </div>
      ) : byocRequired && !canManageStorage ? (
        <StorageSetupBlocked />
      ) : byocRequired ? (
        <ByocSetup
          busy={busy}
          form={byocForm}
          status={byocStatus}
          validation={byocValidation}
          onField={onByocField}
          onValidate={onValidateByoc}
          onSave={onSaveByoc}
        />
      ) : storageSetupRequired ? (
        <StorageSetupPending busy={busy} />
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
          <div className="iml-doc-hint">
            <span>Need the full setup path?</span>
            <Link href="/docs/quickstart">Open Quickstart</Link>
            <span>or paste</span>
            <Link href="/docs/quickstart.md">quickstart.md</Link>
            <span>to your agent.</span>
          </div>
          <div className="iml-actions">
            <Link className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" href={nextPath}>
              Open dashboard <ArrowRight className="iml-arrow" size={15} />
            </Link>
          </div>
        </>
      )}
    </>
  );
}

function StorageSetupPending({ busy }: { busy: boolean }) {
  return (
    <div className="iml-actions">
      <div className="iml-status is-busy" role="status">
        <span className="iml-spin" aria-hidden="true" /> Workspace storage is not ready yet. SDK keys and dashboard access stay locked until provisioning finishes.
      </div>
      <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" disabled={busy} onClick={() => window.location.reload()} type="button">
        <RefreshCw size={15} /> Check again
      </button>
    </div>
  );
}

function StorageSetupBlocked() {
  return (
    <div className="iml-actions">
      <div className="iml-status is-busy" role="status">
        <AlertCircle size={14} aria-hidden="true" /> Storage setup is waiting on a workspace owner or admin. Ask them to connect ClickHouse before opening the dashboard.
      </div>
      <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" onClick={() => window.location.reload()} type="button">
        <RefreshCw size={15} /> Check again
      </button>
    </div>
  );
}

function ByocSetup({
  busy, form, status, validation, onField, onValidate, onSave,
}: {
  busy: boolean;
  form: ByocForm;
  status: ClickHouseConnectionStatus | null;
  validation: ClickHouseConnectionValidation | null;
  onField: (field: keyof ByocForm, value: string) => void;
  onValidate: () => void;
  onSave: () => void;
}) {
  const egress = status?.required_egress_cidrs ?? validation?.required_egress_cidrs ?? [];
  const egressText = egress.join(", ");
  const database = clickhouseIdentifierPreview(form.database, "instantml");
  const username = clickhouseIdentifierPreview(form.username, "instantml_writer");
  const setupSql = [
    `CREATE DATABASE IF NOT EXISTS ${database};`,
    `CREATE USER IF NOT EXISTS ${username} IDENTIFIED WITH sha256_password BY '<copy-once-password>';`,
    `GRANT SHOW, SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER TABLE ON ${database}.* TO ${username};`,
    "",
    "-- Optional after InstantML validates and saves the connection:",
    `-- REVOKE CREATE TABLE, CREATE VIEW, ALTER TABLE ON ${database}.* FROM ${username};`,
  ].join("\n");
  const egressConfigured = egress.length > 0;
  const canSubmit = Boolean(form.endpoint.trim() && form.database.trim() && form.username.trim() && form.password && egressConfigured);
  const copyEgress = () => {
    if (egressText && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(egressText);
    }
  };
  const copySql = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(setupSql);
    }
  };
  return (
    <div className="iml-actions">
      <div className="iml-byoc-callout">
        <div className="iml-byoc-callout-h">
          <ServerCog size={15} aria-hidden="true" /> Recommended GCP ClickHouse setup
        </div>
        <ol className="iml-byoc-steps">
          <li>GCP: run a dedicated self-hosted ClickHouse deployment near the InstantML data-plane region.</li>
          <li>Networking: expose the ClickHouse HTTP interface over HTTPS and allow only the InstantML egress CIDRs shown below.</li>
          <li>SQL console: create the database and writer user with the grants below.</li>
          <li>Paste the HTTPS endpoint origin, database, username, and password here, then validate.</li>
        </ol>
        <p className="iml-hint">Run data goes to your GCP ClickHouse. InstantML storage guardrails count only R2 artifact bytes stored by us.</p>
        <div className="iml-egress">
          <span className="iml-egress-label">Data-plane egress</span>
          {egress.length > 0 ? egress.map((cidr) => <code key={cidr}>{cidr}</code>) : <span>Not configured. BYOC signup is disabled until egress is set.</span>}
          {egress.length > 0 ? (
            <button className="iml-copy" onClick={copyEgress} type="button"><Copy size={12} /> Copy CIDRs</button>
          ) : null}
          {status?.egress_set_version || validation?.egress_set_version ? (
            <span className="iml-egress-version">{status?.egress_set_version || validation?.egress_set_version}</span>
          ) : null}
        </div>
        <div className="iml-byoc-sql">
          <div className="iml-term-bar">
            <span className="tl">clickhouse · setup sql</span>
            <span className="sp" />
            <button className="iml-copy" onClick={copySql} type="button"><Copy size={12} /> Copy SQL</button>
          </div>
          <pre>{setupSql}</pre>
        </div>
      </div>

      <div className="iml-field">
        <label htmlFor="iml-byoc-endpoint">ClickHouse HTTPS endpoint</label>
        <input
          aria-label="ClickHouse HTTPS endpoint"
          className="iml-input"
          id="iml-byoc-endpoint"
          inputMode="url"
          value={form.endpoint}
          onChange={(event) => onField("endpoint", event.target.value)}
          placeholder="https://clickhouse.acme.example.com:8443"
        />
        <span className="iml-hint">Use the public HTTPS ClickHouse HTTP endpoint origin only, without paths or query strings.</span>
      </div>

      <div className="iml-byoc-grid">
        <div className="iml-field">
          <label htmlFor="iml-byoc-db">Database</label>
          <input aria-label="ClickHouse database" className="iml-input" id="iml-byoc-db" value={form.database} onChange={(event) => onField("database", event.target.value)} placeholder="instantml" />
        </div>
        <div className="iml-field">
          <label htmlFor="iml-byoc-user">Username</label>
          <input aria-label="ClickHouse username" className="iml-input" id="iml-byoc-user" value={form.username} onChange={(event) => onField("username", event.target.value)} placeholder="instantml_writer" />
        </div>
      </div>

      <div className="iml-field">
        <label htmlFor="iml-byoc-password">Password</label>
        <input aria-label="ClickHouse password" className="iml-input" id="iml-byoc-password" value={form.password} onChange={(event) => onField("password", event.target.value)} placeholder="ClickHouse user password" type="password" autoComplete="off" />
      </div>

      {validation ? (
        <p className="iml-status is-busy" role="status">
          <CheckCircle2 size={14} aria-hidden="true" />
          Validated {validation.database}{validation.server_version ? ` on ClickHouse ${validation.server_version}` : ""}.
        </p>
      ) : null}

      <div className="iml-byoc-actions">
        <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" disabled={busy || !canSubmit} onClick={onValidate} type="button">
          {busy ? <span className="iml-spin" aria-hidden="true" /> : <Database size={16} />}
          Validate connection
        </button>
        <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy || !canSubmit} onClick={onSave} type="button">
          {busy ? <span className="iml-spin on-fill" aria-hidden="true" /> : <KeyRound size={16} />}
          Save connection
        </button>
      </div>
    </div>
  );
}

function WorkspacePreview({
  autoSlug, availability, effectiveName, override, planTier, storageChoice, onOverride, onPlanTier, onStorageChoice,
}: {
  autoSlug: string;
  availability: OrgAvailability;
  effectiveName: string;
  override: string;
  planTier: PlanTier;
  storageChoice: StorageChoice;
  onOverride: (value: string) => void;
  onPlanTier: (value: PlanTier) => void;
  onStorageChoice: (value: StorageChoice) => void;
}) {
  return (
    <>
      <PlanPicker planTier={planTier} onPlanTier={onPlanTier} />
      <StorageChoicePicker storageChoice={storageChoice} onStorageChoice={onStorageChoice} />
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
    </>
  );
}

function PlanPicker({ planTier, onPlanTier }: { planTier: PlanTier; onPlanTier: (value: PlanTier) => void }) {
  return (
    <fieldset className="iml-field iml-fieldset">
      <legend className="iml-legend">Plan</legend>
      <div className="iml-plans">
        {PLAN_OPTIONS.map((plan) => {
          const Icon = plan.icon;
          return (
            <label className="iml-plan" key={plan.id}>
              <input aria-label={plan.label} checked={planTier === plan.id} name="iml-plan-tier" onChange={() => onPlanTier(plan.id)} type="radio" />
              <span className="iml-plan-h"><Icon size={15} aria-hidden="true" /> {plan.label}</span>
              <strong className="iml-plan-p">{plan.price}<small>/mo</small></strong>
              <span className="iml-plan-m"><Users size={12} aria-hidden="true" /> {plan.seats}</span>
              <span className="iml-plan-m"><HardDrive size={12} aria-hidden="true" /> {plan.storage}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function StorageChoicePicker({
  storageChoice, onStorageChoice,
}: {
  storageChoice: StorageChoice;
  onStorageChoice: (value: StorageChoice) => void;
}) {
  return (
    <fieldset className="iml-field iml-fieldset">
      <legend className="iml-legend">Storage</legend>
      <div className="iml-seg">
        <label className="iml-seg-opt">
          <input aria-label="InstantML-hosted storage" checked={storageChoice === STORAGE_HOSTED} name="iml-storage-choice" onChange={() => onStorageChoice(STORAGE_HOSTED)} type="radio" />
          <span className="iml-seg-t"><span className="iml-tick" aria-hidden="true">✓</span><Cloud size={14} aria-hidden="true" /> InstantML-hosted</span>
          <span className="iml-seg-d">InstantML-managed ClickHouse and R2 artifacts.</span>
        </label>
        <label className="iml-seg-opt">
          <input aria-label="Connect my ClickHouse storage" checked={storageChoice === STORAGE_BYOC} name="iml-storage-choice" onChange={() => onStorageChoice(STORAGE_BYOC)} type="radio" />
          <span className="iml-seg-t"><span className="iml-tick" aria-hidden="true">✓</span><Database size={14} aria-hidden="true" /> Connect my ClickHouse</span>
          <span className="iml-seg-d">Premium BYOC. Run data goes to your GCP ClickHouse; InstantML counts only R2 artifact bytes.</span>
        </label>
      </div>
      {storageChoice === STORAGE_BYOC ? (
        <span className="iml-hint">BYOC requires Premium and a pre-created GCP ClickHouse database reachable from InstantML egress.</span>
      ) : null}
    </fieldset>
  );
}

function SignupFields({
  accountType, availability, orgName, seatEmails, seatCount, seatLimit, planTier, storageChoice,
  onAccountType, onOrgName, onPlanTier, onStorageChoice, onSeatEmails,
}: {
  accountType: string;
  availability: OrgAvailability;
  orgName: string;
  seatEmails: string;
  seatCount: number;
  seatLimit: number;
  storageChoice: StorageChoice;
  onAccountType: (value: string) => void;
  onOrgName: (value: string) => void;
  onPlanTier: (value: PlanTier) => void;
  onStorageChoice: (value: StorageChoice) => void;
  onSeatEmails: (value: string) => void;
  planTier: PlanTier;
}) {
  const overLimit = seatCount > Math.max(0, seatLimit - 1);
  return (
    <>
      <PlanPicker planTier={planTier} onPlanTier={onPlanTier} />
      <StorageChoicePicker storageChoice={storageChoice} onStorageChoice={onStorageChoice} />
      <fieldset className="iml-field iml-fieldset">
        <legend className="iml-legend">Account type</legend>
        <div className="iml-seg">
          <label className="iml-seg-opt">
            <input aria-label="Personal workspace" checked={accountType === "personal"} name="iml-account-type" onChange={() => onAccountType("personal")} type="radio" />
            <span className="iml-seg-t"><span className="iml-tick" aria-hidden="true">✓</span> Personal</span>
            <span className="iml-seg-d">Personal workspace · 1 seat</span>
          </label>
          <label className="iml-seg-opt">
            <input aria-label="Business workspace" checked={accountType === "business"} name="iml-account-type" onChange={() => onAccountType("business")} type="radio" />
            <span className="iml-seg-t"><span className="iml-tick" aria-hidden="true">✓</span> Business</span>
            <span className="iml-seg-d">Team org · 3 seats, reservable</span>
          </label>
        </div>
      </fieldset>

      <div className="iml-field">
        <label htmlFor="iml-org">{accountType === "business" ? "Organization" : "Workspace"} <span className="iml-hint">required</span></label>
        <input
          aria-label={accountType === "business" ? "Organization" : "Workspace"}
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
            aria-label="Reserved seats"
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

function workspaceUsesByoc(session: SessionPayload | null) {
  return session?.organization?.storage_choice === STORAGE_BYOC;
}

function workspaceStorageReady(session: SessionPayload | null) {
  if (!session?.organization?.id) return true;
  return !organizationRequiresStorageOnboarding(session.organization);
}

function canManageWorkspaceStorage(session: SessionPayload | null) {
  const role = session?.membership?.role;
  return role === "owner" || role === "admin";
}

function clickhouseIdentifierPreview(value: string, fallback: string) {
  const trimmed = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(trimmed) ? trimmed : fallback;
}

function isSharedDemoSession(session: SessionPayload | null) {
  return session?.user?.primary_email === SHARED_DEMO_EMAIL
    || session?.organization?.name === SHARED_DEMO_ORG
    || session?.organization?.slug === "instantml-demo";
}
