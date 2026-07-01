"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { AlertTriangle, Copy, CreditCard, ExternalLink, Gauge, RefreshCw, Settings, SlidersHorizontal, UserPlus, X } from "lucide-react";

import { CustomSelect } from "../ui/select";
import { useFocusTrap } from "../ui/use-focus-trap";
import { SettingRow } from "./setting-row";
import { formatNumber } from "../../../src/state.js";
import { roleLabel } from "../../../src/roles.js";
import type { Tone } from "../../dashboard-types";
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

type SectionId = "usage" | "billing" | "seats" | "workspace" | "defaults";

const SECTIONS: { id: SectionId; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: "usage", label: "Plan Usage", Icon: Gauge },
  { id: "billing", label: "Billing", Icon: CreditCard },
  { id: "seats", label: "Seats", Icon: UserPlus },
  { id: "workspace", label: "Workspace", Icon: Settings },
  { id: "defaults", label: "Defaults", Icon: SlidersHorizontal },
];

type Props = {
  accountUser: { display_name?: string | null; primary_email?: string | null } | null;
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
  onMetricKey: (key: string) => void;
  onXMode: (mode: string) => void;
  onClose: () => void;
  orgName: string;
  orgPlanTier: string;
  reservedSeatCount: number;
  seats: SeatRow[];
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
  accountUser,
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
  onMetricKey,
  onXMode,
  onClose,
  orgName,
  orgPlanTier,
  reservedSeatCount,
  seats,
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
  // Which settings section the modal's internal nav is showing.
  const [section, setSection] = useState<SectionId>("usage");
  // Play the exit fade before the parent unmounts us: flip to `closing` (which
  // runs the reverse animation) and defer the real onClose until it finishes.
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestClose = useCallback(() => {
    setClosing((wasClosing) => {
      if (!wasClosing) closeTimer.current = setTimeout(onClose, 200);
      return true;
    });
  }, [onClose]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const dialogRef = useFocusTrap<HTMLDivElement>(
    true,
    requestClose,
    "button[aria-label='Close workspace settings']",
    "[data-settings-trigger='true']",
  );
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
  // Quota pressure → value/meter tint: quiet under 70%, amber by 70%, red by 90%.
  const usageTone = (percent: number): Tone => (canManageOrg && percent > 90 ? "bad" : canManageOrg && percent > 70 ? "live" : "neutral");
  const storageTone = usageTone(storagePercent);
  const metricTone = usageTone(metricPercent);
  const apiRequestTone = usageTone(apiRequestsPercent);
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
  const activeSection = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];
  // Settings is reached from the profile menu, not the left nav, so it presents as
  // a centered modal (like the account/profile surface) rather than a data tab. An
  // internal nav swaps one section into the pane at a time, so nothing is spread
  // across columns.
  return (
    <div
      className={`workspace-modal settings-modal${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Workspace settings"
      ref={dialogRef}
      tabIndex={-1}
      onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <div className="settings-modal-card">
        <button className="icon-button settings-modal-close" type="button" aria-label="Close workspace settings" onClick={requestClose}><X size={16} /></button>
        <nav className="settings-nav" aria-label="Settings sections">
          <span className="settings-nav-title">Settings</span>
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-item ${section === id ? "active" : ""}`}
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          <div className="settings-pane-head">
            <h2>{activeSection.label}</h2>
          </div>
          <div className="settings-pane-body settings-grid">
            {section === "usage" ? (
          <div className="settings-list">
            <SettingRow label="Plan" value={activePlan} tone="good" />
            <SettingRow label="Seats" value={`${formatNumber(reservedSeatCount, 0)} / ${formatNumber(activeLimitIncludedSeats, 0)}`} />
            <div className="usage-row">
              <SettingRow label={storageUsageLabel} value={storageUsageValue} tone={storageTone} />
              <div className={`usage-meter tone-${storageTone}`} aria-label={`${storageUsageLabel} usage`}>
                <span style={{ width: `${storageMeterPercent}%` }} />
              </div>
            </div>
            <div className="usage-row">
              <SettingRow label="Metric points this month" value={metricUsageValue} tone={metricTone} />
              <div className={`usage-meter tone-${metricTone}`} aria-label="Metric point usage">
                <span style={{ width: `${metricMeterPercent}%` }} />
              </div>
            </div>
            <div className="usage-row">
              <SettingRow label="API requests this month" value={apiRequestUsageValue} tone={apiRequestTone} />
              <div className={`usage-meter tone-${apiRequestTone}`} aria-label="API request usage">
                <span style={{ width: `${apiRequestMeterPercent}%` }} />
              </div>
            </div>
            <SettingRow label="General API rate" value={canManageOrg ? generalRateLimitLabel || "-" : adminOnlyValue} />
            <SettingRow label="Ingest API rate" value={canManageOrg ? ingestRateLimitLabel || "-" : adminOnlyValue} />
            <SettingRow label="Monthly reset" value={canManageOrg && usageAvailable && usageResetLabel ? `${usageResetLabel} UTC` : canManageOrg && usageAvailable ? "-" : canManageOrg ? usageUnavailableValue : adminOnlyValue} />
            {canManageOrg && storageUsageDescription ? <p className="setting-hint">{storageUsageDescription}</p> : null}
            {canManageOrg && !usageAvailable ? <p className="setting-hint">Usage reporting is not available from this local control plane.</p> : null}
            {!canManageOrg ? <p className="setting-hint">Usage reporting is available to workspace admins.</p> : null}
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
            ) : null}
            {section === "billing" ? (
          <div className="settings-list">
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
            ) : null}
            {section === "seats" ? (
          <div className="admin-stack">
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
            ) : null}
            {section === "workspace" ? (
          <div className="settings-list">
            {/* Transient filter/selection state is visible in the filter bar
             * itself; echoing it here read as debug output (audit ST1). */}
            <SettingRow label="Organization" value={orgName || "Workspace"} />
            <SettingRow label="Plan tier" value={orgPlanTier || "free"} />
            {accountUser ? (
              <>
                <SettingRow label="Signed in as" value={accountUser.display_name || accountUser.primary_email || "-"} />
                {accountUser.display_name && accountUser.primary_email ? <SettingRow label="Email" value={accountUser.primary_email} /> : null}
              </>
            ) : null}
          </div>
            ) : null}
            {section === "defaults" ? (
          <div className="settings-list">
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
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
