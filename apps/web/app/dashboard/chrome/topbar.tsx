"use client";

import { CircleHelp, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, RefreshCw, Save, Search, SlidersHorizontal, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import Image from "next/image";

import { tabToPath } from "../../../src/routes.js";
import { tabs } from "../../dashboard-config";
import { CustomSelect } from "../ui/select";
import type { SelectOption } from "../ui/select";
import type { TabId } from "../../dashboard-types";

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
