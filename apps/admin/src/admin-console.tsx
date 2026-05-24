"use client";

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Building2,
  Database,
  KeyRound,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type {
  AdminApiKey,
  AdminOrganization,
  AdminOverview,
  AdminRisk,
  AdminUser,
} from "./admin-data";
import {
  clampPercent,
  formatBytes,
  formatDate,
  formatNumber,
  formatRelativeTime,
  statusLabel,
  storageLine,
  toneForStatus,
} from "./view-model.mjs";

type Section = "overview" | "users" | "orgs" | "storage" | "apiKeys" | "risk";

type AdminConsoleProps = {
  overview: AdminOverview;
  environment: string;
  apiBase: string;
  query: string;
};

const navItems: Array<{ id: Section; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "users", label: "Users", icon: UsersRound },
  { id: "orgs", label: "Orgs", icon: Building2 },
  { id: "storage", label: "Storage", icon: Database },
  { id: "apiKeys", label: "API Keys", icon: KeyRound },
  { id: "risk", label: "Risk", icon: AlertTriangle },
];

export function AdminConsole({ overview, environment, apiBase, query }: AdminConsoleProps) {
  const [section, setSection] = useState<Section>("overview");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(
    overview.organizations[0]?.id ?? null,
  );
  const selectedOrg = useMemo(
    () =>
      overview.organizations.find((org) => org.id === selectedOrgId) ??
      overview.organizations[0] ??
      null,
    [overview.organizations, selectedOrgId],
  );

  return (
    <main className="admin-shell">
      <aside className="side-rail" aria-label="Admin navigation">
        <div className="rail-brand">
          <span className="brand-mark">IM</span>
          <div>
            <strong>InstantML</strong>
            <span>Admin</span>
          </div>
        </div>
        <nav className="rail-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={section === item.id ? "active" : ""}
                onClick={() => setSection(item.id)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="admin-main">
        <header className="topbar">
          <div>
            <p>{environment}</p>
            <h1>Operator overview</h1>
          </div>
          <form className="search-form" action="/" role="search">
            <Search size={16} aria-hidden="true" />
            <input name="q" defaultValue={query} placeholder="Search users, orgs, keys" />
            <button type="submit">Search</button>
          </form>
          <a className="icon-action" href={`/${query ? `?q=${encodeURIComponent(query)}` : ""}`}>
            <RefreshCw size={16} aria-hidden="true" />
            <span>Refresh</span>
          </a>
          <div className="operator-pill">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Read-only</span>
          </div>
        </header>

        <div className="meta-row">
          <span>API {apiBase}</span>
          <span>Generated {formatDate(overview.generated_at)}</span>
          <span>{overview.data_counts_available ? "Data counts live" : "Control plane only"}</span>
        </div>

        <KpiStrip overview={overview} />

        <div className="content-grid">
          <section className="work-area">
            {section === "overview" && (
              <>
                <OrgTable
                  organizations={overview.organizations}
                  selectedOrg={selectedOrg}
                  onSelect={setSelectedOrgId}
                />
                <UserTable users={overview.users.slice(0, 6)} compact />
              </>
            )}
            {section === "users" && <UserTable users={overview.users} />}
            {section === "orgs" && (
              <OrgTable
                organizations={overview.organizations}
                selectedOrg={selectedOrg}
                onSelect={setSelectedOrgId}
                expanded
              />
            )}
            {section === "storage" && (
              <StorageQueue organizations={overview.organizations} onSelect={setSelectedOrgId} />
            )}
            {section === "apiKeys" && <ApiKeyTable keys={overview.api_keys} />}
            {section === "risk" && <RiskQueue risks={overview.risks} onSelect={setSelectedOrgId} />}
          </section>

          <OrgDetail org={selectedOrg} />
        </div>
      </section>
    </main>
  );
}

function KpiStrip({ overview }: { overview: AdminOverview }) {
  const items = [
    {
      label: "Users",
      value: overview.totals.users,
      sub: `${formatNumber(overview.totals.active_memberships)} active seats`,
      tone: "good",
    },
    {
      label: "Organizations",
      value: overview.totals.organizations,
      sub: `${formatNumber(overview.totals.pending_invitations)} pending invites`,
      tone: "good",
    },
    {
      label: "Active keys",
      value: overview.totals.active_api_keys,
      sub: `${formatNumber(overview.totals.revoked_api_keys)} revoked`,
      tone: overview.totals.active_api_keys > 0 ? "good" : "muted",
    },
    {
      label: "Storage issues",
      value: overview.totals.storage_unconfigured_orgs + overview.totals.storage_locked_orgs,
      sub: `${formatNumber(overview.totals.storage_ready_orgs)} ready orgs`,
      tone:
        overview.totals.storage_unconfigured_orgs + overview.totals.storage_locked_orgs > 0
          ? "warn"
          : "good",
    },
    {
      label: "Risk queue",
      value: overview.totals.risk_items,
      sub: `${formatNumber(overview.totals.billing_read_only_orgs)} billing read-only`,
      tone: overview.totals.risk_items > 0 ? "danger" : "good",
    },
  ];
  return (
    <section className="kpi-strip" aria-label="Admin totals">
      {items.map((item) => (
        <article key={item.label} className={`kpi-card tone-${item.tone}`}>
          <span>{item.label}</span>
          <strong>{formatNumber(item.value)}</strong>
          <small>{item.sub}</small>
        </article>
      ))}
    </section>
  );
}

function OrgTable({
  organizations,
  selectedOrg,
  onSelect,
  expanded = false,
}: {
  organizations: AdminOrganization[];
  selectedOrg: AdminOrganization | null;
  onSelect: (id: string) => void;
  expanded?: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Organization health</h2>
        <span>{formatNumber(organizations.length)} shown</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Org</th>
              <th>Plan</th>
              <th>Storage</th>
              <th>Keys</th>
              <th>Seats</th>
              {expanded && <th>Runs</th>}
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {organizations.map((org) => (
              <tr
                key={org.id}
                className={selectedOrg?.id === org.id ? "selected-row" : ""}
                onClick={() => onSelect(org.id)}
              >
                <td>
                  <button type="button" className="row-button" onClick={() => onSelect(org.id)}>
                    <strong>{org.name}</strong>
                    <span>{org.slug}</span>
                  </button>
                </td>
                <td>{org.plan_tier}</td>
                <td>
                  <StatusDot status={org.storage.storage_state} />
                </td>
                <td>{formatNumber(org.counts.active_api_keys)}</td>
                <td>
                  {formatNumber(org.counts.active_members + org.counts.pending_invitations)} /{" "}
                  {formatNumber(org.seat_limit)}
                </td>
                {expanded && <td>{formatNumber(org.counts.runs ?? 0)}</td>}
                <td>
                  <StatusDot status={org.risk_level} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserTable({ users, compact = false }: { users: AdminUser[]; compact?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>User activity</h2>
        <span>{formatNumber(users.length)} shown</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Status</th>
              <th>Orgs</th>
              <th>Last seen</th>
              {!compact && <th>Created</th>}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.display_name ?? user.primary_email}</strong>
                  <span>{user.primary_email}</span>
                </td>
                <td>
                  <StatusDot status={user.status} />
                </td>
                <td>{formatNumber(user.active_memberships)}</td>
                <td>{formatRelativeTime(user.last_seen_at)}</td>
                {!compact && <td>{formatDate(user.created_at)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StorageQueue({
  organizations,
  onSelect,
}: {
  organizations: AdminOrganization[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Storage posture</h2>
        <span>{formatNumber(organizations.length)} orgs</span>
      </div>
      <div className="queue-list">
        {organizations.map((org) => (
          <button key={org.id} type="button" className="queue-row" onClick={() => onSelect(org.id)}>
            <span>
              <strong>{org.name}</strong>
              <small>{storageLine(org.storage)}</small>
            </span>
            <StatusDot status={org.storage.route_status ?? org.storage.storage_state} />
          </button>
        ))}
      </div>
    </section>
  );
}

function ApiKeyTable({ keys }: { keys: AdminApiKey[] }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>API key inventory</h2>
        <span>{formatNumber(keys.length)} shown</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Org</th>
              <th>Scopes</th>
              <th>Status</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <strong>{key.name}</strong>
                  <span>{key.key_prefix}</span>
                </td>
                <td>{key.org_name}</td>
                <td>{key.scopes.join(", ")}</td>
                <td>
                  <StatusDot status={key.status} />
                </td>
                <td>{formatRelativeTime(key.last_used_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RiskQueue({
  risks,
  onSelect,
}: {
  risks: AdminRisk[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Risk queue</h2>
        <span>{formatNumber(risks.length)} open</span>
      </div>
      <div className="queue-list">
        {risks.map((risk) => (
          <button
            key={risk.id}
            type="button"
            className="queue-row"
            onClick={() => risk.target_type === "organization" && onSelect(risk.target_id)}
          >
            <span>
              <strong>{risk.target_label}</strong>
              <small>{risk.message}</small>
            </span>
            <StatusDot status={risk.severity} />
          </button>
        ))}
      </div>
    </section>
  );
}

function OrgDetail({ org }: { org: AdminOrganization | null }) {
  if (!org) {
    return (
      <aside className="detail-panel">
        <h2>No organization</h2>
      </aside>
    );
  }
  return (
    <aside className="detail-panel">
      <div className="detail-heading">
        <div>
          <p>{org.slug}</p>
          <h2>{org.name}</h2>
        </div>
        <StatusDot status={org.risk_level} />
      </div>

      <dl className="detail-list">
        <div>
          <dt>Plan</dt>
          <dd>{org.plan_tier}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{org.owner?.primary_email ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Seats</dt>
          <dd>
            {formatNumber(org.counts.active_members + org.counts.pending_invitations)} /{" "}
            {formatNumber(org.seat_limit)}
          </dd>
        </div>
        <div>
          <dt>Storage</dt>
          <dd>{statusLabel(org.storage.storage_state)}</dd>
        </div>
        <div>
          <dt>Tenant route</dt>
          <dd>{statusLabel(org.storage.route_status ?? "missing")}</dd>
        </div>
        <div>
          <dt>API keys</dt>
          <dd>
            {formatNumber(org.counts.active_api_keys)} active,{" "}
            {formatNumber(org.counts.revoked_api_keys)} revoked
          </dd>
        </div>
      </dl>

      <section className="detail-block">
        <h3>Usage</h3>
        <div className="usage-stack">
          {org.usage.map((gauge) => (
            <div key={gauge.target} className="usage-row">
              <span>
                <strong>{statusLabel(gauge.target)}</strong>
                <small>
                  {formatNumber(gauge.current)} / {formatNumber(gauge.limit)}
                </small>
              </span>
              <div
                className={`meter tone-${toneForStatus(gauge.status)}`}
                style={{ "--value": `${clampPercent(gauge.percent)}%` } as CSSProperties}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="detail-block">
        <h3>Storage</h3>
        <p>{storageLine(org.storage)}</p>
        <p>{formatBytes(org.counts.retained_artifact_bytes)} retained artifact bytes</p>
        {org.storage.endpoint_host && <p>{org.storage.endpoint_host}</p>}
      </section>

      <section className="detail-block">
        <h3>Billing</h3>
        <p>{org.billing ? statusLabel(org.billing.access_state) : "No billing projection"}</p>
        {org.billing?.subscription_status && <p>{org.billing.subscription_status}</p>}
      </section>

      <section className="detail-block">
        <h3>Risk reasons</h3>
        <div className="risk-chip-list">
          {org.risk_reasons.length ? (
            org.risk_reasons.map((reason) => (
              <span key={reason} className={`risk-chip tone-${toneForStatus(reason.split(":")[0])}`}>
                {statusLabel(reason)}
              </span>
            ))
          ) : (
            <span className="risk-chip tone-good">ok</span>
          )}
        </div>
      </section>
    </aside>
  );
}

function StatusDot({ status }: { status: string }) {
  const tone = toneForStatus(status);
  return (
    <span className={`status-dot tone-${tone}`}>
      <i aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}
