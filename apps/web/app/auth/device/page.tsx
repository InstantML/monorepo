"use client";

import { useAuth } from "@clerk/nextjs";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";

import { ApiClient } from "../../src/api.js";

type PageState =
  | { kind: "checking" }
  | { kind: "unauthenticated" }
  | { kind: "ready"; prefillCode: string }
  | { kind: "confirming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function DeviceConfirmForm() {
  const router = useRouter();
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
    const prefill = params?.get("code") ?? "";
    setState({ kind: "ready", prefillCode: prefill });
    if (prefill) setUserCode(prefill);
  }, [isLoaded, isSignedIn, params]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const code = userCode.trim().toUpperCase();
    if (!code) return;
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
      <div className="device-page">
        <p>Checking your session…</p>
      </div>
    );
  }

  if (state.kind === "unauthenticated") {
    return (
      <div className="device-page">
        <h1>Sign in required</h1>
        <p>
          You must be signed in to confirm a device. Please{" "}
          <a href={`/signin?next=${encodeURIComponent("/auth/device" + (params?.get("code") ? "?code=" + params.get("code") : ""))}`}>
            sign in
          </a>{" "}
          and return to this page.
        </p>
      </div>
    );
  }

  if (state.kind === "success") {
    return (
      <div className="device-page">
        <h1>Device confirmed</h1>
        <p>
          Your CLI is now connected. You can close this tab and return to your terminal.
        </p>
      </div>
    );
  }

  const busy = state.kind === "confirming";

  return (
    <div className="device-page">
      <h1>Connect a device</h1>
      <p>
        Enter the code displayed in your terminal to authorize the{" "}
        <code>instantml</code> CLI.
      </p>

      {state.kind === "error" && (
        <p className="device-error" role="alert">
          {state.message}
        </p>
      )}

      <form onSubmit={handleSubmit} className="device-form">
        <label htmlFor="user-code">Confirmation code</label>
        <input
          id="user-code"
          type="text"
          value={userCode}
          onChange={(e) => {
            // Auto-uppercase and insert hyphen after 4 chars for UX.
            let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
            if (val.length > 4) val = val.slice(0, 4) + "-" + val.slice(4, 8);
            setUserCode(val);
          }}
          placeholder="ABCD-EFGH"
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className="device-code-input"
        />
        <button type="submit" disabled={busy || !userCode.trim()}>
          {busy ? "Confirming…" : "Confirm device"}
        </button>
      </form>
    </div>
  );
}

export default function DeviceAuthPage() {
  return (
    <Suspense fallback={<div className="device-page"><p>Loading…</p></div>}>
      <DeviceConfirmForm />
    </Suspense>
  );
}
