"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight, CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";

import { ApiClient } from "../../../src/api.js";
import { normalizeDeviceUserCode } from "../../../src/routes.js";
import { InstantMlMark } from "../../instantml-mark";

type PageState =
  | { kind: "checking" }
  | { kind: "unauthenticated" }
  | { kind: "ready"; prefillCode: string }
  | { kind: "confirming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function formatDeviceCodeInput(value: string) {
  let normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length > 4) normalized = normalized.slice(0, 4) + "-" + normalized.slice(4, 8);
  return normalized.slice(0, 9);
}

function Brand() {
  return (
    <div className="iml-brand">
      <span className="iml-mark" aria-hidden="true"><InstantMlMark /></span>
      InstantML
    </div>
  );
}

function CardShell({
  eyebrow,
  headline,
  sub,
  children,
  status,
  isError,
}: {
  eyebrow: string;
  headline: React.ReactNode;
  sub: React.ReactNode;
  children?: React.ReactNode;
  status?: React.ReactNode;
  isError?: boolean;
}) {
  return (
    <div className="iml-auth">
      <main className="iml-stage">
        <section className="iml-card iml-card--single" aria-labelledby="iml-device-title">
          <div className="iml-main">
            <Brand />
            <div className="iml-head">
              <p className={`iml-eyebrow${isError ? " is-danger" : ""}`}>{eyebrow}</p>
              <h1 className="iml-headline" id="iml-device-title">{headline}</h1>
              <p className="iml-sub">{sub}</p>
            </div>
            {children}
            {status}
          </div>
        </section>
      </main>
    </div>
  );
}

function DeviceConfirmForm() {
  const params = useSearchParams();
  const { isLoaded, isSignedIn } = useAuth();
  const api = useMemo(() => new ApiClient(), []);

  const [userCode, setUserCode] = useState("");
  const [state, setState] = useState<PageState>({ kind: "checking" });

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setState({ kind: "unauthenticated" });
      return;
    }
    const formattedPrefill = normalizeDeviceUserCode(params?.get("code") ?? "");
    setState({ kind: "ready", prefillCode: formattedPrefill });
    if (formattedPrefill) setUserCode(formattedPrefill);
  }, [isLoaded, isSignedIn, params]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const code = normalizeDeviceUserCode(userCode);
    if (!code) {
      setState({ kind: "error", message: "Enter the 8-character device code shown in your terminal." });
      return;
    }
    setState({ kind: "confirming" });
    try {
      await api.post("/api/auth/device-code/confirm", { user_code: code });
      setState({ kind: "success" });
    } catch (err: any) {
      const message =
        err?.message ??
        (err?.code === "not_found"
          ? "Code not found or expired. Check the code and try again."
          : "An error occurred. Please try again.");
      setState({ kind: "error", message });
    }
  }

  if (state.kind === "checking") {
    return (
      <CardShell
        eyebrow="Connect a device"
        headline={<>Checking your <span className="iml-em">session</span></>}
        sub="One moment — verifying you're signed in before we authorize the CLI."
        status={<p className="iml-status is-busy" role="status"><span className="iml-spin" aria-hidden="true" /> Checking…</p>}
      />
    );
  }

  if (state.kind === "unauthenticated") {
    const nextCode = normalizeDeviceUserCode(params?.get("code") ?? "");
    const nextParam = encodeURIComponent(`/auth/device${nextCode ? `?code=${nextCode}` : ""}`);
    return (
      <CardShell
        eyebrow="Sign in required"
        headline={<>Sign in to <span className="iml-em">continue</span></>}
        sub="You must be signed into InstantML to authorize the CLI for this account."
      >
        <div className="iml-actions">
          <Link className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" href={`/signin?next=${nextParam}`}>
            <ShieldCheck size={16} /> Sign in <ArrowRight className="iml-arrow" size={15} />
          </Link>
        </div>
      </CardShell>
    );
  }

  if (state.kind === "success") {
    return (
      <CardShell
        eyebrow="Device confirmed"
        headline={<>You're <span className="iml-em">connected.</span></>}
        sub="The CLI is now authorized for this account. You can close this tab and return to your terminal."
        status={<p className="iml-status is-ok" role="status"><CheckCircle2 size={14} aria-hidden="true" /> Authorized — head back to your terminal.</p>}
      />
    );
  }

  const busy = state.kind === "confirming";
  const isError = state.kind === "error";

  return (
    <CardShell
      eyebrow="Connect a device"
      headline={<>Authorize the <span className="iml-em">instantml CLI</span></>}
      sub={<>Enter the code shown in your terminal after running <code>instantml login</code>. We&rsquo;ll link this CLI to your account.</>}
      isError={isError}
      status={
        isError ? (
          <p className="iml-status is-err" role="alert"><AlertCircle size={14} aria-hidden="true" /> {state.message}</p>
        ) : null
      }
    >
      <form className="iml-actions" onSubmit={handleSubmit} aria-label="Device authorization">
        <div className="iml-field">
          <label htmlFor="user-code">Confirmation code</label>
          <input
            aria-label="Confirmation code"
            className="iml-input"
            id="user-code"
            type="text"
            value={userCode}
            onChange={(e) => {
              setUserCode(formatDeviceCodeInput(e.target.value));
            }}
            placeholder="ABCD-EFGH"
            maxLength={9}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-describedby="user-code-help"
          />
          <span className="iml-hint" id="user-code-help">Format: <code>XXXX-XXXX</code>. Case-insensitive.</span>
        </div>
        <button
          className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block"
          disabled={busy || !userCode.trim()}
          type="submit"
        >
          {busy ? <span className="iml-spin on-fill" aria-hidden="true" /> : <KeyRound size={16} />}
          {busy ? "Confirming…" : "Confirm device"}
          {!busy ? <ArrowRight className="iml-arrow" size={15} /> : null}
        </button>
      </form>
    </CardShell>
  );
}

export default function DeviceAuthPage() {
  return (
    <Suspense
      fallback={
        <div className="iml-auth">
          <main className="iml-stage">
            <section className="iml-card iml-card--single">
              <div className="iml-main">
                <Brand />
                <p className="iml-status is-busy"><span className="iml-spin" aria-hidden="true" /> Loading…</p>
              </div>
            </section>
          </main>
        </div>
      }
    >
      <DeviceConfirmForm />
    </Suspense>
  );
}
