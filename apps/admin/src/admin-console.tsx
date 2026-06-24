"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
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
import { LogoMark } from "./logo-mark";

type Section = "overview" | "users" | "orgs" | "storage" | "apiKeys" | "risk";

type AdminUserOrg = AdminUser["orgs"][number];

const PLAN_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "free", label: "Free" },
  { id: "pro", label: "Pro" },
  { id: "premium", label: "Premium" },
];

// Older orgs may store legacy plan aliases; map them to the selectable tiers.
function planOptionValue(planTier: string): string {
  const normalized = planTier.trim().toLowerCase();
  if (normalized === "pro" || normalized === "lab" || normalized === "startup") return "pro";
  if (normalized === "premium" || normalized === "growth") return "premium";
  return "free";
}

type AdminConsoleProps = {
  overview: AdminOverview;
  environment: string;
  apiBase: string;
  query: string;
  viewer: {
    email: string;
    name: string | null;
  };
};

const navItems: Array<{ id: Section; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "users", label: "Users", icon: UsersRound },
  { id: "orgs", label: "Orgs", icon: Building2 },
  { id: "storage", label: "Storage", icon: Database },
  { id: "apiKeys", label: "API Keys", icon: KeyRound },
  { id: "risk", label: "Risk", icon: AlertTriangle },
];

export function AdminConsole({ overview, environment, apiBase, query, viewer }: AdminConsoleProps) {
  const [data, setData] = useState<AdminOverview>(overview);
  const [section, setSection] = useState<Section>("overview");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(
    overview.organizations[0]?.id ?? null,
  );
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const selectedOrg = useMemo(
    () =>
      data.organizations.find((org) => org.id === selectedOrgId) ??
      data.organizations[0] ??
      null,
    [data.organizations, selectedOrgId],
  );
  const selectedUser = useMemo(
    () => data.users.find((user) => user.id === selectedUserId) ?? null,
    [data.users, selectedUserId],
  );

  const selectOrg = (id: string) => {
    setSelectedOrgId(id);
    setSelectedUserId(null);
  };

  // Apply an operator plan change, then patch the affected org into local state
  // so the org table, detail panels, and every user's membership stay in sync.
  const applyPlan = async (orgId: string, planTier: string) => {
    const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_tier: planTier }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { org?: AdminOrganization; message?: string }
      | null;
    if (!response.ok || !payload?.org) {
      throw new Error(payload?.message ?? `Plan change failed (${response.status}).`);
    }
    const updated = payload.org;
    setData((prev) => ({
      ...prev,
      organizations: prev.organizations.map((org) => (org.id === updated.id ? updated : org)),
      users: prev.users.map((user) => ({
        ...user,
        orgs: user.orgs.map((membership) =>
          membership.org_id === updated.id
            ? { ...membership, plan_tier: updated.plan_tier }
            : membership,
        ),
      })),
    }));
  };

  return (
    <main className="admin-shell">
      <aside className="side-rail" aria-label="Admin navigation">
        <div className="rail-brand">
          <span className="brand-mark">
            <LogoMark />
          </span>
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
            <input aria-label="Search users, orgs, keys" name="q" defaultValue={query} placeholder="Search users, orgs, keys" />
            <button type="submit">Search</button>
          </form>
          <a className="icon-action" href={`/${query ? `?q=${encodeURIComponent(query)}` : ""}`}>
            <RefreshCw size={16} aria-hidden="true" />
            <span>Refresh</span>
          </a>
          <div className="operator-pill">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{viewer.name ?? viewer.email}</span>
          </div>
        </header>

        <div className="meta-row">
          <span>API {apiBase}</span>
          <span>Generated {formatDate(data.generated_at)}</span>
          <span>{data.data_counts_available ? "Data counts live" : "Control plane only"}</span>
          <span>Operator {viewer.email}</span>
        </div>

        <KpiStrip overview={data} />

        <div className="content-grid">
          <section className="work-area">
            {section === "overview" && (
              <>
                <OrgTable
                  organizations={data.organizations}
                  selectedOrg={selectedOrg}
                  onSelect={selectOrg}
                />
                <UserTable
                  users={data.users.slice(0, 6)}
                  selectedUserId={selectedUserId}
                  onSelect={setSelectedUserId}
                  compact
                />
              </>
            )}
            {section === "users" && (
              <UserTable
                users={data.users}
                selectedUserId={selectedUserId}
                onSelect={setSelectedUserId}
              />
            )}
            {section === "orgs" && (
              <OrgTable
                organizations={data.organizations}
                selectedOrg={selectedOrg}
                onSelect={selectOrg}
                expanded
              />
            )}
            {section === "storage" && (
              <StorageQueue organizations={data.organizations} onSelect={selectOrg} />
            )}
            {section === "apiKeys" && <ApiKeyTable keys={data.api_keys} />}
            {section === "risk" && <RiskQueue risks={data.risks} onSelect={selectOrg} />}
          </section>

          {selectedUser ? (
            <UserDetail user={selectedUser} onApplyPlan={applyPlan} />
          ) : (
            <OrgDetail org={selectedOrg} />
          )}
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

function UserTable({
  users,
  selectedUserId,
  onSelect,
  compact = false,
}: {
  users: AdminUser[];
  selectedUserId: string | null;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
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
              <tr
                key={user.id}
                className={selectedUserId === user.id ? "selected-row" : ""}
                onClick={() => onSelect(user.id)}
              >
                <td>
                  <button type="button" className="row-button" onClick={() => onSelect(user.id)}>
                    <strong>{user.display_name ?? user.primary_email}</strong>
                    <span>{user.primary_email}</span>
                  </button>
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

function UserDetail({
  user,
  onApplyPlan,
}: {
  user: AdminUser;
  onApplyPlan: (orgId: string, planTier: string) => Promise<void>;
}) {
  return (
    <aside className="detail-panel">
      <div className="detail-heading">
        <div>
          <p>{user.primary_email}</p>
          <h2>{user.display_name ?? user.primary_email}</h2>
        </div>
        <StatusDot status={user.status} />
      </div>

      <dl className="detail-list">
        <div>
          <dt>Status</dt>
          <dd>{statusLabel(user.status)}</dd>
        </div>
        <div>
          <dt>Memberships</dt>
          <dd>
            {formatNumber(user.active_memberships)} active, {formatNumber(user.invited_memberships)}{" "}
            invited
          </dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{formatRelativeTime(user.last_seen_at)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(user.created_at)}</dd>
        </div>
        <div>
          <dt>User ID</dt>
          <dd>{user.id}</dd>
        </div>
      </dl>

      <section className="detail-block">
        <h3>Plans</h3>
        {user.orgs.length ? (
          <div className="plan-list">
            {user.orgs.map((membership) => (
              <PlanMembershipRow
                key={membership.org_id}
                membership={membership}
                onApply={onApplyPlan}
              />
            ))}
          </div>
        ) : (
          <p>No organization memberships.</p>
        )}
      </section>
    </aside>
  );
}

function PlanMembershipRow({
  membership,
  onApply,
}: {
  membership: AdminUserOrg;
  onApply: (orgId: string, planTier: string) => Promise<void>;
}) {
  const currentPlan = planOptionValue(membership.plan_tier);
  const [plan, setPlan] = useState(currentPlan);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: string; text: string } | null>(null);

  // Re-sync the selector after a successful apply updates the membership prop,
  // or when switching between users in the detail panel.
  useEffect(() => {
    setPlan(planOptionValue(membership.plan_tier));
    setStatus(null);
  }, [membership.plan_tier, membership.org_id]);

  const dirty = plan !== currentPlan;

  const submit = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await onApply(membership.org_id, plan);
      setStatus({ tone: "good", text: "Plan updated." });
    } catch (error) {
      setStatus({
        tone: "danger",
        text: error instanceof Error ? error.message : "Plan change failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-row">
      <div className="plan-row-head">
        <span>
          <strong>{membership.org_name}</strong>
          <small>
            {statusLabel(membership.role)} · {statusLabel(membership.status)}
          </small>
        </span>
        <span className="plan-badge">{statusLabel(membership.plan_tier)}</span>
      </div>
      <div className="plan-row-controls">
        <select
          value={plan}
          onChange={(event) => setPlan(event.target.value)}
          disabled={busy}
          aria-label={`Plan for ${membership.org_name}`}
        >
          {PLAN_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={submit} disabled={busy || !dirty}>
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>
      {status && <p className={`plan-row-status tone-${status.tone}`}>{status.text}</p>}
    </div>
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
