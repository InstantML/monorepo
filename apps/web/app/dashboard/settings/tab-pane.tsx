"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, CreditCard, ExternalLink, Gauge, RefreshCw, Settings, UserPlus, X } from "lucide-react";

import { CustomSelect } from "../ui/select";
import { MetricCard } from "../ui/metric-card";
import { PageHead } from "../ui/page-head";
import { SettingRow } from "./setting-row";
import { formatNumber } from "../../../src/state.js";
import { roleLabel } from "../../../src/roles.js";
import type { components } from "../../../src/types/api.generated";

type SeatRow = components["schemas"]["SeatRow"];
type InvitationRow = components["schemas"]["PublicInvitationRow"];

type UsageWarning = { code?: string; message?: string };
type BillingStatus = {
  access_state?: string;
  effective_plan_tier?: string;
  plan_tier?: string;
  requested_plan_tier?: string | null;
  stripe_subscription_id?: string | null;
  subscription_status?: string | null;
  cancel_at_period_end?: boolean;
  message?: string | null;
};

const RETRY_PLAN_LABELS = {
  pro: "Retry Pro",
  premium: "Retry Premium",
};

// Hosted beta list prices; shown in the in-app confirmation step before any
// redirect to Stripe checkout.
const PLAN_RANK: Record<"free" | "pro" | "premium", number> = { free: 0, pro: 1, premium: 2 };

const PLAN_CONFIRM_SUMMARY: Record<"free" | "pro" | "premium", { price: string; note: string }> = {
  free: { price: "$0", note: "The downgrade applies at the next billing boundary; nothing is charged." },
  pro: { price: "$199/month", note: "Nothing is charged yet — you'll review the full price and confirm payment on Stripe's secure checkout." },
  premium: { price: "$699/month", note: "Nothing is charged yet — you'll review the full price and confirm payment on Stripe's secure checkout." },
};

function formatInviteDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown expiry";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function inviteStatusLabel(invitation: InvitationRow) {
  if (invitation.status === "pending") return invitation.delivery_status === "sent" ? "sent" : invitation.delivery_status || "pending";
  if (invitation.delivery_status === "send_failed" && !["accepted", "expired", "revoked"].includes(invitation.status ?? "")) return "send failed";
  return invitation.status;
}

function planDisplayName(value?: string) {
  if (value === "pro") return "Pro";
  if (value === "premium") return "Premium";
  if (value === "enterprise") return "Enterprise";
  return "Free";
}

type Props = {
  activeLimitIncludedSeats: number;
  activePlan: string;
  activeUsageWarnings: UsageWarning[];
  adminBusy: boolean;
  canManageOrg: boolean;
  formatBytes: (n: number) => string;
  inviteEmail: string;
  inviteRole: string;
  invitations: InvitationRow[];
  invitationLinks: Record<string, string>;
  metricKey: string;
  metricOptionsForControls: string[];
  metricPercent: number;
  metricUsed: number;
  metricLimit: number;
  apiRequestsPercent: number;
  apiRequestsUsed: number;
  apiRequestsLimit: number;
  generalRateLimitLabel: string;
  ingestRateLimitLabel: string;
  onInviteEmail: (email: string) => void;
  onInviteRole: (role: string) => void;
  onInviteSeat: () => void;
  onCopyInvitationLink: (invitationId: string) => void;
  onOpenInvitationLink: (invitationId: string) => void;
  onResendInvitation: (invitationId: string) => void;
  onRevokeInvitation: (invitationId: string) => void;
  onOpenBillingPortal: () => void;
  onChangeBillingPlan: (plan: "free" | "pro" | "premium") => void;
  onCancelBilling: () => void;
  onLoadOrgSettings: () => void;
  onMetricKey: (key: string) => void;
  onXMode: (mode: string) => void;
  orgName: string;
  orgPlanTier: string;
  project: string;
  reservedSeatCount: number;
  seats: SeatRow[];
  selectedRunCount: number;
  status: string;
  storagePercent: number;
  storageUsed: number;
  storageLimit: number;
  storageUsageLabel: string;
  storageUsageDescription: string;
  usageResetLabel: string;
  usageAvailable: boolean;
  xMode: string;
  billingStatus: BillingStatus | null;
};

export function SettingsTabPane({
  activeLimitIncludedSeats,
  activePlan,
  activeUsageWarnings,
  adminBusy,
  canManageOrg,
  formatBytes,
  inviteEmail,
  inviteRole,
  invitations,
  invitationLinks,
  metricKey,
  metricOptionsForControls,
  metricPercent,
  metricUsed,
  metricLimit,
  apiRequestsPercent,
  apiRequestsUsed,
  apiRequestsLimit,
  generalRateLimitLabel,
  ingestRateLimitLabel,
  onInviteEmail,
  onInviteRole,
  onInviteSeat,
  onCopyInvitationLink,
  onOpenInvitationLink,
  onResendInvitation,
  onRevokeInvitation,
  onOpenBillingPortal,
  onChangeBillingPlan,
  onCancelBilling,
  onLoadOrgSettings,
  onMetricKey,
  onXMode,
  orgName,
  orgPlanTier,
  project,
  reservedSeatCount,
  seats,
  selectedRunCount,
  status,
  storagePercent,
  storageUsed,
  storageLimit,
  storageUsageLabel,
  storageUsageDescription,
  usageResetLabel,
  usageAvailable,
  xMode,
  billingStatus,
}: Props) {
  // Plan changes confirm in-app before any Stripe redirect.
  const [pendingPlan, setPendingPlan] = useState<"free" | "pro" | "premium" | null>(null);
  // Drop a stale confirm if the plan changes underneath it (another admin
  // completed an upgrade, or checkout returned).
  useEffect(() => {
    setPendingPlan(null);
  }, [orgPlanTier, billingStatus?.access_state]);
  const adminOnlyValue = "Available to admins";
  const usageUnavailableValue = "Unavailable";
  const billingState = canManageOrg ? billingStatus?.access_state ?? "free_active" : adminOnlyValue;
  const billingSubscription = canManageOrg ? billingStatus?.subscription_status ?? "none" : adminOnlyValue;
  const effectivePlan = canManageOrg ? billingStatus?.effective_plan_tier ?? orgPlanTier ?? "free" : orgPlanTier || activePlan || "free";
  const usageValue = (used: number, limit: number) => usageAvailable
    ? `${formatNumber(used, 0)} / ${limit ? formatNumber(limit, 0) : "-"}`
    : usageUnavailableValue;
  const storageUsageValue = canManageOrg ? (usageAvailable ? `${formatBytes(storageUsed)} / ${storageLimit ? formatBytes(storageLimit) : "-"}` : usageUnavailableValue) : adminOnlyValue;
  const metricUsageValue = canManageOrg ? usageValue(metricUsed, metricLimit) : adminOnlyValue;
  const apiRequestUsageValue = canManageOrg ? usageValue(apiRequestsUsed, apiRequestsLimit) : adminOnlyValue;
  const storageMeterPercent = canManageOrg && usageAvailable ? storagePercent : 0;
  const metricMeterPercent = canManageOrg && usageAvailable ? metricPercent : 0;
  const apiRequestMeterPercent = canManageOrg && usageAvailable ? apiRequestsPercent : 0;
  const visibleInvitations = invitations.filter((invitation) => invitation.status !== "accepted");
  const checkoutRetryPlan = billingStatus?.access_state === "checkout_pending"
    ? billingStatus.requested_plan_tier ?? billingStatus.plan_tier ?? orgPlanTier
    : "";
  const canRetryPlanCheckout = (plan: "pro" | "premium") => (
    canManageOrg &&
    checkoutRetryPlan === plan &&
    billingStatus?.effective_plan_tier !== plan &&
    !billingStatus?.stripe_subscription_id
  );
  const subscriptionState = billingStatus?.subscription_status ?? "";
  const hasBillingSubscription = Boolean(
    billingStatus?.stripe_subscription_id ||
    (subscriptionState && !["none", "canceled", "cancelled"].includes(subscriptionState)),
  );
  const canOpenBillingPortal = canManageOrg && !adminBusy && hasBillingSubscription;
  const canCancelBilling = canOpenBillingPortal && !billingStatus?.cancel_at_period_end;
  const planButtonDisabled = (plan: "free" | "pro" | "premium") => (
    adminBusy || (orgPlanTier === plan && (plan === "free" || !canRetryPlanCheckout(plan)))
  );
  const planButtonLabel = (plan: "free" | "pro" | "premium") => {
    if (plan !== "free" && canRetryPlanCheckout(plan)) return RETRY_PLAN_LABELS[plan];
    if (orgPlanTier === plan) return `Current ${planDisplayName(plan)}`;
    return `Change to ${planDisplayName(plan)}`;
  };
  const planButtonTitle = (plan: "free" | "pro" | "premium") => {
    if (adminBusy) return "Billing action in progress";
    if (plan !== "free" && canRetryPlanCheckout(plan)) return `Retry ${planDisplayName(plan)} checkout`;
    if (orgPlanTier === plan) return `${planDisplayName(plan)} is the current plan`;
    return `Change workspace billing to ${planDisplayName(plan)}`;
  };
  const portalTitle = adminBusy
    ? "Billing action in progress"
    : hasBillingSubscription
      ? "Open the Stripe billing portal"
      : "No active paid subscription yet";
  const cancelTitle = adminBusy
    ? "Billing action in progress"
    : !hasBillingSubscription
      ? "No active paid subscription to cancel"
      : billingStatus?.cancel_at_period_end
        ? "Subscription is already scheduled to cancel"
        : "Cancel the active paid subscription at period end";
  return (
    <>
      <PageHead eyebrow={canManageOrg ? "Admin" : "Workspace"} title="Workspace settings" lede={`${activePlan} · usage · seats`} />
      <div className="tab-grid settings-grid">
        <section className="panel">
          <div className="panel-head">
            <h2><Gauge size={15} /> Plan Usage</h2>
            <button className="ghost" disabled={adminBusy || !canManageOrg} onClick={onLoadOrgSettings} type="button"><RefreshCw size={14} /> Refresh</button>
          </div>
          <div className="panel-body insight-stack">
            <MetricCard label="Plan" value={activePlan} tone="good" />
            <MetricCard label="Seats" value={`${formatNumber(reservedSeatCount, 0)} / ${formatNumber(activeLimitIncludedSeats, 0)}`} tone="neutral" />
            <MetricCard label={storageUsageLabel} value={storageUsageValue} tone={canManageOrg && storagePercent > 90 ? "bad" : canManageOrg && storagePercent > 70 ? "live" : "neutral"} />
            {canManageOrg && storageUsageDescription ? <p className="setting-hint">{storageUsageDescription}</p> : null}
            {canManageOrg && !usageAvailable ? <p className="setting-hint">Usage reporting is not available from this local control plane.</p> : null}
            {!canManageOrg ? <p className="setting-hint">Usage reporting is available to workspace admins.</p> : null}
            <div className="usage-meter" aria-label={`${storageUsageLabel} usage`}>
              <span style={{ width: `${storageMeterPercent}%` }} />
            </div>
            <MetricCard label="Metric points this month" value={metricUsageValue} tone={canManageOrg && metricPercent > 90 ? "bad" : canManageOrg && metricPercent > 70 ? "live" : "neutral"} />
            <div className="usage-meter" aria-label="Metric point usage">
              <span style={{ width: `${metricMeterPercent}%` }} />
            </div>
            <MetricCard label="API requests this month" value={apiRequestUsageValue} tone={canManageOrg && apiRequestsPercent > 90 ? "bad" : canManageOrg && apiRequestsPercent > 70 ? "live" : "neutral"} />
            <div className="usage-meter" aria-label="API request usage">
              <span style={{ width: `${apiRequestMeterPercent}%` }} />
            </div>
            <SettingRow label="General API rate" value={canManageOrg ? generalRateLimitLabel || "-" : adminOnlyValue} />
            <SettingRow label="Ingest API rate" value={canManageOrg ? ingestRateLimitLabel || "-" : adminOnlyValue} />
            <SettingRow label="Monthly reset" value={canManageOrg && usageAvailable && usageResetLabel ? `${usageResetLabel} UTC` : canManageOrg && usageAvailable ? "-" : canManageOrg ? usageUnavailableValue : adminOnlyValue} />
                {canManageOrg && activeUsageWarnings.length ? (
              <div className="admin-alert-list">
                {activeUsageWarnings.map((warning) => (
                  <div className="api-row" key={`${warning.code ?? "warning"}-${warning.message ?? "usage"}`}>
                    <AlertTriangle size={14} />
                    <strong>{warning.message ?? warning.code ?? "Usage warning"}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><CreditCard size={15} /> Billing</h2></div>
          <div className="panel-body settings-list">
            <SettingRow label="Access" value={billingState.replace(/_/g, " ")} />
            <SettingRow label="Subscription" value={billingSubscription} />
            <SettingRow label="Effective plan" value={effectivePlan} />
            {canManageOrg && billingStatus?.message ? (
              <div className="api-row">
                <AlertTriangle size={14} />
                <strong>{billingStatus.message}</strong>
              </div>
            ) : null}
            {canManageOrg ? (
              <div className="admin-form-row billing-actions">
                <button className="secondary compact-button" disabled={!canOpenBillingPortal} onClick={onOpenBillingPortal} title={portalTitle} type="button"><CreditCard size={14} /> Open portal</button>
                <button className="secondary compact-button" disabled={planButtonDisabled("pro")} onClick={() => setPendingPlan("pro")} title={planButtonTitle("pro")} type="button">{planButtonLabel("pro")}</button>
                <button className="secondary compact-button" disabled={planButtonDisabled("premium")} onClick={() => setPendingPlan("premium")} title={planButtonTitle("premium")} type="button">{planButtonLabel("premium")}</button>
                <button className="secondary compact-button" disabled={planButtonDisabled("free")} onClick={() => setPendingPlan("free")} title={planButtonTitle("free")} type="button">{planButtonLabel("free")}</button>
                <button className="ghost compact-button billing-cancel" disabled={!canCancelBilling} onClick={onCancelBilling} title={cancelTitle} type="button">Cancel subscription</button>
              </div>
            ) : null}
            {canManageOrg && pendingPlan ? (
              <div className="billing-confirm" role="region" aria-label="Confirm plan change">
                <strong>
                  {PLAN_RANK[pendingPlan] < (PLAN_RANK[orgPlanTier as "free" | "pro" | "premium"] ?? 0)
                    ? `Downgrade to ${planDisplayName(pendingPlan)}${pendingPlan === "free" ? "" : ` · ${PLAN_CONFIRM_SUMMARY[pendingPlan].price}`}`
                    : `Change plan to ${planDisplayName(pendingPlan)} · ${PLAN_CONFIRM_SUMMARY[pendingPlan].price}`}
                </strong>
                <p>{PLAN_CONFIRM_SUMMARY[pendingPlan].note}</p>
                <div className="admin-form-row">
                  <button
                    className="primary-button compact-button"
                    disabled={adminBusy}
                    onClick={() => {
                      const plan = pendingPlan;
                      setPendingPlan(null);
                      onChangeBillingPlan(plan);
                    }}
                    type="button"
                  >
                    {pendingPlan === "free" ? "Confirm downgrade" : "Continue to Stripe checkout"}
                  </button>
                  <button className="ghost compact-button" disabled={adminBusy} onClick={() => setPendingPlan(null)} type="button">Keep current plan</button>
                </div>
              </div>
            ) : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><UserPlus size={15} /> Seats</h2></div>
          <div className="panel-body admin-stack">
            {canManageOrg ? (
              <form
                className="admin-form-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!adminBusy && inviteEmail.trim()) onInviteSeat();
                }}
              >
                <input aria-label="Invite email" autoComplete="email" name="invite-email" onChange={(event) => onInviteEmail(event.target.value)} placeholder="teammate@example.com" type="email" value={inviteEmail} />
                <CustomSelect
                  id="seat-role"
                  label="Role"
                  onChange={onInviteRole}
                  options={[
                    { value: "member", label: "Write/read" },
                    { value: "admin", label: "Admin" },
                    { value: "viewer", label: "Read only" },
                  ]}
                  value={inviteRole}
                />
                <button className="primary-button" disabled={adminBusy || !inviteEmail.trim()} type="submit"><UserPlus size={14} /> Invite</button>
              </form>
            ) : null}
            <div className="admin-list">
              {seats.map((seat) => (
                <div className="api-row" key={seat.membership.id}>
                  <span>{seat.membership.status}</span>
                  <strong>{seat.user.primary_email}</strong>
                  <code>{roleLabel(seat.membership.role)}</code>
                </div>
              ))}
              {visibleInvitations.map((invitation) => (
                <div className="api-row" key={invitation.id}>
                  <span>{inviteStatusLabel(invitation)}</span>
                  <strong>
                    {invitation.email}
                    <small>Expires {formatInviteDate(invitation.expires_at)}</small>
                  </strong>
                  <code>{roleLabel(invitation.role)}</code>
                  {canManageOrg && invitation.status === "pending" ? (
                    <>
                      {invitationLinks[invitation.id] ? (
                        <>
                          <button aria-label="Copy invitation link" className="ghost icon-only" disabled={adminBusy} onClick={() => onCopyInvitationLink(invitation.id)} title="Copy invitation link" type="button"><Copy size={14} /></button>
                          <button aria-label="Open invitation link" className="ghost icon-only" disabled={adminBusy} onClick={() => onOpenInvitationLink(invitation.id)} title="Open invitation link" type="button"><ExternalLink size={14} /></button>
                        </>
                      ) : null}
                      <button aria-label="Resend invitation" className="ghost icon-only" disabled={adminBusy} onClick={() => onResendInvitation(invitation.id)} title="Resend invitation" type="button"><RefreshCw size={14} /></button>
                      <button aria-label="Revoke invitation" className="ghost icon-only" disabled={adminBusy} onClick={() => onRevokeInvitation(invitation.id)} title="Revoke invitation" type="button"><X size={14} /></button>
                    </>
                  ) : null}
                </div>
              ))}
              {!seats.length && !visibleInvitations.length ? <p className="empty">No seats loaded.</p> : null}
              {!canManageOrg ? <p className="empty">Seat management is available to workspace admins.</p> : null}
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Settings size={15} /> Workspace</h2></div>
          <div className="panel-body settings-list">
            {/* Transient filter/selection state is visible in the filter bar
             * itself; echoing it here read as debug output (audit ST1). */}
            <SettingRow label="Organization" value={orgName || "Workspace"} />
            <SettingRow label="Plan tier" value={orgPlanTier || "free"} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Gauge size={15} /> Defaults</h2></div>
          <div className="panel-body settings-list">
            <CustomSelect
              className="full"
              disabled={!metricOptionsForControls.length}
              id="settings-metric-select"
              label="Default metric"
              onChange={onMetricKey}
              options={metricOptionsForControls.length ? metricOptionsForControls.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
              value={metricOptionsForControls.length ? metricKey : ""}
            />
            <CustomSelect
              className="full"
              id="settings-x-mode"
              label="X axis"
              onChange={onXMode}
              options={[
                { value: "step", label: "Step" },
                { value: "time", label: "Logged time" },
              ]}
              value={xMode}
            />
            <SettingRow label="Summary row limit" value="100" />
            <SettingRow label="Metric point limit" value="1,000 per selected run" />
          </div>
        </section>
      </div>
    </>
  );
}
