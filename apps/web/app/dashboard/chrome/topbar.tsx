"use client";

import { Check, ChevronDown, CircleHelp, CreditCard, LogOut, Menu, Moon, Plus, Search, Settings, Sun, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import type { LucideIcon } from "lucide-react";

import { InstantMlMark } from "../../instantml-mark";
import { accountDisplayLabel, accountInitials, safeAccountAvatarUrl } from "../../../src/account.js";
import { roleCapabilities, roleLabel } from "../../../src/roles.js";
import { tabToPath } from "../../../src/routes.js";
import { tabs } from "../../dashboard-config";
import type { ShellTabId } from "../../dashboard-config";
import { CustomSelect } from "../ui/select";
import type { TabId } from "../../dashboard-types";
import { useFocusTrap } from "../ui/use-focus-trap";

export type OrgMembershipSummary = {
  org_id: string;
  name: string;
  slug: string;
  account_type?: string;
  is_personal?: boolean;
  plan_tier: string;
  role: string;
  role_label?: string;
  status: string;
  member_count: number;
  is_current: boolean;
  capabilities?: {
    manage_billing?: boolean;
    manage_members?: boolean;
    write_runs?: boolean;
    manage_api_keys?: boolean;
  };
};

export type CreateWorkspaceInput = {
  name: string;
  account_type: "personal" | "business";
  plan_tier: "free" | "pro" | "premium";
  storage_choice: "instantml-hosted" | "customer-clickhouse";
  initial_invitations: Array<{ email: string; role: "admin" | "member" | "viewer" }>;
  switch_on_create: boolean;
};

export type WorkspaceNameAvailability = {
  available?: boolean;
  checkedName?: string;
  slug?: string;
  message?: string;
};

const ORG_SWITCHER_SEARCH_THRESHOLD = 7;

type AccountUser = {
  primary_email?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
};

function AccountAvatar({ user }: { user: AccountUser | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const displayName = user?.display_name ?? "";
  const email = user?.primary_email ?? "";
  const label = accountDisplayLabel(displayName, email);
  const initials = accountInitials(displayName, email);
  const avatarUrl = imageFailed ? "" : safeAccountAvatarUrl(user?.avatar_url);

  useEffect(() => {
    setImageFailed(false);
  }, [user?.avatar_url]);

  return (
    <span className={`avatar ${avatarUrl ? "avatar--image" : ""}`} aria-label={`Account: ${label}`} title={label}>
      {avatarUrl ? (
        <img alt="" className="avatar-image" onError={() => setImageFailed(true)} referrerPolicy="no-referrer" src={avatarUrl} />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}

export function OrgSwitcher({
  busy,
  current,
  error,
  memberships,
  onSelect,
}: {
  busy: boolean;
  current: { id: string; name: string } | null;
  error: string;
  memberships: OrgMembershipSummary[];
  onSelect: (orgId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function closeFromOutside(event: globalThis.PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  useEffect(() => {
    if (open && memberships.length >= ORG_SWITCHER_SEARCH_THRESHOLD) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open, memberships.length]);

  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  if (memberships.length === 0) {
    if (!current?.name) return null;
    return <span className="org-switcher-label" aria-label="Workspace">{current.name}</span>;
  }

  if (memberships.length === 1) {
    const only = memberships[0];
    return <span className="org-switcher-label" aria-label="Workspace">{only.name}</span>;
  }

  const filterToken = filter.trim().toLowerCase();
  const visible = filterToken
    ? memberships.filter((m) => m.name.toLowerCase().includes(filterToken) || m.slug.toLowerCase().includes(filterToken))
    : memberships;
  const currentName = current?.name ?? memberships.find((m) => m.is_current)?.name ?? "Workspace";

  return (
    <div className="org-switcher" ref={rootRef}>
      <button
        aria-controls="org-switcher-menu"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Workspace: ${currentName}. Switch organization.`}
        className="org-switcher-trigger"
        disabled={busy}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <span className="org-switcher-name">{currentName}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="org-switcher-menu" id="org-switcher-menu" role="listbox" aria-label="Switch organization">
          {memberships.length >= ORG_SWITCHER_SEARCH_THRESHOLD ? (
            <div className="org-switcher-search">
              <Search size={13} aria-hidden="true" />
              <input
                aria-label="Filter organizations"
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter organizations"
                ref={inputRef}
                type="search"
                value={filter}
              />
            </div>
          ) : null}
          {visible.length ? (
            visible.map((membership) => (
              <button
                aria-selected={membership.is_current}
                className={`org-switcher-option ${membership.is_current ? "selected" : ""}`}
                disabled={busy || membership.is_current}
                key={membership.org_id}
                onClick={() => {
                  setOpen(false);
                  if (!membership.is_current) onSelect(membership.org_id);
                }}
                role="option"
                type="button"
              >
                <span className="org-switcher-check" aria-hidden="true">
                  {membership.is_current ? <Check size={13} /> : null}
                </span>
                <span className="org-switcher-option-body">
                  <span className="org-switcher-option-name">{membership.name}</span>
                  <span className="org-switcher-option-meta">
                    {membershipRoleLabel(membership)} · {membership.member_count} {membership.member_count === 1 ? "member" : "members"}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="org-switcher-empty">No matches.</div>
          )}
          {error ? <div className="org-switcher-error" role="alert">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function planName(tier?: string | null) {
  if (!tier) return "Free";
  return tier.slice(0, 1).toUpperCase() + tier.slice(1);
}

function membershipRoleLabel(membership: OrgMembershipSummary) {
  return membership.role_label || roleLabel(membership.role);
}

function membershipCapabilities(membership: OrgMembershipSummary | null | undefined) {
  return membership?.capabilities || roleCapabilities(membership?.role);
}

function WorkspaceCreateModal({
  memberships,
  onCheckName,
  onClose,
  onCreate,
}: {
  memberships: OrgMembershipSummary[];
  onCheckName: (name: string) => Promise<WorkspaceNameAvailability>;
  onClose: () => void;
  onCreate: (input: CreateWorkspaceInput) => Promise<void>;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, "input[name='workspace-name']");
  const [kind, setKind] = useState<"personal" | "business">("business");
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<"free" | "pro" | "premium">("free");
  const [storage, setStorage] = useState<"instantml-hosted" | "customer-clickhouse">("instantml-hosted");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [availability, setAvailability] = useState<WorkspaceNameAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasPersonal = memberships.some((membership) => membership.is_personal || membership.account_type === "personal");
  const personalBlocked = kind === "personal" && hasPersonal;
  const byocBlocked = plan !== "premium";
  const inviteDeferred = plan !== "free";
  const invitesAllowed = kind === "business" && !inviteDeferred;
  const normalizedStorage = byocBlocked ? "instantml-hosted" : storage;
  const trimmedName = name.trim();
  const nameAvailable = availability?.available === true && availability.checkedName === trimmedName;
  const availabilityStatus = !trimmedName
    ? ""
    : availability === null
      ? "Checking name..."
      : availability.slug
        ? `instantml.ai/${availability.slug}${availability.message ? ` · ${availability.message}` : ""}`
        : availability.message ?? "Name unavailable.";

  useEffect(() => {
    let cancelled = false;
    setAvailability(null);
    if (!trimmedName) return undefined;
    const checkedName = trimmedName;
    const id = window.setTimeout(() => {
      onCheckName(checkedName)
        .then((result) => {
          if (!cancelled) setAvailability({ ...result, checkedName });
        })
        .catch((checkError) => {
          if (!cancelled) {
            setAvailability({ available: false, checkedName, message: checkError instanceof Error ? checkError.message : "Unable to check this name." });
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [onCheckName, trimmedName]);

  useEffect(() => {
    if (byocBlocked && storage === "customer-clickhouse") setStorage("instantml-hosted");
  }, [byocBlocked, storage]);

  async function submit() {
    if (busy || personalBlocked || !trimmedName || !nameAvailable) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        name: trimmedName,
        account_type: kind,
        plan_tier: plan,
        storage_choice: normalizedStorage,
        initial_invitations: invitesAllowed && inviteEmail.trim() ? [{ email: inviteEmail.trim(), role: inviteRole }] : [],
        switch_on_create: true,
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unable to create workspace.");
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  return (
    <div className="workspace-modal-backdrop" role="presentation">
      <section className="workspace-create-modal" role="dialog" aria-modal="true" aria-label="Create workspace" ref={dialogRef} tabIndex={-1}>
        <div className="workspace-create-head">
          <div>
            <h2>Create workspace</h2>
            <p>Billing, seats, roles, projects, and runs belong to this workspace.</p>
          </div>
          <button className="icon-button framed" type="button" aria-label="Close create workspace" onClick={onClose}><X size={15} /></button>
        </div>
        <form className="workspace-create-form" onSubmit={handleSubmit}>
          <div className="workspace-create-body">
            <div className="workspace-segment" role="group" aria-label="Workspace type">
              <button aria-pressed={kind === "personal"} className={kind === "personal" ? "selected" : ""} type="button" onClick={() => setKind("personal")}>Personal workspace</button>
              <button aria-pressed={kind === "business"} className={kind === "business" ? "selected" : ""} type="button" onClick={() => setKind("business")}>Organization</button>
            </div>
            {personalBlocked ? <p className="form-error">You already have a personal workspace.</p> : null}
            <label className="workspace-create-field">
              {kind === "personal" ? "Workspace name" : "Organization name"}
              <input aria-label={kind === "personal" ? "Workspace name" : "Organization name"} autoFocus name="workspace-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "personal" ? "Alex's workspace" : "Acme Research"} />
            </label>
            {trimmedName ? (
              <p className={`workspace-create-status ${availability?.available === false ? "error" : ""}`} role={availability?.available === false ? "alert" : "status"}>
                {availabilityStatus}
              </p>
            ) : null}
            <div className="workspace-plan-grid" role="group" aria-label="Plan">
              {(["free", "pro", "premium"] as const).map((tier) => (
                <button aria-pressed={plan === tier} className={plan === tier ? "selected" : ""} key={tier} type="button" onClick={() => setPlan(tier)}>
                  <strong>{planName(tier)}</strong>
                  <span>{tier === "free" ? "Start small" : tier === "pro" ? "Team default" : "BYOC ready"}</span>
                </button>
              ))}
            </div>
            <div className="workspace-storage-choice" role="group" aria-label="Storage">
              <label>
                <input aria-label="InstantML-hosted storage" checked={normalizedStorage === "instantml-hosted"} name="workspace-storage" onChange={() => setStorage("instantml-hosted")} type="radio" />
                InstantML-hosted
              </label>
              <label className={byocBlocked ? "disabled" : ""}>
                <input aria-label="Customer ClickHouse storage" checked={normalizedStorage === "customer-clickhouse"} disabled={byocBlocked} name="workspace-storage" onChange={() => setStorage("customer-clickhouse")} type="radio" />
                Connect my ClickHouse
              </label>
            </div>
            {kind === "business" ? (
              <div className="workspace-invite-row">
                <label className="workspace-create-field">
                  Invite teammates
                  <input aria-label="Invite teammate email" autoComplete="email" disabled={inviteDeferred} value={inviteDeferred ? "" : inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder={inviteDeferred ? "Invite after checkout" : "teammate@example.com"} type="email" />
                </label>
                <CustomSelect
                  id="workspace-create-role"
                  label="Role"
                  disabled={inviteDeferred}
                  onChange={(value) => setInviteRole(value === "admin" || value === "viewer" ? value : "member")}
                  options={[
                    { value: "member", label: "Write/read" },
                    { value: "admin", label: "Admin" },
                    { value: "viewer", label: "Read only" },
                  ]}
                  value={inviteRole}
                />
              </div>
            ) : (
              <p className="setting-hint">Personal workspaces are single-seat. Create an organization to invite teammates.</p>
            )}
            {kind === "business" && inviteDeferred ? <p className="setting-hint">Invite teammates after checkout unlocks the workspace.</p> : null}
            {error ? <p className="form-error" role="alert">{error}</p> : null}
          </div>
          <div className="workspace-create-actions">
            <button className="ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary-button" type="submit" disabled={busy || personalBlocked || !trimmedName || !nameAvailable}>
              {busy ? "Creating" : plan === "free" ? "Create workspace" : "Continue to checkout"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function AccountWorkspaceMenu({
  accountUser,
  busy,
  current,
  error,
  memberships,
  onCheckWorkspaceName,
  onCreateWorkspace,
  onOpenBilling,
  onOpenSettings,
  onSelect,
  onSignOut,
  onToggleTheme,
  theme,
  variant = "topbar",
}: {
  accountUser: AccountUser | null;
  busy: boolean;
  current: { id: string; name: string } | null;
  error: string;
  memberships: OrgMembershipSummary[];
  onCheckWorkspaceName: (name: string) => Promise<WorkspaceNameAvailability>;
  onCreateWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
  onOpenBilling: () => void;
  onOpenSettings: () => void;
  onSelect: (orgId: string) => void;
  onSignOut: () => void;
  onToggleTheme: () => void;
  theme: "dark" | "light";
  variant?: "topbar" | "rail";
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const displayName = accountDisplayLabel(accountUser?.display_name ?? "", accountUser?.primary_email ?? "");
  const currentMembership = memberships.find((membership) => membership.is_current) ?? memberships.find((membership) => membership.org_id === current?.id) ?? null;
  const currentName = current?.name || currentMembership?.name || "Workspace";
  const currentCapabilities = membershipCapabilities(currentMembership);
  const personal = memberships.filter((membership) => membership.is_personal || membership.account_type === "personal");
  const organizations = memberships.filter((membership) => !(membership.is_personal || membership.account_type === "personal"));

  useEffect(() => {
    if (!open) return undefined;
    function closeFromOutside(event: globalThis.PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function handleKeydown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !menuRef.current) return;
      const focusable = Array.from(menuRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [open]);

  function renderMembership(membership: OrgMembershipSummary) {
    return (
      <button
        aria-current={membership.is_current ? "true" : undefined}
        className={`account-workspace-option ${membership.is_current ? "selected" : ""}`}
        disabled={busy || membership.is_current}
        key={membership.org_id}
        onClick={() => {
          setOpen(false);
          if (!membership.is_current) onSelect(membership.org_id);
        }}
        type="button"
      >
        <span className="org-switcher-check" aria-hidden="true">{membership.is_current ? <Check size={13} /> : null}</span>
        <span className="org-switcher-option-body">
          <span className="org-switcher-option-name">{membership.name}</span>
          <span className="org-switcher-option-meta">
            {membershipRoleLabel(membership)} · {planName(membership.plan_tier)} · {membership.member_count} {membership.member_count === 1 ? "member" : "members"}
          </span>
        </span>
      </button>
    );
  }

  const menuId = variant === "rail" ? "account-workspace-menu-rail" : "account-workspace-menu";
  const railUserName = (accountUser?.display_name ?? "").trim() || (accountUser?.primary_email ?? "").split("@")[0] || "account";

  return (
    <div className={`account-workspace ${variant === "rail" ? "account-workspace--rail" : ""}`} ref={rootRef}>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Account and workspace menu. Current workspace: ${currentName}.`}
        className={variant === "rail" ? "rail-foot-trigger" : "account-workspace-trigger"}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <AccountAvatar user={accountUser} />
        {variant === "rail" ? (
          <>
            <span className="rail-foot-name">{railUserName}</span>
            {currentName ? <span className="rail-foot-version">{currentName}</span> : null}
          </>
        ) : (
          <>
            <span className="account-workspace-current">{currentName}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </>
        )}
      </button>
      {open ? (
        <div className={`account-workspace-menu ${variant === "rail" ? "account-workspace-menu--rail" : ""}`} id={menuId} ref={menuRef} role="dialog" aria-label="Account and workspace">
          <div className="account-workspace-identity">
            <AccountAvatar user={accountUser} />
            <span>
              <strong>{accountUser?.display_name || accountUser?.primary_email || "Account"}</strong>
              <small>{displayName}</small>
            </span>
          </div>
          {currentMembership ? (
            <div className="account-workspace-current-card">
              <span>Current workspace</span>
              <strong>{currentMembership.name}</strong>
              <small>{membershipRoleLabel(currentMembership)} · {planName(currentMembership.plan_tier)} · {currentMembership.member_count} {currentMembership.member_count === 1 ? "member" : "members"}</small>
            </div>
          ) : null}
          <div className="account-workspace-list" aria-label="Switch workspace">
            {personal.length ? <span className="account-workspace-section">Personal</span> : null}
            {personal.map(renderMembership)}
            {organizations.length ? <span className="account-workspace-section">Organizations</span> : null}
            {organizations.map(renderMembership)}
          </div>
          {error ? <div className="org-switcher-error" role="alert">{error}</div> : null}
          <div className="account-workspace-actions">
            <button type="button" onClick={() => { setCreateOpen(true); setOpen(false); }}><Plus size={14} /> New workspace</button>
            <button type="button" onClick={() => { setOpen(false); onOpenSettings(); }}><Settings size={14} /> Workspace settings</button>
            {currentCapabilities.manage_billing ? (
              <button type="button" onClick={() => { setOpen(false); onOpenBilling(); }}><CreditCard size={14} /> Manage billing</button>
            ) : null}
            <button type="button" onClick={onToggleTheme}>
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />} {theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            </button>
            <button type="button" onClick={() => { setOpen(false); onSignOut(); }}><LogOut size={14} /> Sign out</button>
          </div>
        </div>
      ) : null}
      {createOpen ? (
        <WorkspaceCreateModal
          memberships={memberships}
          onCheckName={onCheckWorkspaceName}
          onClose={() => {
            setCreateOpen(false);
            triggerRef.current?.focus();
          }}
          onCreate={onCreateWorkspace}
        />
      ) : null}
    </div>
  );
}

export function DashboardTopbar({
  activeIcon: ActiveIcon,
  activeTab,
  accountUser,
  detailRunName,
  mobileNavOpen,
  onMobileMenuToggle,
  onProject,
  onQuickSearch,
  onCheckWorkspaceName,
  onCreateWorkspace,
  onOpenBilling,
  onOpenSettings,
  onSelectTab,
  onSignOut,
  onShortcutHelp,
  onToggleTheme,
  orgMemberships,
  theme,
  orgSwitchBusy,
  orgSwitchError,
  onSwitchOrg,
  planLabel,
  project,
  projects,
  metricUsagePercent,
  apiRequestUsagePercent,
  storageUsagePercent,
  usageAvailable,
  usageResetLabel,
  workspaceName,
  workspaceId,
}: {
  activeIcon: LucideIcon;
  activeTab: ShellTabId;
  accountUser: AccountUser | null;
  detailRunName: string;
  mobileNavOpen: boolean;
  onMobileMenuToggle: () => void;
  onProject: (project: string) => void;
  onQuickSearch: () => void;
  onCheckWorkspaceName: (name: string) => Promise<WorkspaceNameAvailability>;
  onCreateWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
  onOpenBilling: () => void;
  onOpenSettings: () => void;
  onSelectTab: (tabId: ShellTabId) => void;
  onSignOut: () => void;
  onShortcutHelp: () => void;
  onToggleTheme: () => void;
  orgMemberships: OrgMembershipSummary[];
  theme: "dark" | "light";
  orgSwitchBusy: boolean;
  orgSwitchError: string;
  onSwitchOrg: (orgId: string) => void;
  planLabel: string;
  project: string;
  projects: string[];
  metricUsagePercent: number;
  apiRequestUsagePercent: number;
  storageUsagePercent: number;
  usageAvailable: boolean;
  usageResetLabel: string;
  workspaceName: string;
  workspaceId: string;
}) {
  const topbarRef = useRef<HTMLElement>(null);
  const tabLabel = activeTab === "detail" ? "Run Detail" : tabs.find((tab) => tab.id === activeTab)?.label ?? "Runs";

  useLayoutEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(max-width: 900px)");
    let frame = 0;
    // The topbar is now a single slim row (logo + project + account/search). The
    // ResizeObserver re-syncs --topbar-height to the measured height; the fallback
    // only covers the first paint frame.
    function fallbackHeight() {
      return media.matches ? "56px" : "45px";
    }
    function syncHeight() {
      const height = topbarRef.current?.getBoundingClientRect().height;
      root.style.setProperty("--topbar-height", height && Number.isFinite(height) ? `${Math.ceil(height)}px` : fallbackHeight());
    }
    function queueSyncHeight() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncHeight);
    }
    function applyHeight() {
      root.style.setProperty("--topbar-height", fallbackHeight());
      queueSyncHeight();
    }
    const observer = new ResizeObserver(queueSyncHeight);
    if (topbarRef.current) observer.observe(topbarRef.current);
    applyHeight();
    media.addEventListener("change", applyHeight);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      media.removeEventListener("change", applyHeight);
      root.style.removeProperty("--topbar-height");
    };
  }, []);

  return (
    <header className="topbar" ref={topbarRef}>
      <div className="brandbar">
        <button
          type="button"
          className="mobile-menu-button"
          data-mobile-menu-button="true"
          aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileNavOpen}
          onClick={onMobileMenuToggle}
        >
          {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <a
          className="brand-cell"
          href={tabToPath("runs")}
          aria-label="InstantML"
          onClick={(event) => {
            event.preventDefault();
            onSelectTab("runs");
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            <InstantMlMark size={22} />
          </span>
          <span className="brand-wordmark" aria-hidden="true">
            instant<span className="brand-wordmark__accent">ml</span>
          </span>
        </a>
        {/* Project is global context (applies to every tab), so it lives in the
            topbar beside the logo and the workspace switcher. */}
        <div className="brandbar-project">
          <CustomSelect
            id="project-filter"
            label="Project"
            value={project}
            onChange={onProject}
            options={[{ value: "", label: "All projects" }, ...projects.map((item) => ({ value: item, label: item }))]}
          />
        </div>
        <div className="brandbar-row">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            {activeTab === "detail" ? (
              <>
                <a aria-label="Back to Runs" className="crumb crumb-link" href={tabToPath("runs")} onClick={(event) => { event.preventDefault(); onSelectTab("runs"); }}>Runs</a>
                <span className="sep" aria-hidden="true">/</span>
                <span className="crumb cur" aria-current="page" title={detailRunName || "Run Detail"}>{detailRunName || "Run Detail"}</span>
              </>
            ) : (
              <span className="crumb cur" aria-current="page">{tabLabel}</span>
            )}
          </nav>
          <div className="brandbar-actions">
            <PlanUsageBadge
              apiRequestPercent={apiRequestUsagePercent}
              metricPercent={metricUsagePercent}
              plan={planLabel}
              resetLabel={usageResetLabel}
              storagePercent={storageUsagePercent}
              onSelectTab={onSelectTab}
              usageAvailable={usageAvailable}
            />
            <button className="ghost-kbd" data-quick-search-trigger="true" type="button" onClick={onQuickSearch} aria-label="Quick search">
              <Search size={13} /> <span className="ghost-kbd-label">Search</span> <span className="kbd">⌘K</span>
            </button>
            <button
              aria-label="Keyboard shortcuts"
              className="icon-button framed brandbar-action-desktop"
              data-shortcut-help-trigger="true"
              onClick={onShortcutHelp}
              title="Keyboard shortcuts"
              type="button"
            >
              <CircleHelp size={15} />
            </button>
            <AccountWorkspaceMenu
              accountUser={accountUser}
              busy={orgSwitchBusy}
              current={workspaceId ? { id: workspaceId, name: workspaceName } : null}
              error={orgSwitchError}
              memberships={orgMemberships}
              onCheckWorkspaceName={onCheckWorkspaceName}
              onCreateWorkspace={onCreateWorkspace}
              onOpenBilling={onOpenBilling}
              onOpenSettings={onOpenSettings}
              onSelect={onSwitchOrg}
              onSignOut={onSignOut}
              onToggleTheme={onToggleTheme}
              theme={theme}
            />
          </div>
        </div>
      </div>

    </header>
  );
}

function PlanUsageBadge({
  apiRequestPercent,
  metricPercent,
  onSelectTab,
  plan,
  resetLabel,
  storagePercent,
  usageAvailable,
}: {
  apiRequestPercent: number;
  metricPercent: number;
  onSelectTab: (tabId: TabId) => void;
  plan: string;
  resetLabel: string;
  storagePercent: number;
  usageAvailable: boolean;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(Math.max(metricPercent, storagePercent, apiRequestPercent))));
  const tone = percent >= 100 ? "bad" : percent >= 80 ? "warn" : "ok";
  const detail = usageAvailable
    ? resetLabel ? `${percent}% used · resets ${resetLabel}` : `${percent}% used`
    : "Usage unavailable";
  return (
    <a
      className={`plan-usage-badge ${tone}`}
      href={tabToPath("settings")}
      title={`Plan usage: ${detail}`}
      onClick={(event) => {
        event.preventDefault();
        onSelectTab("settings");
      }}
    >
      <span className="plan-usage-ring" style={{ "--plan-usage-percent": `${percent}%` } as CSSProperties} aria-hidden="true" />
      <span className="plan-usage-copy">
        <strong>{plan}</strong>
        <em>{detail}</em>
      </span>
    </a>
  );
}
