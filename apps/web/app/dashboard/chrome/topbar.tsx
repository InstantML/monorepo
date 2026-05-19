"use client";

import { Check, ChevronDown, CircleHelp, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, RefreshCw, Save, Search, SlidersHorizontal, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";

import { tabToPath } from "../../../src/routes.js";
import { tabs } from "../../dashboard-config";
import { CustomSelect } from "../ui/select";
import type { SelectOption } from "../ui/select";
import type { TabId } from "../../dashboard-types";

export type OrgMembershipSummary = {
  org_id: string;
  name: string;
  slug: string;
  plan_tier: string;
  role: string;
  status: string;
  member_count: number;
  is_current: boolean;
};

const ORG_SWITCHER_SEARCH_THRESHOLD = 7;
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
                    {membership.role} · {membership.member_count} {membership.member_count === 1 ? "member" : "members"}
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

export function DashboardTopbar({
  activeIcon: ActiveIcon,
  activeTab,
  detailRunName,
  message,
  mobileNavOpen,
  onApplySavedView,
  onMobileMenuToggle,
  onProject,
  onQuery,
  onQuickSearch,
  onRefresh,
  onSaveView,
  onSelectTab,
  onSignOut,
  onShortcutHelp,
  onSortBy,
  onStatus,
  onThemeToggle,
  onViewName,
  orgMemberships,
  orgSwitchBusy,
  orgSwitchError,
  onSwitchOrg,
  planLabel,
  project,
  projects,
  query,
  savedViewKey,
  savedViews,
  sortBy,
  status,
  metricUsagePercent,
  storageUsagePercent,
  theme,
  tone,
  usageAvailable,
  usageResetLabel,
  viewName,
  workspaceName,
  workspaceId,
}: {
  activeIcon: LucideIcon;
  activeTab: TabId;
  detailRunName: string;
  message: string;
  mobileNavOpen: boolean;
  onApplySavedView: (key: string) => void;
  onMobileMenuToggle: () => void;
  onProject: (project: string) => void;
  onQuery: (value: string) => void;
  onQuickSearch: () => void;
  onRefresh: () => void;
  onSaveView: () => void;
  onSelectTab: (tabId: TabId) => void;
  onSignOut: () => void;
  onShortcutHelp: () => void;
  onSortBy: (value: string) => void;
  onStatus: (status: string) => void;
  onThemeToggle: () => void;
  onViewName: (value: string) => void;
  orgMemberships: OrgMembershipSummary[];
  orgSwitchBusy: boolean;
  orgSwitchError: string;
  onSwitchOrg: (orgId: string) => void;
  planLabel: string;
  project: string;
  projects: string[];
  query: string;
  savedViewKey: string;
  savedViews: SelectOption[];
  sortBy: string;
  status: string;
  metricUsagePercent: number;
  storageUsagePercent: number;
  theme: "light" | "dark";
  tone: "error" | "loading" | "ok";
  usageAvailable: boolean;
  usageResetLabel: string;
  viewName: string;
  workspaceName: string;
  workspaceId: string;
}) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [desktopFiltersCollapsed, setDesktopFiltersCollapsed] = useState(false);
  const [compactFilters, setCompactFilters] = useState(false);
  const dark = theme === "dark";
  const operationalLabel = tone === "error" ? "API issue" : tone === "loading" ? "Syncing" : "Operational";
  // Run Detail is reached *through* a run — its filters are meaningless there,
  // so it uses the admin shell (no workbar), matching the run-detail mock.
  const showWorkbar = activeTab !== "detail";
  const tabLabel = activeTab === "detail" ? "Run Detail" : tabs.find((tab) => tab.id === activeTab)?.label ?? "Runs";
  const filtersVisible = compactFilters ? mobileFiltersOpen : !desktopFiltersCollapsed;

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(max-width: 720px)");
    function applyHeight() {
      setCompactFilters(media.matches);
      if (media.matches) {
        // On mobile the workbar collapses behind the filters toggle. Keep the
        // sticky offset at the brandbar height; when filters open they push
        // content down naturally without needing a calc-able offset.
        root.style.setProperty("--topbar-height", "56px");
      } else {
        root.style.setProperty("--topbar-height", showWorkbar && !desktopFiltersCollapsed ? "92px" : "48px");
      }
    }
    applyHeight();
    media.addEventListener("change", applyHeight);
    return () => {
      media.removeEventListener("change", applyHeight);
      root.style.removeProperty("--topbar-height");
    };
  }, [desktopFiltersCollapsed, showWorkbar]);

  return (
    <header className={`topbar ${showWorkbar ? "topbar--workbar" : "topbar--brandonly"} ${mobileFiltersOpen ? "mobile-filters-open" : ""} ${desktopFiltersCollapsed ? "desktop-filters-collapsed" : ""}`}>
      <div className="brandbar">
        <button
          type="button"
          className="mobile-menu-button"
          aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileNavOpen}
          onClick={onMobileMenuToggle}
        >
          {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <a className="brand-cell" href="/dashboard/runs" aria-label="InstantML">
          <span className="brand-mark" aria-hidden="true">
            <Image src="/instantml-mark.svg" alt="" width={24} height={24} priority />
          </span>
        </a>
        <div className="brandbar-row">
          <span className="brand-wordmark" aria-label="InstantML">
            instant<span className="brand-wordmark__accent">ml</span>
          </span>
          <OrgSwitcher
            busy={orgSwitchBusy}
            current={workspaceId ? { id: workspaceId, name: workspaceName } : null}
            error={orgSwitchError}
            memberships={orgMemberships}
            onSelect={onSwitchOrg}
          />
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <span className="crumb">{project || "demo"}</span>
            <span className="sep" aria-hidden="true">/</span>
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
              metricPercent={metricUsagePercent}
              plan={planLabel}
              resetLabel={usageResetLabel}
              storagePercent={storageUsagePercent}
              usageAvailable={usageAvailable}
            />
            <button className="ghost-kbd" type="button" onClick={onQuickSearch} aria-label="Quick search">
              <Search size={13} /> <span className="ghost-kbd-label">Search</span> <span className="kbd">⌘K</span>
            </button>
            {showWorkbar ? (
              <button
                aria-label={filtersVisible ? "Hide filters" : "Show filters"}
                aria-expanded={filtersVisible}
                className="icon-button framed mobile-filters-toggle"
                onClick={() => {
                  if (compactFilters) setMobileFiltersOpen((open) => !open);
                  else setDesktopFiltersCollapsed((collapsed) => !collapsed);
                }}
                title="Filters"
                type="button"
              >
                <SlidersHorizontal size={15} />
              </button>
            ) : null}
            <button
              aria-label="Keyboard shortcuts"
              className="icon-button framed brandbar-action-desktop"
              onClick={onShortcutHelp}
              title="Keyboard shortcuts"
              type="button"
            >
              <CircleHelp size={15} />
            </button>
            <button
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-pressed={dark}
              className="icon-button framed brandbar-action-desktop"
              onClick={onThemeToggle}
              title={dark ? "Light mode" : "Dark mode"}
              type="button"
            >
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button
              aria-label="Sign out"
              className="icon-button framed brandbar-action-desktop"
              onClick={onSignOut}
              title="Sign out"
              type="button"
            >
              <LogOut size={15} />
            </button>
            <div className="avatar brandbar-action-desktop" aria-label="Account">AK</div>
          </div>
        </div>
      </div>

      {showWorkbar ? (
        <div className="workbar" role="toolbar" aria-label="Run filters">
          <CustomSelect id="project-filter" label="Project" value={project} onChange={onProject} options={[{ value: "", label: "All projects" }, ...projects.map((item) => ({ value: item, label: item }))]} />
          <CustomSelect
            id="status-filter"
            label="Status"
            value={status}
            onChange={onStatus}
            options={[
              { value: "", label: "All" },
              { value: "running", label: "Running" },
              { value: "finished", label: "Finished" },
              { value: "failed", label: "Failed" },
            ]}
          />
          <span className="workbar-divider" aria-hidden="true" />
          <label className="workbar-search">
            <Search size={13} />
            <input id="search" type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="runs, tags, notes, config" aria-label="Search runs" />
          </label>
          <CustomSelect
            className="compact"
            id="sort-select"
            label="Sort"
            onChange={onSortBy}
            options={[
              { value: "created", label: "Newest" },
              { value: "metric-latest", label: "Latest metric" },
              { value: "metric-best", label: "Best metric" },
              { value: "name", label: "Name" },
              { value: "status", label: "Status" },
              { value: "duration", label: "Duration" },
            ]}
            value={sortBy}
          />
          <span className={`system-status ${tone}`} title={message}><span /> {operationalLabel}</span>
          <span className={`status-message ${tone}`} id="status-message" role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} tabIndex={-1} title={message}>{message}</span>
          <div className="workbar-spacer" />
          <label className="control compact workbar-name">
            Name
            <input id="view-name" value={viewName} onChange={(event) => onViewName(event.target.value)} placeholder="view name" />
          </label>
          <button className="primary-button" id="save-view" type="button" onClick={onSaveView}><Save size={14} /> Save view</button>
          <CustomSelect
            className="compact"
            id="saved-view-select"
            label="View"
            menuAlign="right"
            onChange={onApplySavedView}
            options={[{ value: "", label: "Unsaved" }, ...savedViews]}
            value={savedViewKey}
          />
          <button className="icon-button framed" type="button" aria-label="Refresh" onClick={onRefresh}><RefreshCw size={14} /></button>
        </div>
      ) : null}
    </header>
  );
}

function PlanUsageBadge({
  metricPercent,
  plan,
  resetLabel,
  storagePercent,
  usageAvailable,
}: {
  metricPercent: number;
  plan: string;
  resetLabel: string;
  storagePercent: number;
  usageAvailable: boolean;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(Math.max(metricPercent, storagePercent))));
  const tone = percent >= 100 ? "bad" : percent >= 80 ? "warn" : "ok";
  const detail = usageAvailable
    ? resetLabel ? `${percent}% used · resets ${resetLabel}` : `${percent}% used`
    : "Usage unavailable";
  return (
    <a className={`plan-usage-badge ${tone}`} href={tabToPath("settings")} title={`Plan usage: ${detail}`}>
      <span className="plan-usage-ring" style={{ "--plan-usage-percent": `${percent}%` } as CSSProperties} aria-hidden="true" />
      <span className="plan-usage-copy">
        <strong>{plan}</strong>
        <em>{detail}</em>
      </span>
    </a>
  );
}
