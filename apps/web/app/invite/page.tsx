"use client";

import { SignInButton, SignUpButton, UserButton, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { ArrowRight, LogOut, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ApiClient, ApiError } from "../../src/api.js";
import type { components } from "../../src/types/api.generated";
import { InstantMlMark } from "../instantml-mark";

type AuthConfig = {
  dev_auth_enabled?: boolean;
  managed_clerk_enabled?: boolean;
  loaded?: boolean;
};
type SessionPayload = {
  authenticated?: boolean;
  user?: { primary_email?: string };
};
type InvitationPreview = components["schemas"]["InvitationPreviewPayload"];

const INVITE_TOKEN_STORAGE_KEY = "instantml.inviteToken";
const INVITE_TOKEN_STORAGE_TTL_MS = 15 * 60 * 1000;

export default function InvitePage() {
  const api = useMemo(() => new ApiClient(), []);
  const attemptedClerkExchangeRef = useRef(false);
  const acceptStartedRef = useRef(false);
  const { getToken, isLoaded: clerkLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const { user } = useUser();
  const [token, setToken] = useState("");
  const [config, setConfig] = useState<AuthConfig>({ loaded: false });
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [devEmail, setDevEmail] = useState("");
  const [message, setMessage] = useState("Checking invitation...");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  function note(text: string) {
    setIsError(false);
    setMessage(text);
  }
  function fail(text: string) {
    setIsError(true);
    setMessage(text);
  }

  useEffect(() => {
    const parsed = tokenFromLocation();
    if (!parsed) {
      fail("Invitation link is missing or invalid.");
      return;
    }
    setToken(parsed);
    saveStoredInviteToken(parsed);
    window.history.replaceState(null, "", "/invite");
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const [configPayload, previewPayload, sessionPayload] = await Promise.all([
          api.get("/api/auth/config", { signal: controller.signal }),
          api.post("/api/invitations/preview", { token }, { signal: controller.signal }),
          api.get("/api/auth/session", { signal: controller.signal }).catch(() => ({ authenticated: false })),
        ]);
        if (cancelled) return;
        const invite = (previewPayload as { invitation?: InvitationPreview }).invitation;
        if (!invite) throw new Error("Invitation preview was malformed.");
        const nextConfig = { ...(configPayload as AuthConfig), loaded: true };
        setConfig(nextConfig);
        setPreview(invite);
        setSession(sessionPayload as SessionPayload);
        setDevEmail("");
        if (invite.status !== "pending") {
          clearStoredInviteToken();
          fail(`Invitation is ${invite.status}.`);
          return;
        }
        note(nextConfig.managed_clerk_enabled
          ? "Verify your email with Clerk to join the workspace."
          : (sessionPayload as SessionPayload).authenticated
            ? "Accepting invitation..."
            : "Verify your email to join the workspace.");
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (shouldClearInviteToken(error)) clearStoredInviteToken();
        fail(error instanceof Error ? error.message : "Unable to load invitation.");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, token]);

  useEffect(() => {
    if (!token || !preview || preview.status !== "pending" || busy || acceptStartedRef.current || !config.loaded) return;
    if (session?.authenticated && !config.managed_clerk_enabled) {
      acceptStartedRef.current = true;
      void acceptCurrentSession();
    }
  }, [config.loaded, config.managed_clerk_enabled, session?.authenticated, preview, token, busy]);

  useEffect(() => {
    if (!token || !preview || preview.status !== "pending" || !config.loaded) return;
    if (!config.managed_clerk_enabled || !clerkLoaded || !isSignedIn || attemptedClerkExchangeRef.current || acceptStartedRef.current) return;
    attemptedClerkExchangeRef.current = true;
    void exchangeClerkSession();
  }, [clerkLoaded, config.loaded, config.managed_clerk_enabled, isSignedIn, preview, token]);

  async function acceptCurrentSession() {
    if (!token) return;
    setBusy(true);
    note("Accepting invitation...");
    try {
      await api.post("/api/invitations/accept", { token });
      clearStoredInviteToken();
      note("Invitation accepted. Opening dashboard...");
      window.location.assign("/dashboard/runs");
    } catch (error) {
      handleInviteFailure(error, "Unable to accept invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function exchangeClerkSession() {
    if (!token) return;
    setBusy(true);
    note("Verifying your email...");
    try {
      const clerkToken = await getToken({ skipCache: true });
      if (!clerkToken) throw new Error("Clerk did not return a session token.");
      await api.post("/api/auth/clerk", {
        token: clerkToken,
        mode: "signin",
        accept_invite_token: token,
      });
      clearStoredInviteToken();
      note("Invitation accepted. Opening dashboard...");
      window.location.assign("/dashboard/runs");
    } catch (error) {
      attemptedClerkExchangeRef.current = false;
      handleInviteFailure(error, "Unable to verify invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function submitDevAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !devEmail.trim()) return;
    setBusy(true);
    note("Accepting invitation...");
    try {
      await api.post("/api/auth/dev/google", {
        email: devEmail.trim(),
        mode: "signin",
        accept_invite_token: token,
      });
      clearStoredInviteToken();
      note("Invitation accepted. Opening dashboard...");
      window.location.assign("/dashboard/runs");
    } catch (error) {
      handleInviteFailure(error, "Unable to accept invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    attemptedClerkExchangeRef.current = false;
    acceptStartedRef.current = false;
    await clearInstantMlSession();
    setSession({ authenticated: false });
    if (token) saveStoredInviteToken(token);
    if (config.managed_clerk_enabled) await clerk.signOut();
    note("Choose an account that matches the invitation email.");
  }

  function handleInviteFailure(error: unknown, fallback: string) {
    if (shouldClearInviteToken(error)) clearStoredInviteToken();
    if (isEmailMismatch(error)) {
      if (token) saveStoredInviteToken(token);
      void clearInstantMlSession();
      setSession({ authenticated: false });
    }
    fail(inviteErrorMessage(error, fallback));
  }

  async function clearInstantMlSession() {
    try {
      await api.post("/api/auth/logout", {});
    } catch {
      // Best effort: the stale browser cookie is cleared by the server when reachable.
    }
  }

  const statusClass = isError ? "iml-status is-err" : busy ? "iml-status is-busy" : "iml-status";
  const expires = preview?.expires_at ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(preview.expires_at)) : "";
  const signedInEmail = user?.primaryEmailAddress?.emailAddress ?? session?.user?.primary_email ?? "";

  return (
    <div className="iml-auth">
      <main className="iml-stage">
        <section className="iml-card iml-card--single" aria-busy={busy}>
          <div className="iml-main">
            <div className="iml-head">
              <div className="iml-brand">
                <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
                InstantML
              </div>
              <p className={`iml-eyebrow${isError ? " is-danger" : " is-accent"}`}>
                {preview?.role ? `${preview.role} invite` : "Workspace invite"}
              </p>
              <h1 className="iml-headline">{preview ? <>Join <span className="iml-em">{preview.org_name}</span></> : "Open invitation"}</h1>
              <p className="iml-sub">
                {preview ? `${preview.email_hint} was invited to this workspace. The invitation expires ${expires}.` : "Use the invitation link from your email to continue."}
              </p>
            </div>

            <div className={statusClass} role={isError ? "alert" : "status"}>
              {busy ? <span className="iml-spin" aria-hidden="true" /> : isError ? <LogOut size={15} /> : <ShieldCheck size={15} />}
              {message}
            </div>

            {preview?.status === "pending" ? (
              <div className="iml-actions">
                {config.managed_clerk_enabled && clerkLoaded ? (
                  <>
                    {!isSignedIn ? (
                      <>
                        <SignInButton mode="modal" forceRedirectUrl="/invite">
                          <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy} type="button">
                            <ShieldCheck size={16} /> Sign in with Clerk <ArrowRight className="iml-arrow" size={15} />
                          </button>
                        </SignInButton>
                        <SignUpButton mode="modal" forceRedirectUrl="/invite">
                          <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" disabled={busy} type="button">
                            <UserPlus size={16} /> Create verified account
                          </button>
                        </SignUpButton>
                      </>
                    ) : (
                      <>
                        <div className="iml-org">
                          <span className="iml-org-badge"><UserButton /></span>
                          <div className="iml-org-m">
                            <strong>{user?.fullName || signedInEmail || "Clerk account"}</strong>
                            <span>{signedInEmail || "Signed in with Clerk"}</span>
                          </div>
                        </div>
                        <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy} onClick={exchangeClerkSession} type="button">
                          {busy ? <span className="iml-spin on-fill" aria-hidden="true" /> : <ShieldCheck size={16} />}
                          Continue to workspace
                        </button>
                        <button className="iml-btn iml-btn--ghost iml-btn--block" disabled={busy} onClick={restart} type="button">
                          <LogOut size={15} /> Use a different account
                        </button>
                      </>
                    )}
                  </>
                ) : null}
                {config.managed_clerk_enabled && !clerkLoaded ? (
                  <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" disabled type="button">
                    <span className="iml-spin" aria-hidden="true" /> Loading sign-in
                  </button>
                ) : null}

                {config.dev_auth_enabled ? (
                  <form className="iml-actions" onSubmit={submitDevAuth} aria-label="Local development invitation sign in">
                    {config.managed_clerk_enabled ? <p className="iml-hint" style={{ textAlign: "center" }}>— or use local development auth —</p> : null}
                    <div className="iml-field">
                      <label htmlFor="invite-dev-email">Email</label>
                      <input className="iml-input" id="invite-dev-email" required type="email" value={devEmail} onChange={(event) => setDevEmail(event.target.value)} />
                    </div>
                    <button className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" disabled={busy || !devEmail.trim()} type="submit">
                      <UserPlus size={15} /> Accept invitation
                    </button>
                  </form>
                ) : null}

                {!config.managed_clerk_enabled && !config.dev_auth_enabled ? (
                  <button className="iml-btn iml-btn--outline iml-btn--lg iml-btn--block" disabled={busy} onClick={() => window.location.reload()} type="button">
                    <RefreshCw size={15} /> Retry
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

function tokenFromLocation() {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (hash) {
    const params = new URLSearchParams(hash);
    const token = params.get("t")?.trim() ?? "";
    if (looksLikeInviteToken(token)) return token;
  }
  return readStoredInviteToken();
}

function looksLikeInviteToken(token: string) {
  return token.startsWith("instantml_invite_") && token.length <= 512;
}

function saveStoredInviteToken(token: string) {
  if (typeof window === "undefined" || !looksLikeInviteToken(token)) return;
  try {
    window.sessionStorage.setItem(
      INVITE_TOKEN_STORAGE_KEY,
      JSON.stringify({ token, savedAt: Date.now() }),
    );
  } catch {
    // Some hardened browser modes block storage; the in-memory token still works.
  }
}

function readStoredInviteToken() {
  if (typeof window === "undefined") return "";
  let raw = "";
  try {
    raw = window.sessionStorage.getItem(INVITE_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; savedAt?: unknown };
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    if (looksLikeInviteToken(token) && Date.now() - savedAt <= INVITE_TOKEN_STORAGE_TTL_MS) {
      return token;
    }
  } catch {
    // Old raw-token storage is intentionally ignored so stale links do not reappear.
  }
  clearStoredInviteToken();
  return "";
}

function clearStoredInviteToken() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(INVITE_TOKEN_STORAGE_KEY);
  } catch {
    // Best effort only.
  }
}

function shouldClearInviteToken(error: unknown) {
  return error instanceof ApiError && [
    "invite_expired",
    "invite_not_found",
    "invite_revoked",
  ].includes(error.code);
}

function isEmailMismatch(error: unknown) {
  return error instanceof ApiError && error.code === "invite_email_mismatch";
}

function inviteErrorMessage(error: unknown, fallback: string) {
  if (isEmailMismatch(error)) {
    return "This invitation is for a different email address. Sign out and use the invited account.";
  }
  if (error instanceof ApiError && error.code === "clerk_exchange_required") {
    return "Refresh your Clerk sign-in before accepting this invitation.";
  }
  return error instanceof Error ? error.message : fallback;
}
