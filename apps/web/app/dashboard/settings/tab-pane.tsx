import { AlertTriangle, Gauge, RefreshCw, Settings, UserPlus } from "lucide-react";

import { CustomSelect } from "../ui/select";
import { MetricCard } from "../ui/metric-card";
import { PageHead } from "../ui/page-head";
import { SettingRow } from "./setting-row";
import { formatNumber } from "../../../src/state.js";
import type { components } from "../../../src/types/api.generated";

type SeatRow = components["schemas"]["SeatRow"];

type UsageWarning = { code?: string; message?: string };

type Props = {
  activeLimitIncludedSeats: number;
  activePlan: string;
  activeUsageWarnings: UsageWarning[];
  adminBusy: boolean;
  formatBytes: (n: number) => string;
  inviteEmail: string;
  inviteRole: string;
  metricKey: string;
  metricOptionsForControls: string[];
  metricPercent: number;
  metricUsed: number;
  metricLimit: number;
  onInviteEmail: (email: string) => void;
  onInviteRole: (role: string) => void;
  onInviteSeat: () => void;
  onLoadOrgSettings: () => void;
  onMetricKey: (key: string) => void;
  onXMode: (mode: string) => void;
  orgName: string;
  orgPlanTier: string;
  project: string;
  seats: SeatRow[];
  selectedRunCount: number;
  status: string;
  storagePercent: number;
  storageUsed: number;
  storageLimit: number;
  usageResetLabel: string;
  xMode: string;
};

export function SettingsTabPane({
  activeLimitIncludedSeats,
  activePlan,
  activeUsageWarnings,
  adminBusy,
  formatBytes,
  inviteEmail,
  inviteRole,
  metricKey,
  metricOptionsForControls,
  metricPercent,
  metricUsed,
  metricLimit,
  onInviteEmail,
  onInviteRole,
  onInviteSeat,
  onLoadOrgSettings,
  onMetricKey,
  onXMode,
  orgName,
  orgPlanTier,
  project,
  seats,
  selectedRunCount,
  status,
  storagePercent,
  storageUsed,
  storageLimit,
  usageResetLabel,
  xMode,
}: Props) {
  return (
    <>
      <PageHead eyebrow="Admin" title="Workspace" emphasis="settings" lede={`${activePlan} · usage · seats`} />
      <div className="tab-grid settings-grid">
        <section className="panel">
          <div className="panel-head">
            <h2><Gauge size={15} /> Plan Usage</h2>
            <button className="ghost" disabled={adminBusy} onClick={onLoadOrgSettings} type="button"><RefreshCw size={14} /> Refresh</button>
          </div>
          <div className="panel-body insight-stack">
            <MetricCard label="Plan" value={activePlan} tone="good" />
            <MetricCard label="Seats" value={`${formatNumber(seats.length, 0)} / ${formatNumber(activeLimitIncludedSeats, 0)}`} tone="neutral" />
            <MetricCard label="Warehouse data" value={`${formatBytes(storageUsed)} / ${storageLimit ? formatBytes(storageLimit) : "-"}`} tone={storagePercent > 90 ? "bad" : storagePercent > 70 ? "live" : "neutral"} />
            <div className="usage-meter" aria-label="Warehouse data usage">
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
          <div className="panel-head"><h2><UserPlus size={15} /> Seats</h2></div>
          <div className="panel-body admin-stack">
            <div className="admin-form-row">
              <input aria-label="Invite email" onChange={(event) => onInviteEmail(event.target.value)} placeholder="teammate@example.com" type="email" value={inviteEmail} />
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
              <button className="primary-button" disabled={adminBusy || !inviteEmail.trim()} onClick={onInviteSeat} type="button"><UserPlus size={14} /> Invite</button>
            </div>
            <div className="admin-list">
              {seats.map((seat) => (
                <div className="api-row" key={seat.membership.id}>
                  <span>{seat.membership.status}</span>
                  <strong>{seat.user.primary_email}</strong>
                  <code>{seat.membership.role}</code>
                </div>
              ))}
              {!seats.length ? <p className="empty">No seats loaded.</p> : null}
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
