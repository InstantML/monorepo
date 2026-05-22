import { AlertTriangle, Copy, CreditCard, ExternalLink, Gauge, RefreshCw, Settings, UserPlus, X } from "lucide-react";

import { CustomSelect } from "../ui/select";
import { MetricCard } from "../ui/metric-card";
import { PageHead } from "../ui/page-head";
import { SettingRow } from "./setting-row";
import { formatNumber } from "../../../src/state.js";
import type { components } from "../../../src/types/api.generated";

type SeatRow = components["schemas"]["SeatRow"];
type InvitationRow = components["schemas"]["PublicInvitationRow"];

type UsageWarning = { code?: string; message?: string };
type BillingStatus = {
  access_state?: string;
  effective_plan_tier?: string;
  subscription_status?: string | null;
  cancel_at_period_end?: boolean;
  message?: string | null;
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
  usageResetLabel: string;
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
  usageResetLabel,
  xMode,
  billingStatus,
}: Props) {
  const billingState = billingStatus?.access_state ?? "free_active";
  const visibleInvitations = invitations.filter((invitation) => invitation.status !== "accepted");
  return (
    <>
      <PageHead eyebrow={canManageOrg ? "Admin" : "Workspace"} title="Workspace" emphasis="settings" lede={`${activePlan} · usage · seats`} />
      <div className="tab-grid settings-grid">
        <section className="panel">
          <div className="panel-head">
            <h2><Gauge size={15} /> Plan Usage</h2>
            <button className="ghost" disabled={adminBusy} onClick={onLoadOrgSettings} type="button"><RefreshCw size={14} /> Refresh</button>
          </div>
          <div className="panel-body insight-stack">
            <MetricCard label="Plan" value={activePlan} tone="good" />
            <MetricCard label="Seats" value={`${formatNumber(reservedSeatCount, 0)} / ${formatNumber(activeLimitIncludedSeats, 0)}`} tone="neutral" />
            <MetricCard label="Storage" value={`${formatBytes(storageUsed)} / ${storageLimit ? formatBytes(storageLimit) : "-"}`} tone={storagePercent > 90 ? "bad" : storagePercent > 70 ? "live" : "neutral"} />
            <div className="usage-meter" aria-label="Storage usage">
              <span style={{ width: `${storagePercent}%` }} />
            </div>
            <MetricCard label="Metric points this month" value={`${formatNumber(metricUsed, 0)} / ${metricLimit ? formatNumber(metricLimit, 0) : "-"}`} tone={metricPercent > 90 ? "bad" : metricPercent > 70 ? "live" : "neutral"} />
            <div className="usage-meter" aria-label="Metric point usage">
              <span style={{ width: `${metricPercent}%` }} />
            </div>
            <SettingRow label="Metric reset" value={usageResetLabel ? `${usageResetLabel} UTC` : "-"} />
            {activeUsageWarnings.length ? (
              <div className="admin-alert-list">
                {activeUsageWarnings.map((warning, index) => (
                  <div className="api-row" key={`${warning.code ?? "warning"}-${index}`}>
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
            <SettingRow label="Subscription" value={billingStatus?.subscription_status ?? "none"} />
            <SettingRow label="Effective plan" value={billingStatus?.effective_plan_tier ?? orgPlanTier ?? "free"} />
            {billingStatus?.message ? (
              <div className="api-row">
                <AlertTriangle size={14} />
                <strong>{billingStatus.message}</strong>
              </div>
            ) : null}
            {canManageOrg ? (
              <div className="admin-form-row">
                <button className="ghost" disabled={adminBusy} onClick={onOpenBillingPortal} type="button"><CreditCard size={14} /> Portal</button>
                <button className="ghost" disabled={adminBusy || orgPlanTier === "pro"} onClick={() => onChangeBillingPlan("pro")} type="button">Pro</button>
                <button className="ghost" disabled={adminBusy || orgPlanTier === "premium"} onClick={() => onChangeBillingPlan("premium")} type="button">Premium</button>
                <button className="ghost" disabled={adminBusy || orgPlanTier === "free"} onClick={() => onChangeBillingPlan("free")} type="button">Free</button>
                <button className="ghost" disabled={adminBusy || !billingStatus?.subscription_status} onClick={onCancelBilling} type="button">Cancel</button>
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
                    { value: "member", label: "Member" },
                    { value: "admin", label: "Admin" },
                    { value: "viewer", label: "Viewer" },
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
                  <code>{seat.membership.role}</code>
                </div>
              ))}
              {visibleInvitations.map((invitation) => (
                <div className="api-row" key={invitation.id}>
                  <span>{inviteStatusLabel(invitation)}</span>
                  <strong>
                    {invitation.email}
                    <small>Expires {formatInviteDate(invitation.expires_at)}</small>
                  </strong>
                  <code>{invitation.role}</code>
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
            <SettingRow label="Organization" value={orgName || "Workspace"} />
            <SettingRow label="Plan tier" value={orgPlanTier || "free"} />
            <SettingRow label="Project filter" value={project || "All projects"} />
            <SettingRow label="Status filter" value={status || "All statuses"} />
            <SettingRow label="Selected runs" value={formatNumber(selectedRunCount, 0)} />
            <SettingRow label="API route mode" value="Same-origin proxy" />
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
