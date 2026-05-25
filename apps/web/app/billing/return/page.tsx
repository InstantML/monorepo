"use client";

import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiClient } from "../../../src/api.js";

export default function BillingReturnPage() {
  const api = useMemo(() => new ApiClient(), []);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState("Verifying payment...");

  useEffect(() => {
    const controller = new AbortController();
    let redirectTimer: number | null = null;
    const sessionId = new URLSearchParams(window.location.search).get("session_id") ?? "";
    if (!sessionId) {
      setState("error");
      setMessage("Checkout session is missing.");
      return () => controller.abort();
    }
    async function syncCheckout() {
      try {
        await api.post("/api/billing/checkout/sync", { session_id: sessionId }, { signal: controller.signal });
        setState("ok");
        setMessage("Payment verified. Opening onboarding...");
        redirectTimer = window.setTimeout(() => {
          if (!controller.signal.aborted) window.location.assign("/onboarding");
        }, 800);
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") return;
        setState("error");
        setMessage(error instanceof Error ? error.message : "Unable to verify payment.");
      }
    }
    void syncCheckout();
    return () => {
      controller.abort();
      if (redirectTimer) window.clearTimeout(redirectTimer);
    };
  }, [api]);

  const Icon = state === "ok" ? CheckCircle2 : state === "error" ? TriangleAlert : Loader2;

  return (
    <main className="iml-auth">
      <section className="iml-stage">
        <div className="iml-card iml-card--single">
          <div className="iml-main">
            <div className="iml-head">
              <p className={`iml-eyebrow${state === "error" ? " is-danger" : " is-accent"}`}>Stripe Checkout</p>
              <h1 className="iml-headline">Finishing <span className="iml-em">billing</span></h1>
              <p className="iml-sub">InstantML is confirming the paid subscription before unlocking workspace writes.</p>
            </div>
            <p className={`iml-status ${state === "error" ? "is-err" : state === "loading" ? "is-busy" : ""}`} role={state === "error" ? "alert" : "status"}>
              <Icon size={14} className={state === "loading" ? "iml-spin" : ""} aria-hidden="true" />
              {message}
            </p>
            {state === "error" ? (
              <div className="iml-actions">
                <a className="iml-btn iml-btn--primary iml-btn--lg iml-btn--block" href="/dashboard/settings">Open billing settings</a>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
