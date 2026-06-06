"use client";

import { SignInButton, UserButton } from "@clerk/nextjs";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { LogoMark } from "../src/logo-mark";

type AdminAccessPanelProps = {
  mode: "setup" | "signed-out" | "denied";
  allowedEmailLabel: string;
  currentEmail?: string | null;
  message?: string;
};

export function AdminAccessPanel({
  mode,
  allowedEmailLabel,
  currentEmail,
  message,
}: AdminAccessPanelProps) {
  const signedOut = mode === "signed-out";
  const title = mode === "setup"
    ? "Admin sign-in is not configured"
    : signedOut
      ? "Operator sign-in required"
      : "Admin access denied";
  const copy = message ?? (signedOut
    ? `Sign in as ${allowedEmailLabel} to open the internal operator console.`
    : `This console currently allows only ${allowedEmailLabel}.`);

  return (
    <main className="setup-shell">
      <section className="setup-panel access-panel">
        <div className="brand-lockup">
          <span className="brand-mark">
            <LogoMark />
          </span>
          <div>
            <p>InstantML Admin</p>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="access-icon" aria-hidden="true">
          {signedOut ? <LockKeyhole size={22} /> : <ShieldCheck size={22} />}
        </div>
        <p className="setup-copy">{copy}</p>
        {currentEmail ? (
          <dl className="setup-list">
            <div>
              <dt>Signed in as</dt>
              <dd>{currentEmail}</dd>
            </div>
            <div>
              <dt>Allowed</dt>
              <dd>{allowedEmailLabel}</dd>
            </div>
          </dl>
        ) : null}
        {mode !== "setup" ? (
          <div className="access-actions">
            {signedOut ? (
              <SignInButton mode="modal">
                <button className="primary-action" type="button">Sign in</button>
              </SignInButton>
            ) : (
              <UserButton />
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}
