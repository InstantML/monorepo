import { Activity, Box, Check, ChevronDown, CircleHelp, Columns3, Copy, CopyPlus, Database, Download, FileText, Folder, GitBranch, GripVertical, Maximize2, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Save, Search, Server, Star, Sun, Tag, Trash2, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, Dispatch, DragEvent, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import type { LucideIcon } from "lucide-react";

import { averageGroupedSeries, axisTicks, chartDomain, formatAxisValue, nearestPoint, normalizeSeries, smoothSeries, svgPointFromClient } from "../src/charts.js";
import { tabToPath } from "../src/routes.js";
import { MAX_SELECTED_RUNS, bestMetric, durationLabel, formatNumber, groupKeyForRun, metricGoal, metricGoalLabel, metricGoalValue, statusTone, visibleSelectionState } from "../src/state.js";

import {
  chartHeight,
  chartPadding,
  chartWidth,
  compactValue,
  compareCategory,
  comparePathLabel,
  compareRowRank,
  artifactTotalForRun,
  formatBytes,
  formatRunTime,
  lastMetricStep,
  metricTitle,
  runNoteText,
  runConfigSummary,
  safeArtifactUri,
  shortMetricName,
  shortValue,
} from "./dashboard-models";
import { navGroups } from "./dashboard-config";
import { InstantMlMark } from "./instantml-mark";
import type {
  AlertRow,
  ApiRow,
  Artifact,
  CompareLayout,
  CompareRowSort,
  CompareRunSort,
  DatasetRow,
  HoverPoint,
  IntegrationRow,
  LoggedObject,
  LoggedObjectRow,
  MetricSeries,
  MetricCatalogRow,
  ModelRow,
  Overview,
  ReportRow,
  RunMetricRow,
  RunTimelineRow,
  RunSummary,
  TableColumns,
  TabId,
  Tone,
  WorkspacePanel,
  WorkspacePanelLayout,
  WorkspacePanelSettings,
  WorkspaceSection,
  WorkspaceView,
} from "./dashboard-types";

const tableColumnLabels: Array<[keyof TableColumns, string]> = [
  ["status", "Status"],
  ["tags", "Tags"],
  ["notes", "Notes"],
  ["started", "Started"],
  ["duration", "Duration"],
  ["latest", "Latest metric"],
];

type SelectOption = {
  disabled?: boolean;
  label: string;
  value: string;
};

type ChartZoomRange = { min: number; max: number } | null;

type ShortcutCommand = {
  description?: string;
  enabled: boolean;
  group: string;
  id: string;
  label: string;
  shortcut: string;
};

type QuickSearchItem = {
  description: string;
  group: string;
  id: string;
  label: string;
  onSelect: () => void;
};

type DraggedWorkspacePanel = {
  panelId: string;
  sectionId: string;
};

const chartPalette = [
  "#dc5b55",
  "#5d89dd",
  "var(--accent)",
  "var(--warm)",
  "#8b7cf6",
  "#2ec4b6",
  "#e45f8c",
  "#7bc96f",
  "#14b8a6",
  "#f4a261",
  "#9ca3af",
  "#cbd5e1",
];

function chartColor(index: number) {
  return chartPalette[index % chartPalette.length];
}

function compactRailRunName(name: string) {
  if (name.length <= 30) return name;
  const seedMatch = name.match(/^(.*?)-seed-(.+)$/);
  if (seedMatch) return `${seedMatch[1].slice(0, 18)}...seed-${seedMatch[2]}`;
  return `${name.slice(0, 18)}...${name.slice(-10)}`;
}

function tagInputValue(tags: string[]) {
  return (tags ?? []).join(", ");
}

function parseTagInput(value: string) {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 16);
}

function remainingTagsTitle(tags: string[], visibleCount: number) {
  return tags.slice(visibleCount).join(", ");
}

function visibleTagsForSearch(tags: string[], search: string, limit: number) {
  const normalizedTags = Array.isArray(tags) ? tags.filter(Boolean) : [];
  const tokens = compareSearchTokens(search);
  if (!tokens.length) return normalizedTags.slice(0, limit);
  const matched = normalizedTags.filter((tag) => {
    const text = tag.toLowerCase();
    return tokens.some((token) => text.includes(token));
  });
  return [...matched, ...normalizedTags].filter((tag, index, values) => values.indexOf(tag) === index).slice(0, limit);
}

function focusableChildren(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(
    "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )).filter((node) => !node.closest("[aria-hidden='true']"));
}

export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onClose: () => void,
  initialSelector?: string,
) {
  const rootRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function focusInitial() {
      const root = rootRef.current;
      if (!root) return;
      const preferred = initialSelector ? root.querySelector<HTMLElement>(initialSelector) : null;
      (preferred ?? focusableChildren(root)[0] ?? root).focus({ preventScroll: true });
    }

    const focusTimer = window.setTimeout(focusInitial, 0);

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableChildren(root);
      if (!focusable.length) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (!root.contains(current)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [active, initialSelector]);

  return rootRef;
}

export function CustomSelect({
  className = "",
  disabled = false,
  id,
  label,
  labelClassName = "",
  menuAlign = "left",
  menuPlacement = "bottom",
  onChange,
  options,
  value,
}: {
  className?: string;
  disabled?: boolean;
  id: string;
  label: string;
  labelClassName?: string;
  menuAlign?: "left" | "right";
  menuPlacement?: "bottom" | "top";
  onChange: (value: string) => void;
  options: SelectOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeOnOpenRef = useRef<number | null>(null);
  const focusMenuOnOpenRef = useRef(false);
  const scrollBeforeOpenRef = useRef<{ x: number; y: number } | null>(null);
  const labelId = useId();
  const valueId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0] ?? { label: "-", value: "" };
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected.value));
  const menuId = `${id}-menu`;

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

  useLayoutEffect(() => {
    if (!open) return;
    const nextActiveIndex = Math.max(0, Math.min(options.length - 1, activeOnOpenRef.current ?? selectedIndex));
    const previousScroll = scrollBeforeOpenRef.current ?? { x: window.scrollX, y: window.scrollY };
    function restoreScroll() {
      window.scrollTo(previousScroll.x, previousScroll.y);
    }
    setActiveIndex(nextActiveIndex);
    if (focusMenuOnOpenRef.current) optionRefs.current[nextActiveIndex]?.focus({ preventScroll: true });
    restoreScroll();
    const restoreFrame = window.requestAnimationFrame(restoreScroll);
    const restoreTimer = window.setTimeout(() => {
      restoreScroll();
      activeOnOpenRef.current = null;
      focusMenuOnOpenRef.current = false;
      scrollBeforeOpenRef.current = null;
    }, 0);
    const restoreLateTimer = window.setTimeout(restoreScroll, 80);
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      window.clearTimeout(restoreTimer);
      window.clearTimeout(restoreLateTimer);
    };
  }, [open, options.length, selectedIndex]);

  function rememberScrollPosition(force = false) {
    if (force || !scrollBeforeOpenRef.current) scrollBeforeOpenRef.current = { x: window.scrollX, y: window.scrollY };
  }

  function openMenu(focusMenu: boolean, activeIndexOverride = selectedIndex) {
    rememberScrollPosition();
    activeOnOpenRef.current = activeIndexOverride;
    focusMenuOnOpenRef.current = focusMenu;
    setOpen(true);
  }

  function choose(option: SelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  }

  function handleTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && event.key === "ArrowDown") {
        focusOption(activeIndex + 1);
      } else {
        openMenu(true);
      }
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (open) {
        focusOption(activeIndex - 1);
      } else {
        openMenu(true, Math.max(0, selectedIndex - 1));
      }
    }
  }

  function focusOption(index: number) {
    const bounded = Math.max(0, Math.min(options.length - 1, index));
    setActiveIndex(bounded);
    optionRefs.current[bounded]?.focus({ preventScroll: true });
  }

  function handleOptionKey(event: KeyboardEvent<HTMLButtonElement>, option: SelectOption, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(option);
    }
  }

  return (
    <div className={`control custom-select-control ${className}`} ref={rootRef}>
      <span className={labelClassName} id={labelId}>{label}</span>
      <select
        aria-hidden="true"
        className="native-select-proxy"
        disabled={disabled}
        hidden
        id={id}
        onChange={(event) => onChange(event.target.value)}
        tabIndex={-1}
        value={value}
      >
        {options.map((option) => <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <div className="custom-select">
        <button
          aria-controls={menuId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-labelledby={`${labelId} ${valueId}`}
          className="select-trigger"
          disabled={disabled}
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              rememberScrollPosition(true);
              openMenu(false);
            }
          }}
          onKeyDown={handleTriggerKey}
          onPointerDown={(event) => {
            if (disabled || open) return;
            rememberScrollPosition(true);
            event.currentTarget.focus({ preventScroll: true });
            event.preventDefault();
          }}
          type="button"
        >
          <span className="select-trigger-value" id={valueId}>{selected.label}</span>
          <ChevronDown size={15} />
        </button>
        {open ? (
          <div className={`select-menu ${menuAlign === "right" ? "align-right" : ""} ${menuPlacement === "top" ? "open-up" : ""}`} id={menuId} role="listbox" aria-labelledby={labelId}>
            {options.map((option, index) => {
              const optionSelected = option.value === value;
              return (
                <button
                  aria-selected={optionSelected}
                  className={`select-option ${optionSelected ? "selected" : ""} ${index === activeIndex ? "active" : ""}`}
                  disabled={option.disabled}
                  key={option.value}
                  onClick={() => choose(option)}
                  onKeyDown={(event) => handleOptionKey(event, option, index)}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  role="option"
                  type="button"
                >
                  <span className="select-check">{optionSelected ? <Check size={15} /> : null}</span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ShortcutHelpModal({
  commands,
  modifierLabel,
  onClose,
}: {
  commands: ShortcutCommand[];
  modifierLabel: string;
  onClose: () => void;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, "button[aria-label='Close keyboard shortcuts']");
  const grouped = commands.reduce<Record<string, ShortcutCommand[]>>((acc, command) => {
    acc[command.group] = [...(acc[command.group] ?? []), command];
    return acc;
  }, {});
  return (
    <div className="workspace-modal command-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" ref={dialogRef} tabIndex={-1}>
      <div className="command-card">
        <div className="drawer-head">
          <div>
            <h2>Keyboard shortcuts</h2>
            <small>{modifierLabel} maps to the platform command key.</small>
          </div>
          <button className="icon-button" type="button" aria-label="Close keyboard shortcuts" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="shortcut-groups">
          {Object.entries(grouped).map(([group, groupCommands]) => (
            <section className="shortcut-group" key={group}>
              <h3>{group}</h3>
              {groupCommands.map((command) => (
                <div className={`shortcut-row ${command.enabled ? "" : "disabled"}`} key={command.id}>
                  <span>
                    <strong>{command.label}</strong>
                    {command.description ? <small>{command.description}</small> : null}
                  </span>
                  <kbd>{command.shortcut}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function QuickSearchModal({
  activeIndex,
  items,
  onActiveIndex,
  onClose,
  onQuery,
  onSelect,
  query,
}: {
  activeIndex: number;
  items: QuickSearchItem[];
  onActiveIndex: (index: number) => void;
  onClose: () => void;
  onQuery: (value: string) => void;
  onSelect: (item: QuickSearchItem) => void;
  query: string;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose, "#quick-search-input");
  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    const maxIndex = Math.max(0, items.length - 1);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onActiveIndex(Math.min(maxIndex, activeIndex + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onActiveIndex(Math.max(0, activeIndex - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      onActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      onActiveIndex(Math.max(0, items.length - 1));
    } else if (event.key === "Enter" && items[activeIndex]) {
      event.preventDefault();
      onSelect(items[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="workspace-modal command-modal" role="dialog" aria-modal="true" aria-label="Quick search" ref={dialogRef} tabIndex={-1}>
      <div className="command-card quick-search-card">
        <div className="quick-search-input">
          <Search size={18} />
          <input
            autoFocus
            id="quick-search-input"
            onChange={(event) => {
              onActiveIndex(0);
              onQuery(event.target.value);
            }}
            onKeyDown={handleKey}
            placeholder="Search tabs, runs, metrics, projects, views"
            type="search"
            value={query}
          />
          <button className="icon-button" type="button" aria-label="Close quick search" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="quick-search-results" role="listbox" aria-label="Quick search results">
          {items.length ? items.map((item, index) => (
            <button
              aria-selected={index === activeIndex}
              className={`quick-search-row ${index === activeIndex ? "active" : ""}`}
              key={item.id}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onActiveIndex(index)}
              role="option"
              type="button"
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <em>{item.group}</em>
            </button>
          )) : (
            <div className="empty compact-empty">No matches yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DashboardTopbar({
  activeIcon: ActiveIcon,
  message,
  onApplySavedView,
  onLoadDemo,
  onProject,
  onSaveView,
  onShortcutHelp,
  onStatus,
  onThemeToggle,
  onViewName,
  project,
  projects,
  savedViewKey,
  savedViews,
  status,
  theme,
  tone,
  viewName,
}: {
  activeIcon: LucideIcon;
  message: string;
  onApplySavedView: (key: string) => void;
  onLoadDemo: () => void;
  onProject: (project: string) => void;
  onSaveView: () => void;
  onShortcutHelp: () => void;
  onStatus: (status: string) => void;
  onThemeToggle: () => void;
  onViewName: (value: string) => void;
  project: string;
  projects: string[];
  savedViewKey: string;
  savedViews: string[];
  status: string;
  theme: "light" | "dark";
  tone: "error" | "loading" | "ok";
  viewName: string;
}) {
  const dark = theme === "dark";
  const operationalLabel = tone === "error" ? "API issue" : tone === "loading" ? "Syncing" : "Operational";
  return (
    <header className="topbar">
      <div className="topbar-main">
        <div className="brand" aria-label="InstantML" title="InstantML">
          <div className="brand-mark" aria-hidden="true"><InstantMlMark /></div>
        </div>
        <div className="toolbar topbar-controls">
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
          <span className={`system-status ${tone}`}><span /> {operationalLabel}</span>
        </div>
        <div className="action-cluster">
          <span className={`status-message ${tone}`} id="status-message" role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} tabIndex={-1} title={message}><ActiveIcon size={13} /> {message}</span>
          <button id="demo-reset" type="button" className="secondary" onClick={onLoadDemo}><Download size={15} /> Reset demo</button>
          <label className="control compact">
            Name
            <input id="view-name" value={viewName} onChange={(event) => onViewName(event.target.value)} placeholder="view name" />
          </label>
          <button className="primary-button" id="save-view" type="button" onClick={onSaveView}><Save size={15} /> Save view</button>
          <CustomSelect
            className="compact"
            id="saved-view-select"
            label="View"
            menuAlign="right"
            onChange={onApplySavedView}
            options={[{ value: "", label: "Unsaved" }, ...savedViews.map((key) => ({ value: key, label: key.replace("rlobs:next:local:view:", "").replace("rlobs:next:view:", "") }))]}
            value={savedViewKey}
          />
        </div>
        <div className="utility-icons" aria-label="Utilities">
          <button
            aria-label="Keyboard shortcuts"
            className="icon-button framed"
            onClick={onShortcutHelp}
            title="Keyboard shortcuts"
            type="button"
          >
            <CircleHelp size={15} />
          </button>
          <button
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            aria-pressed={dark}
            className="icon-button framed"
            onClick={onThemeToggle}
            title={dark ? "Light mode" : "Dark mode"}
            type="button"
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <div className="avatar">AK</div>
        </div>
      </div>
    </header>
  );
}

export function DashboardNav({
  activeTab,
  onAutoOpenChange,
  onPinnedChange,
  onSelect,
  pinned,
}: {
  activeTab: TabId;
  onAutoOpenChange: (open: boolean) => void;
  onPinnedChange: (pinned: boolean) => void;
  onSelect: (tabId: TabId) => void;
  pinned: boolean;
}) {
  const navRef = useRef<HTMLElement>(null);

  function handlePinnedChange(nextPinned: boolean) {
    function resetNavScroll() {
      navRef.current?.scrollTo({ top: 0 });
      navRef.current?.querySelector<HTMLElement>(".tab-scroll")?.scrollTo({ top: 0 });
    }
    resetNavScroll();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!nextPinned) onAutoOpenChange(false);
    onPinnedChange(nextPinned);
    window.setTimeout(resetNavScroll, 0);
  }

  function handleTabSelect(event: MouseEvent<HTMLAnchorElement>, tabId: TabId) {
    event.preventDefault();
    onSelect(tabId);
    if (event.detail > 0) event.currentTarget.blur();
  }

  return (
    <nav
      className={`tabs ${pinned ? "pinned" : ""}`}
      aria-label="Dashboard sections"
      onMouseEnter={() => onAutoOpenChange(true)}
      onMouseLeave={() => onAutoOpenChange(false)}
      ref={navRef}
    >
      <div className="tab-scroll">
        {navGroups.map((group) => (
          <div className="tab-group" key={group.id}>
            {group.items.map((tab) => {
              const Icon = tab.icon;
              return (
                <a
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
                  href={tabToPath(tab.id)}
                  key={tab.id}
                  onClick={(event) => handleTabSelect(event, tab.id)}
                >
                  <Icon size={15} /> <span className="tab-label">{tab.label}</span>
                </a>
              );
            })}
          </div>
        ))}
      </div>
      <div className="nav-footer">
        <button
          aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          aria-pressed={pinned}
          className={`tab-button nav-pin-button ${pinned ? "active" : ""}`}
          onClick={() => handlePinnedChange(!pinned)}
          title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          type="button"
        >
          {pinned ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          <span className="tab-label">{pinned ? "Unpin" : "Pin"}</span>
        </button>
      </div>
    </nav>
  );
}

export function RunsCommandbar({
  columnsOpen,
  metricKey,
  metricOptions,
  onColumnsOpen,
  onMetricKey,
  onPinnedMetricFilter,
  onPinnedMetric,
  onQuery,
  onRefresh,
  onSortBy,
  onTableColumns,
  pinnedMetricFilter,
  pinnedMetricFilterValid,
  pinnedMetricOptions,
  pinnedMetrics,
  query,
  sortBy,
  tableColumns,
}: {
  columnsOpen: boolean;
  metricKey: string;
  metricOptions: string[];
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onMetricKey: (value: string) => void;
  onPinnedMetricFilter: (value: string) => void;
  onPinnedMetric: (metric: string) => void;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onSortBy: (value: string) => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  pinnedMetricFilter: string;
  pinnedMetricFilterValid: boolean;
  pinnedMetricOptions: string[];
  pinnedMetrics: string[];
  query: string;
  sortBy: string;
  tableColumns: TableColumns;
}) {
  return (
    <div className="runs-commandbar">
      <label className="control search-control">
        <span className="command-label"><Search size={14} /> Filter runs...</span>
        <input id="search" type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="runs, tags, notes, config" />
      </label>
      <CustomSelect
        className="command-select"
        id="sort-select"
        label="Sort"
        labelClassName="command-label"
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
      <CustomSelect
        className="command-select metric-command"
        disabled={!metricOptions.length}
        id="runs-metric-select"
        label="Metric"
        labelClassName="command-label"
        onChange={onMetricKey}
        options={metricOptions.length ? metricOptions.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
        value={metricOptions.length ? metricKey : ""}
      />
      <div className="command-spacer" />
      <div className="columns-menu">
        <button className="secondary compact-button" type="button" aria-expanded={columnsOpen} aria-controls="columns-popover" onClick={() => onColumnsOpen((current) => !current)}><Columns3 size={15} /> Columns</button>
        {columnsOpen ? (
          <div className="column-popover" id="columns-popover">
            <strong>Visible columns</strong>
            {tableColumnLabels.map(([key, label]) => (
              <label key={key}>
                <input
                  checked={tableColumns[key]}
                  onChange={(event) => onTableColumns((current) => ({ ...current, [key]: event.target.checked }))}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
            <strong>Pinned metrics</strong>
            <label className={`metric-filter-row ${pinnedMetricFilterValid ? "" : "invalid"}`}>
              <Search size={13} />
              <input id="column-metric-filter" type="search" value={pinnedMetricFilter} onChange={(event) => onPinnedMetricFilter(event.target.value)} placeholder="metric regex" />
            </label>
            {pinnedMetricOptions.slice(0, 8).map((metric) => (
              <label key={metric} title={metric}>
                <input
                  checked={pinnedMetrics.includes(metric)}
                  onChange={() => onPinnedMetric(metric)}
                  type="checkbox"
                />
                {shortMetricName(metric)}
              </label>
            ))}
          </div>
        ) : null}
      </div>
      <button className="icon-button framed" type="button" aria-label="Refresh runs" onClick={onRefresh}><RefreshCw size={16} /></button>
    </div>
  );
}

export function Stats({ overview, metricKey }: { overview: Overview; metricKey: string }) {
  const stats = [
    ["Total runs", formatNumber(overview.total_runs, 0)],
    ["Active", formatNumber(overview.active_runs, 0)],
    ["Failed", formatNumber(overview.failed_runs, 0)],
    [`${metricGoalLabel(metricKey)} ${metricKey}`, formatNumber(overview.best_eval_return, 1)],
    ["Metric points", formatNumber(overview.metric_points, 0)],
  ];
  return (
    <section className="stat-grid" aria-label="Overview">
      {stats.map(([label, value]) => (
        <div className="stat" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

export function RunsWorkspace({
  addPanelSectionId,
  availableMetricKeys,
  onAddPanel,
  onAddSection,
  onClearFilters,
  onColumnsOpen,
  onDuplicatePanel,
  onEditPanel,
  onFullscreenPanel,
  onInspectRun,
  onMode,
  onMovePanel,
  onPanelSearch,
  onRefresh,
  onRemovePanel,
  onResetWorkspace,
  onResizePanel,
  onRunRailCollapsed,
  onSetAddPanelSection,
  onTableColumns,
  onSelectAllMatching,
  onSelectAllVisible,
  onToggleRun,
  onToggleSection,
  hasNextPage,
  hasPreviousPage,
  onNextPage,
  onPageSize,
  onPreviousPage,
  paginationBusy,
  pageEnd,
  pageSize,
  pageStart,
  panelSearch,
  runSearch,
  runRailCollapsed,
  selectAllMatchingBusy,
  selectedRunIds,
  showAddPanelDrawer,
  summaryTotal,
  tableColumns,
  view,
  workspacePanelRuns,
  workspaceRuns,
  workspaceSeries,
}: {
  addPanelSectionId: string;
  availableMetricKeys: string[];
  onAddPanel: (sectionId: string, metricKey: string) => void;
  onAddSection: () => void;
  onClearFilters: () => void;
  onColumnsOpen: Dispatch<SetStateAction<boolean>>;
  onDuplicatePanel: (sectionId: string, panelId: string) => void;
  onEditPanel: (sectionId: string, panelId: string) => void;
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onInspectRun: (runId: string) => void;
  onMode: (mode: "automatic" | "manual") => void;
  onMovePanel: (sourceSectionId: string, panelId: string, targetSectionId: string, targetIndex: number) => void;
  onPanelSearch: (value: string) => void;
  onRefresh: () => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onResetWorkspace: () => void;
  onResizePanel: (sectionId: string, panelId: string, layout: WorkspacePanelLayout) => void;
  onRunRailCollapsed: (collapsed: boolean) => void;
  onSelectAllMatching: () => void;
  onSelectAllVisible: () => void;
  onSetAddPanelSection: (sectionId: string) => void;
  onTableColumns: Dispatch<SetStateAction<TableColumns>>;
  onToggleRun: (runId: string, options?: { shift?: boolean }) => void;
  onToggleSection: (sectionId: string) => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNextPage: () => void;
  onPageSize: (size: number) => void;
  onPreviousPage: () => void;
  paginationBusy: boolean;
  pageEnd: number;
  pageSize: number;
  pageStart: number;
  panelSearch: string;
  runSearch: string;
  runRailCollapsed: boolean;
  selectAllMatchingBusy: boolean;
  selectedRunIds: string[];
  showAddPanelDrawer: boolean;
  summaryTotal: number;
  tableColumns: TableColumns;
  view: WorkspaceView;
  workspacePanelRuns: RunSummary[];
  workspaceRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  const hiddenPanelCount = view.sections.reduce((sum, section) => sum + section.panels.filter((panel) => !panelMatchesSearch(section, panel, panelSearch)).length, 0);
  const addDrawerRef = useFocusTrap<HTMLElement>(
    showAddPanelDrawer,
    () => onSetAddPanelSection(""),
    ".drawer-metric-row:not([disabled]), .quick-add-card:not([disabled]), button[aria-label='Close add panels']",
  );
  const [draggedPanel, setDraggedPanel] = useState<DraggedWorkspacePanel | null>(null);
  const draggedPanelRef = useRef<DraggedWorkspacePanel | null>(null);
  const activeAddSectionId = addPanelSectionId || view.sections[0]?.id || "";
  function handlePanelDragStart(event: DragEvent<HTMLElement>, sectionId: string, panelId: string) {
    const payload = { sectionId, panelId };
    draggedPanelRef.current = payload;
    setDraggedPanel(payload);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-rlobs-panel", JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", panelId);
  }
  function clearDraggedPanel() {
    draggedPanelRef.current = null;
    setDraggedPanel(null);
  }
  function handlePanelPointerMoveStart(event: ReactPointerEvent<HTMLElement>, sectionId: string, panelId: string) {
    if (event.button !== 0) return;
    const payload = { sectionId, panelId };
    const startX = event.clientX;
    const startY = event.clientY;
    const ownerDocument = event.currentTarget.ownerDocument;
    draggedPanelRef.current = payload;
    setDraggedPanel(payload);
    event.preventDefault();
    event.stopPropagation();

    function finish() {
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      clearDraggedPanel();
    }
    function handlePointerCancel() {
      finish();
    }
    function handlePointerUp(pointerEvent: globalThis.PointerEvent) {
      const moved = Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY);
      if (moved < 8) {
        finish();
        return;
      }
      const target = ownerDocument.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      const unsectionedDrop = target?.closest?.(".workspace-unsectioned-drop-zone");
      if (unsectionedDrop) {
        onMovePanel(payload.sectionId, payload.panelId, "__unsectioned__", Number.MAX_SAFE_INTEGER);
        finish();
        return;
      }
      const targetSection = target?.closest?.(".workspace-section") as HTMLElement | null | undefined;
      const targetSectionId = targetSection?.dataset.sectionId;
      if (!targetSectionId) {
        finish();
        return;
      }
      const targetCard = target?.closest?.(".workspace-panel-card") as HTMLElement | null | undefined;
      const cards = Array.from(targetSection.querySelectorAll<HTMLElement>(".workspace-panel-card"));
      const targetIndex = targetCard ? Math.max(0, cards.indexOf(targetCard)) : Number.MAX_SAFE_INTEGER;
      onMovePanel(payload.sectionId, payload.panelId, targetSectionId, targetIndex);
      finish();
    }

    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  }
  function handlePanelDrop(event: DragEvent<HTMLElement>, targetSectionId: string, targetIndex: number) {
    event.preventDefault();
    const payload = draggedPanelRef.current ?? draggedPanel ?? readDraggedPanel(event);
    if (!payload) return;
    onMovePanel(payload.sectionId, payload.panelId, targetSectionId, targetIndex);
    clearDraggedPanel();
  }
  const visibleRunIds = workspaceRuns.map((run) => run.id);
  const railSelectionState = visibleSelectionState(selectedRunIds, visibleRunIds);
  const hasCrossPageSelection = railSelectionState === "all" && selectedRunIds.length > visibleRunIds.length;
  const railSelectionLabel = railSelectionState === "all"
    ? hasCrossPageSelection
      ? `Clear all ${selectedRunIds.length} selected runs`
      : `Deselect all ${visibleRunIds.length} visible runs`
    : `Select all ${visibleRunIds.length} visible runs`;
  const matchingOverflow = summaryTotal > visibleRunIds.length;
  const showSelectAllMatching = railSelectionState !== "none" && matchingOverflow;
  const selectAllMatchingTarget = Math.min(summaryTotal, MAX_SELECTED_RUNS);
  return (
    <div className={`runs-workspace ${showAddPanelDrawer ? "drawer-open" : ""} ${runRailCollapsed ? "run-rail-collapsed" : ""}`}>
      <aside className="workspace-run-rail">
        <div className="workspace-rail-head">
          <label className="workspace-rail-select-all" title={railSelectionLabel}>
            <input
              aria-checked={railSelectionState === "all" ? "true" : railSelectionState === "some" ? "mixed" : "false"}
              aria-label={railSelectionLabel}
              checked={railSelectionState === "all"}
              disabled={visibleRunIds.length === 0}
              onChange={onSelectAllVisible}
              ref={(node) => { if (node) node.indeterminate = railSelectionState === "some"; }}
              type="checkbox"
            />
            <h2>Runs <span>({summaryTotal})</span></h2>
          </label>
          <div className="workspace-rail-actions">
            <button className="icon-button" type="button" aria-label="Refresh runs" onClick={onRefresh}><RefreshCw size={15} /></button>
            <button
              aria-label={runRailCollapsed ? "Restore runs selector" : "Collapse runs selector"}
              aria-pressed={runRailCollapsed}
              className="icon-button"
              onClick={() => onRunRailCollapsed(!runRailCollapsed)}
              title={runRailCollapsed ? "Restore runs selector" : "Collapse runs selector"}
              type="button"
            >
              {runRailCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          </div>
        </div>
        {showSelectAllMatching ? (
          <div className="workspace-rail-select-banner" role="status" aria-live="polite">
            <span>{selectedRunIds.length} of {summaryTotal} selected.</span>
            <button
              className="link-button"
              disabled={selectAllMatchingBusy}
              onClick={onSelectAllMatching}
              type="button"
            >
              {selectAllMatchingBusy
                ? `Selecting ${selectAllMatchingTarget}...`
                : selectAllMatchingTarget < summaryTotal
                  ? `Select first ${selectAllMatchingTarget} matching filter`
                  : `Select all ${summaryTotal} matching filter`}
            </button>
          </div>
        ) : null}
        <div className="workspace-run-list">
          {workspaceRuns.length ? workspaceRuns.map((run, index) => {
            const selected = selectedRunIds.includes(run.id);
            const compareLabel = selected ? `Deselect ${run.name}` : `Select ${run.name}`;
            const note = runNoteText(run);
            const visibleTags = visibleTagsForSearch(run.tags, runSearch, 3);
            const hiddenTags = run.tags.filter((tag) => !visibleTags.includes(tag));
            return (
              <button
                aria-label={compareLabel}
                aria-pressed={selected}
                className={`workspace-run-row ${selected ? "selected" : ""}`}
                key={run.id}
                onClick={(event) => {
                  if (!event.shiftKey) onInspectRun(run.id);
                  onToggleRun(run.id, { shift: event.shiftKey });
                }}
                title={run.name}
                type="button"
              >
                <span className="workspace-eye" aria-hidden="true">
                  <span />
                </span>
                <span className="workspace-run-main">
                  <i className={`legend-dot dot-${index % 5}`} />
                  <span>
                    <strong>{compactRailRunName(run.name)}</strong>
                    <small>{run.project} · {runConfigSummary(run)}</small>
                    <span className="workspace-run-tags" aria-label={`${run.name} tags`}>
                      {visibleTags.map((tag) => <b key={tag}>{tag}</b>)}
                      {hiddenTags.length ? <em title={hiddenTags.join(", ")}>+{hiddenTags.length}</em> : null}
                    </span>
                    <small className="workspace-run-note" title={note}>{note || "No notes yet."}</small>
                  </span>
                </span>
              </button>
            );
          }) : (
            <div className="empty compact-empty">
              <strong>No runs match the current filters.</strong>
              <span>Clear search, project, and status filters to return to the run list.</span>
              <button className="secondary compact-button" type="button" onClick={onClearFilters}>Clear filters</button>
            </div>
          )}
        </div>
        <div className="workspace-run-footer">
          <CustomSelect
            className="table-footer-select"
            disabled={paginationBusy}
            id="workspace-rows-per-page"
            label="Rows"
            menuPlacement="top"
            onChange={(nextPageSize) => {
              onPageSize(Number(nextPageSize));
            }}
            options={[10, 25, 50, 100].map((size) => ({ value: String(size), label: String(size) }))}
            value={String(pageSize)}
          />
          <strong>{`${pageStart}-${pageEnd} of ${summaryTotal}`}</strong>
          <button className="icon-button framed" disabled={paginationBusy || !hasPreviousPage} onClick={onPreviousPage} type="button" aria-label="Previous page"><ChevronDown className="rotate-90" size={15} /></button>
          <button className="icon-button framed" disabled={paginationBusy || !hasNextPage} onClick={onNextPage} type="button" aria-label="Next page"><ChevronDown className="rotate-neg-90" size={15} /></button>
        </div>
      </aside>

      <section className="workspace-canvas">
        <div className="workspace-panel-toolbar">
          <label className="control workspace-panel-search">
            <span><Search size={14} /> Search panels</span>
            <input id="panel-search" type="search" value={panelSearch} onChange={(event) => onPanelSearch(event.target.value)} placeholder="Search panels" />
          </label>
          <CustomSelect
            className="workspace-mode-select"
            id="workspace-mode"
            label="Mode"
            labelClassName="visually-hidden"
            onChange={(value) => onMode(value === "manual" ? "manual" : "automatic")}
            options={[{ value: "automatic", label: "Automatic" }, { value: "manual", label: "Manual" }]}
            value={view.mode}
          />
          <button className="secondary compact-button" type="button" onClick={onResetWorkspace}><RefreshCw size={15} /> Reset layout</button>
          {!showAddPanelDrawer ? <button className="primary-button" type="button" onClick={() => onSetAddPanelSection(activeAddSectionId)}><Plus size={15} /> Add panels</button> : null}
        </div>

        <div className="workspace-sections">
          {view.sections.map((section) => {
            const visiblePanels = section.panels.filter((panel) => panelMatchesSearch(section, panel, panelSearch)).slice(0, 12);
            return (
              <WorkspaceSectionView
                key={section.id}
                onDuplicatePanel={onDuplicatePanel}
                onEditPanel={onEditPanel}
                onFullscreenPanel={onFullscreenPanel}
                onPanelDragEnd={clearDraggedPanel}
                onPanelDragStart={handlePanelDragStart}
                onPanelDrop={handlePanelDrop}
                onPanelPointerMoveStart={handlePanelPointerMoveStart}
                onRemovePanel={onRemovePanel}
                onResizePanel={onResizePanel}
                onToggleSection={onToggleSection}
                panelSearchActive={Boolean(panelSearch.trim())}
                section={section}
                selectedRunIds={selectedRunIds}
                visiblePanels={visiblePanels}
                view={view}
                workspacePanelRuns={workspacePanelRuns}
                workspaceSeries={workspaceSeries}
              />
            );
          })}
          {panelSearch && hiddenPanelCount ? <small className="workspace-search-note">{hiddenPanelCount} panels hidden by the current search.</small> : null}
        </div>

        <div
          className={`workspace-unsectioned-drop-zone ${draggedPanel ? "active" : ""}`}
          onDragOver={(event) => {
            if (draggedPanel) event.preventDefault();
          }}
          onDrop={(event) => handlePanelDrop(event, "__unsectioned__", Number.MAX_SAFE_INTEGER)}
        >
          Drop here to move a panel outside named sections.
        </div>

        <div className="workspace-add-section">
          <button className="secondary" type="button" onClick={onAddSection}><Plus size={15} /> Add section</button>
        </div>
      </section>

      {showAddPanelDrawer ? (
        <aside className="panel-drawer" role="dialog" aria-modal="true" aria-label="Add panels" ref={addDrawerRef} tabIndex={-1}>
          <div className="drawer-head">
            <h2>Add panels</h2>
            <button className="icon-button" type="button" aria-label="Close add panels" onClick={() => onSetAddPanelSection("")}><X size={16} /></button>
          </div>
          <button className="quick-add-card" type="button" disabled={!availableMetricKeys.length} onClick={() => availableMetricKeys[0] && onAddPanel(activeAddSectionId, availableMetricKeys[0])}>
            <span><Plus size={17} /></span>
            <strong>Quick add</strong>
            <small>Add the next available metric as a line panel.</small>
          </button>
          <CustomSelect
            className="full"
            id="add-panel-section"
            label="Add to"
            onChange={onSetAddPanelSection}
            options={view.sections.map((section) => ({ value: section.id, label: section.name }))}
            value={activeAddSectionId}
          />
          <div className="drawer-group">
            <h3>Charts</h3>
            {availableMetricKeys.slice(0, 18).map((metric) => (
              <button className="drawer-metric-row" key={metric} type="button" onClick={() => onAddPanel(activeAddSectionId, metric)}>
                <Activity size={16} />
                <span>
                  <strong>{metricTitle(metric)}</strong>
                  <small>{metric}</small>
                </span>
              </button>
            ))}
            {!availableMetricKeys.length ? <div className="empty compact-empty">Every available metric already has a panel. Switch to manual mode or remove a panel to add a different chart.</div> : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function WorkspaceSectionView({
  onDuplicatePanel,
  onEditPanel,
  onFullscreenPanel,
  onPanelDragEnd,
  onPanelDragStart,
  onPanelDrop,
  onPanelPointerMoveStart,
  onRemovePanel,
  onResizePanel,
  onToggleSection,
  panelSearchActive,
  section,
  selectedRunIds,
  visiblePanels,
  view,
  workspacePanelRuns,
  workspaceSeries,
}: {
  onDuplicatePanel: (sectionId: string, panelId: string) => void;
  onEditPanel: (sectionId: string, panelId: string) => void;
  onFullscreenPanel: (sectionId: string, panelId: string) => void;
  onPanelDragEnd: () => void;
  onPanelDragStart: (event: DragEvent<HTMLElement>, sectionId: string, panelId: string) => void;
  onPanelDrop: (event: DragEvent<HTMLElement>, targetSectionId: string, targetIndex: number) => void;
  onPanelPointerMoveStart: (event: ReactPointerEvent<HTMLElement>, sectionId: string, panelId: string) => void;
  onRemovePanel: (sectionId: string, panelId: string) => void;
  onResizePanel: (sectionId: string, panelId: string, layout: WorkspacePanelLayout) => void;
  onToggleSection: (sectionId: string) => void;
  panelSearchActive: boolean;
  section: WorkspaceSection;
  selectedRunIds: string[];
  visiblePanels: WorkspacePanel[];
  view: WorkspaceView;
  workspacePanelRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  return (
    <section className={`workspace-section ${section.collapsed ? "collapsed" : ""}`} data-section-id={section.id}>
      <div className="workspace-section-head">
        <button className="section-title-button" type="button" onClick={() => onToggleSection(section.id)}>
          <ChevronDown size={15} /> <strong>{section.name}</strong> <span>{section.panels.length}</span>
        </button>
      </div>
      {!section.collapsed ? (
        <div
          className="workspace-panel-grid"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => onPanelDrop(event, section.id, section.panels.length)}
        >
          {visiblePanels.length ? visiblePanels.map((panel) => {
            const panelIndex = Math.max(0, section.panels.findIndex((item) => item.id === panel.id));
            return (
              <WorkspacePanelCard
                key={panel.id}
                onDragEnd={onPanelDragEnd}
                onDragStart={(event) => onPanelDragStart(event, section.id, panel.id)}
                onDropBefore={(event) => onPanelDrop(event, section.id, panelIndex)}
                onDuplicate={() => onDuplicatePanel(section.id, panel.id)}
                onEdit={() => onEditPanel(section.id, panel.id)}
                onFullscreen={() => onFullscreenPanel(section.id, panel.id)}
                onPointerMoveStart={(event) => onPanelPointerMoveStart(event, section.id, panel.id)}
                onRemove={() => onRemovePanel(section.id, panel.id)}
                onResize={(layout) => onResizePanel(section.id, panel.id, layout)}
                panel={panel}
                panelSearchActive={panelSearchActive}
                section={section}
                selectedRunIds={selectedRunIds}
                view={view}
                workspacePanelRuns={workspacePanelRuns}
                workspaceSeries={workspaceSeries}
              />
            );
          }) : <div className="empty workspace-empty">No panels in this section yet. Drag a panel here or add one from the top toolbar.</div>}
        </div>
      ) : null}
    </section>
  );
}

export function WorkspacePanelCard({
  className = "",
  onDragEnd,
  onDragStart,
  onDropBefore,
  onDuplicate,
  onEdit,
  onFullscreen,
  onPointerMoveStart,
  onRemove,
  onResize,
  panel,
  panelSearchActive = false,
  section,
  selectedRunIds,
  view,
  workspacePanelRuns,
  workspaceSeries,
}: {
  className?: string;
  onDragEnd?: () => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDropBefore?: (event: DragEvent<HTMLElement>) => void;
  onDuplicate?: () => void;
  onEdit?: () => void;
  onFullscreen?: () => void;
  onPointerMoveStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onRemove?: () => void;
  onResize?: (layout: WorkspacePanelLayout) => void;
  panel: WorkspacePanel;
  panelSearchActive?: boolean;
  section: WorkspaceSection;
  selectedRunIds: string[];
  view: WorkspaceView;
  workspacePanelRuns: RunSummary[];
  workspaceSeries: Record<string, MetricSeries[]>;
}) {
  const [panelHover, setPanelHover] = useState<HoverPoint>(null);
  const [panelZoomRange, setPanelZoomRange] = useState<ChartZoomRange>(null);
  const [resizePreview, setResizePreview] = useState<WorkspacePanelLayout | null>(null);
  const settings = resolveWorkspaceSettings(view, section, panel);
  const layout = resizePreview ?? normalizedPanelLayout(panel.layout);
  const isFullscreenPanel = className.split(/\s+/).includes("fullscreen-panel-card");
  const panelChartWidth = isFullscreenPanel ? 920 : chartWidth;
  const panelChartHeight = isFullscreenPanel ? 430 : chartHeight;
  const panelChartPadding = isFullscreenPanel ? 60 : chartPadding;
  const panelStyle = {
    "--panel-grid-span": layout.w,
    "--panel-row-span": layout.h,
    "--panel-min-height": `${layout.h * 78}px`,
    "--panel-chart-min-height": `${layout.h * 54}px`,
  } as CSSProperties;
  const workspaceRunLookup = new Map(workspacePanelRuns.map((run) => [run.id, run]));
  const selectedVisibleRuns = selectedRunIds.length
    ? selectedRunIds.map((runId) => workspaceRunLookup.get(runId)).filter(Boolean) as RunSummary[]
    : [];
  const panelRuns = selectedVisibleRuns.length
    ? selectedVisibleRuns.slice(0, MAX_SELECTED_RUNS)
    : workspacePanelRuns.slice(0, settings.maxRuns);
  const selectedOverflow = selectedVisibleRuns.length > panelRuns.length;
  const panelRunIds = new Set(panelRuns.map((run) => run.id));
  const runLookup = new Map(panelRuns.map((run) => [run.id, run]));
  const hasFetchedMetric = Object.prototype.hasOwnProperty.call(workspaceSeries, panel.metricKey);
  const rawSeries = (workspaceSeries[panel.metricKey] ?? []).filter((item) => panelRunIds.has(item.id) && (item.points?.length ?? 0) > 0);
  const loadingSeries = panelRuns.length > 0 && !hasFetchedMetric;
  const missingSeriesCount = Math.max(0, panelRuns.length - rawSeries.length);
  const plottedRunLabel = selectedVisibleRuns.length
    ? loadingSeries
      ? `loading ${panelRuns.length} selected`
      : `${rawSeries.length} plotted / ${panelRuns.length} selected`
    : loadingSeries
      ? `loading ${panelRuns.length} visible`
      : `${rawSeries.length}/${panelRuns.length} visible`;
  const groupedSeries = rawSeries.map((item) => {
    const run = runLookup.get(item.id);
    return { ...item, group: run ? groupKeyForRun(run, settings.groupBy) : item.group ?? "all" };
  });
  const preparedSeries = smoothSeries(settings.groupAverage ? averageGroupedSeries(groupedSeries) : groupedSeries, settings.smoothing);
  const fullDomain = chartDomain(preparedSeries, settings.xMode, panel.metricKey);
  const rangeSeries = normalizeSeries(preparedSeries, panelChartWidth, panelChartHeight, panelChartPadding, settings.xMode, panel.metricKey);
  const normalized = normalizeSeries(preparedSeries, panelChartWidth, panelChartHeight, panelChartPadding, settings.xMode, panel.metricKey, panelZoomRange);
  const domain = chartDomain(preparedSeries, settings.xMode, panel.metricKey, panelZoomRange);
  useEffect(() => {
    setPanelHover(null);
    setPanelZoomRange(null);
  }, [panel.metricKey, settings.xMode, settings.groupBy, settings.groupAverage, settings.smoothing, settings.maxRuns, selectedRunIds.join(",")]);
  function handlePanelChartMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = svgPointFromClient(rect, event.clientX, event.clientY, panelChartWidth, panelChartHeight);
    setPanelHover(nearestPoint(normalized, point.x, point.y, 28) as HoverPoint);
  }
  function handleResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!onResize) return;
    const commitResize = onResize;
    event.preventDefault();
    event.stopPropagation();
    const card = event.currentTarget.closest<HTMLElement>(".workspace-panel-card");
    const grid = event.currentTarget.closest<HTMLElement>(".workspace-panel-grid");
    if (!card || !grid) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLayout = normalizedPanelLayout(panel.layout);
    const columnUnit = Math.max(1, grid.getBoundingClientRect().width / 12);
    const rowUnit = 78;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    const target = event.currentTarget;
    function handlePointerMove(pointerEvent: globalThis.PointerEvent) {
      const next = {
        w: Math.max(3, Math.min(12, Math.round(startLayout.w + (pointerEvent.clientX - startX) / columnUnit))),
        h: Math.max(3, Math.min(10, Math.round(startLayout.h + (pointerEvent.clientY - startY) / rowUnit))),
      };
      setResizePreview(next);
    }
    function handlePointerUp(pointerEvent: globalThis.PointerEvent) {
      const next = {
        w: Math.max(3, Math.min(12, Math.round(startLayout.w + (pointerEvent.clientX - startX) / columnUnit))),
        h: Math.max(3, Math.min(10, Math.round(startLayout.h + (pointerEvent.clientY - startY) / rowUnit))),
      };
      setResizePreview(null);
      commitResize(next);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }
  return (
    <article
      className={`workspace-panel-card ${className}`}
      data-panel-id={panel.id}
      data-panel-width={layout.w}
      data-panel-height={layout.h}
      onDragOver={(event) => {
        if (onDropBefore) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onDropBefore) return;
        event.preventDefault();
        event.stopPropagation();
        onDropBefore(event);
      }}
      style={panelStyle}
    >
      <div className="workspace-panel-head">
        <div>
          <h3>
            {onDragStart ? (
              <span
                aria-hidden="true"
                className="panel-drag-handle"
                draggable={!panelSearchActive}
                onDragEnd={onDragEnd}
                onDragStart={(event) => {
                  if (panelSearchActive) {
                    event.preventDefault();
                    return;
                  }
                  onDragStart(event);
                }}
                onPointerDown={(event) => {
                  if (panelSearchActive) {
                    event.preventDefault();
                    return;
                  }
                  onPointerMoveStart?.(event);
                }}
                title={panelSearchActive ? "Clear panel search before rearranging panels" : "Drag to move panel"}
              >
                <GripVertical size={14} />
              </span>
            ) : null}
            <span className="panel-title-text">{panel.title}</span>
          </h3>
          <small>{panel.metricKey} · {plottedRunLabel}</small>
        </div>
        <div className="panel-card-actions">
          {onEdit ? <button className="icon-button" type="button" aria-label={`Edit ${panel.title}`} onClick={onEdit}><Pencil size={15} /></button> : null}
          {onDuplicate ? <button className="icon-button" type="button" aria-label={`Duplicate ${panel.title}`} onClick={onDuplicate}><CopyPlus size={15} /></button> : null}
          {onFullscreen ? <button className="icon-button" type="button" aria-label={`Fullscreen ${panel.title}`} onClick={onFullscreen}><Maximize2 size={15} /></button> : null}
          {onRemove ? <button className="icon-button" type="button" aria-label={`Remove ${panel.title}`} onClick={onRemove}><Trash2 size={15} /></button> : null}
        </div>
      </div>
      <div className="workspace-panel-meta">
        <span>{settings.xMode === "time" ? "Logged time" : "Step"}</span>
        <span>{settings.groupBy ? `Grouped by ${settings.groupBy}` : "Ungrouped"}</span>
        <span>{settings.smoothing ? `Smooth ${settings.smoothing}` : "Full fidelity"}</span>
        {selectedVisibleRuns.length ? <span>{selectedOverflow ? `${panelRuns.length}/${selectedVisibleRuns.length} selected` : `${panelRuns.length} selected`}</span> : <span>{panelRuns.length} visible</span>}
        {missingSeriesCount && !loadingSeries ? <span className="panel-data-gap">{missingSeriesCount} no data for metric</span> : null}
      </div>
      {loadingSeries ? (
        <div className="chart-area workspace-chart-loading" aria-label={`Loading ${panel.title} metric series`}>
          <div className="chart-loading-frame">
            <span />
            <span />
            <span />
          </div>
          <div className="empty">Loading metric series...</div>
        </div>
      ) : (
        <MetricChart
          domain={domain}
          emptyMessage={panelRuns.length ? "No logged series for this metric in the current run set." : undefined}
          fullDomain={fullDomain}
          height={panelChartHeight}
          hover={panelHover}
          metricKey={panel.metricKey}
          normalizedSeries={normalized}
          onMove={handlePanelChartMove}
          onPointHover={setPanelHover}
          onLeave={() => setPanelHover(null)}
          onZoomRangeChange={setPanelZoomRange}
          padding={panelChartPadding}
          rangeSeries={rangeSeries}
          width={panelChartWidth}
          xMode={settings.xMode}
          zoomRange={panelZoomRange}
        />
      )}
      {onResize ? (
        <button
          aria-label={`Resize ${panel.title}`}
          className="panel-resize-handle"
          onPointerDown={handleResizeStart}
          title="Drag to resize panel"
          type="button"
        />
      ) : null}
    </article>
  );
}

export function PanelEditDrawer({
  metricOptions,
  onClose,
  onUpdate,
  panel,
  section,
  view,
}: {
  metricOptions: string[];
  onClose: () => void;
  onUpdate: (patch: { title?: string; metricKey?: string; settings?: Partial<WorkspacePanelSettings> }) => void;
  panel: WorkspacePanel;
  section: WorkspaceSection;
  view: WorkspaceView;
}) {
  const settings = resolveWorkspaceSettings(view, section, panel);
  const drawerRef = useFocusTrap<HTMLElement>(true, onClose, "input, button[aria-label='Close edit panel']");
  return (
    <aside className="panel-drawer edit-drawer" role="dialog" aria-modal="true" aria-label="Edit panel" ref={drawerRef} tabIndex={-1}>
      <div className="drawer-head">
        <h2>Line plot</h2>
        <button className="icon-button" type="button" aria-label="Close edit panel" onClick={onClose}><X size={16} /></button>
      </div>
      <label className="control full">
        Title
        <input value={panel.title} onChange={(event) => onUpdate({ title: event.target.value })} />
      </label>
      <CustomSelect
        className="full"
        id="edit-panel-metric"
        label="Y"
        onChange={(metricKey) => onUpdate({ metricKey })}
        options={metricOptions.length ? metricOptions.map((metric) => ({ value: metric, label: metric })) : [{ value: panel.metricKey, label: panel.metricKey }]}
        value={panel.metricKey}
      />
      <CustomSelect
        className="full"
        id="edit-panel-x"
        label="X axis"
        onChange={(xMode) => onUpdate({ settings: { xMode: xMode === "time" ? "time" : "step" } })}
        options={[{ value: "step", label: "Step" }, { value: "time", label: "Logged time" }]}
        value={settings.xMode}
      />
      <CustomSelect
        className="full"
        id="edit-panel-group"
        label="Group"
        onChange={(groupBy) => onUpdate({ settings: { groupBy } })}
        options={[
          { value: "", label: "None" },
          { value: "seed", label: "Seed" },
          { value: "tag", label: "First tag" },
          { value: "config:algo", label: "Config: algo" },
          { value: "config:policy", label: "Config: policy" },
        ]}
        value={settings.groupBy}
      />
      <label className="control full">
        Max runs to show
        <input type="number" min="1" max="25" value={settings.maxRuns} onChange={(event) => onUpdate({ settings: { maxRuns: Number(event.target.value) } })} />
      </label>
      <label className="control full">
        Smoothing
        <input type="range" min="0" max="90" step="10" value={settings.smoothing} onChange={(event) => onUpdate({ settings: { smoothing: Number(event.target.value) } })} />
      </label>
      <label className="toggle-control drawer-toggle">
        <span>Show group average</span>
        <input type="checkbox" checked={settings.groupAverage} onChange={(event) => onUpdate({ settings: { groupAverage: event.target.checked } })} />
      </label>
    </aside>
  );
}

function resolveWorkspaceSettings(view: WorkspaceView, section: WorkspaceSection, panel: WorkspacePanel): WorkspacePanelSettings {
  return {
    xMode: panel.settings?.xMode ?? section.settings?.xMode ?? view.settings.xMode,
    smoothing: panel.settings?.smoothing ?? section.settings?.smoothing ?? view.settings.smoothing,
    groupBy: panel.settings?.groupBy ?? section.settings?.groupBy ?? view.settings.groupBy,
    groupAverage: panel.settings?.groupAverage ?? section.settings?.groupAverage ?? view.settings.groupAverage,
    maxRuns: panel.settings?.maxRuns ?? section.settings?.maxRuns ?? view.settings.maxRuns,
  };
}

function normalizedPanelLayout(layout?: WorkspacePanelLayout): WorkspacePanelLayout {
  return {
    w: typeof layout?.w === "number" && Number.isFinite(layout.w) ? Math.max(3, Math.min(12, Math.round(layout.w))) : 6,
    h: typeof layout?.h === "number" && Number.isFinite(layout.h) ? Math.max(3, Math.min(10, Math.round(layout.h))) : 4,
  };
}

function panelMatchesSearch(section: WorkspaceSection, panel: WorkspacePanel, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return `${section.name} ${panel.title} ${panel.metricKey}`.toLowerCase().includes(needle);
}

function readDraggedPanel(event: DragEvent<HTMLElement>): DraggedWorkspacePanel | null {
  try {
    const raw = event.dataTransfer.getData("application/x-rlobs-panel");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraggedWorkspacePanel>;
    return typeof parsed.sectionId === "string" && typeof parsed.panelId === "string"
      ? { sectionId: parsed.sectionId, panelId: parsed.panelId }
      : null;
  } catch {
    return null;
  }
}

export function RunsTable({
  columns,
  metricKey,
  onClearFilters,
  onInspectRun,
  onToggleRun,
  pinnedMetrics,
  primaryRunId,
  runs,
  selectedRunIds,
}: {
  columns: TableColumns;
  metricKey: string;
  onClearFilters: () => void;
  onInspectRun: (runId: string) => void;
  onToggleRun: (runId: string) => void;
  pinnedMetrics: string[];
  primaryRunId: string;
  runs: RunSummary[];
  selectedRunIds: string[];
}) {
  const visibleColumnCount = 2 + Object.values(columns).filter(Boolean).length + pinnedMetrics.length;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="col-select" aria-label="Compare selection" />
            <th className="col-run">Run</th>
            {columns.status ? <th className="col-status">Status</th> : null}
            {columns.tags ? <th className="col-tags">Tags</th> : null}
            {columns.notes ? <th className="col-notes">Notes</th> : null}
            {columns.started ? <th className="col-started">Started</th> : null}
            {columns.duration ? <th className="col-duration">Dur.</th> : null}
            {columns.latest ? <th className="col-latest" id="table-metric-label" title={metricKey}>Latest {shortMetricName(metricKey)}</th> : null}
            {pinnedMetrics.map((metric) => <th className="col-pinned" key={metric} title={metric}>{shortMetricName(metric)}</th>)}
          </tr>
        </thead>
        <tbody>
          {runs.length ? runs.map((run) => {
            const selected = selectedRunIds.includes(run.id);
            const inspected = run.id === primaryRunId;
            const note = runNoteText(run);
            return (
              <tr key={run.id} className={`${selected ? "selected" : ""} ${inspected ? "inspected" : ""}`}>
                <td className="col-select">
                  <label className="row-check">
                    <input
                      aria-label={`Include ${run.name} in comparison`}
                      checked={selected}
                      onChange={() => onToggleRun(run.id)}
                      type="checkbox"
                    />
                  </label>
                </td>
                <td className="col-run">
                  <div className="run-name">
                    <button className="run-name-button" aria-label={`Inspect ${run.name}`} onClick={() => onInspectRun(run.id)} type="button">
                      <Star size={13} /> {run.name}
                    </button>
                    <small>{run.project} · {runConfigSummary(run)}</small>
                  </div>
                </td>
                {columns.status ? <td className="col-status"><span className={`pill ${statusTone(run.status)}`}>{run.status}</span></td> : null}
                {columns.tags ? <td className="col-tags"><Chips values={run.tags} /></td> : null}
                {columns.notes ? <td className="col-notes"><span className="note-preview" title={note}>{note || "-"}</span></td> : null}
                {columns.started ? <td className="col-started">{formatRunTime(run.started_at ?? run.created_at)}</td> : null}
                {columns.duration ? <td className="col-duration">{durationLabel(run)}</td> : null}
                {columns.latest ? <td className="col-latest">{formatNumber(bestMetric(run, metricKey), 2)}</td> : null}
                {pinnedMetrics.map((metric) => <td className="col-pinned" key={`${run.id}-${metric}`}>{formatNumber(bestMetric(run, metric), 2)}</td>)}
              </tr>
            );
          }) : (
            <tr className="empty-row">
              <td colSpan={visibleColumnCount}>
                <div className="table-empty">
                  <strong>No runs match the current filters.</strong>
                  <span>Clear search, project, and status filters to return to the run list.</span>
                  <button className="secondary compact-button" type="button" onClick={onClearFilters}>Clear filters</button>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ChartControls(props: {
  idPrefix?: string;
  metricFilter: string;
  metricFilterValid: boolean;
  metricKey: string;
  metricOptions: string[];
  groupBy: string;
  xMode: string;
  smoothing: number;
  groupAverage: boolean;
  pinnedMetrics: string[];
  onMetricFilter: (value: string) => void;
  onMetricKey: (value: string) => void;
  onGroupBy: (value: string) => void;
  onXMode: (value: string) => void;
  onSmoothing: (value: number) => void;
  onGroupAverage: (value: boolean) => void;
  onPinnedMetric: (metric: string) => void;
}) {
  const idPrefix = props.idPrefix ?? "";
  return (
    <div className="panel-controls">
      <label className={`control metric-filter-control ${props.metricFilterValid ? "" : "invalid"}`}>
        Metric filter
        <input id={`${idPrefix}metric-filter`} type="search" value={props.metricFilter} onChange={(event) => props.onMetricFilter(event.target.value)} placeholder="train/.*" />
      </label>
      <CustomSelect
        disabled={!props.metricOptions.length}
        id={`${idPrefix}metric-select`}
        label="Metric"
        onChange={props.onMetricKey}
        options={props.metricOptions.length ? props.metricOptions.map((metric) => ({ value: metric, label: metric })) : [{ value: "", label: "No metrics", disabled: true }]}
        value={props.metricOptions.length ? props.metricKey : ""}
      />
      <button
        className={`secondary compact-button pin-button ${props.pinnedMetrics.includes(props.metricKey) ? "active" : ""}`}
        disabled={!props.metricKey}
        id={`${idPrefix}pin-metric`}
        onClick={() => props.onPinnedMetric(props.metricKey)}
        type="button"
      >
        <Star size={14} /> {props.pinnedMetrics.includes(props.metricKey) ? "Pinned" : "Pin"}
      </button>
      <CustomSelect
        id={`${idPrefix}group-select`}
        label="Group"
        onChange={props.onGroupBy}
        options={[
          { value: "", label: "None" },
          { value: "seed", label: "Seed" },
          { value: "tag", label: "First tag" },
          { value: "config:algo", label: "Config: algo" },
          { value: "config:policy", label: "Config: policy" },
        ]}
        value={props.groupBy}
      />
      <CustomSelect
        id={`${idPrefix}x-mode`}
        label="X axis"
        onChange={props.onXMode}
        options={[
          { value: "step", label: "Step" },
          { value: "time", label: "Logged time" },
        ]}
        value={props.xMode}
      />
      <label className="control">
        Smooth {props.smoothing}
        <input id={`${idPrefix}smoothing`} type="range" min="0" max="90" step="10" value={props.smoothing} onChange={(event) => props.onSmoothing(Number(event.target.value))} />
      </label>
      <label className="control">
        Avg
        <input id={`${idPrefix}group-average`} type="checkbox" checked={props.groupAverage} onChange={(event) => props.onGroupAverage(event.target.checked)} />
      </label>
    </div>
  );
}

export function RunMetadataEditor({
  compact = false,
  onSave,
  run,
  title = "Tags and notes",
}: {
  compact?: boolean;
  onSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  run: RunSummary | null;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [tagsText, setTagsText] = useState("");
  const [notesText, setNotesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const runTagsSignature = (run?.tags ?? []).join("\u001f");
  const runNote = run ? runNoteText(run) : "";

  useEffect(() => {
    setEditing(false);
    setTagsText(tagInputValue(run?.tags ?? []));
    setNotesText(runNote);
    setError("");
  }, [run?.id, runNote, runTagsSignature]);

  if (!run) return null;
  const note = runNote;
  const currentTags = tagInputValue(run.tags);
  const dirty = tagsText.trim() !== currentTags || notesText.trim() !== note;
  const noteTooLong = new TextEncoder().encode(notesText.trim()).length > 512;
  const parsedTags = parseTagInput(tagsText);
  const disabled = !onSave || saving || !dirty || noteTooLong;

  async function save() {
    if (!onSave || disabled || !run) return;
    const runId = run.id;
    setSaving(true);
    setError("");
    try {
      await onSave(runId, { tags: parsedTags, notes: notesText.trim() });
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save tags and notes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={`run-metadata-editor ${compact ? "compact" : ""}`} aria-label={title}>
      <div className="run-metadata-head">
        <span>
          <strong>{title}</strong>
          <small>{run.name}</small>
        </span>
        {editing ? (
          <span className="metadata-actions">
            <button className="secondary compact-button" type="button" onClick={() => {
              setEditing(false);
              setTagsText(currentTags);
              setNotesText(note);
              setError("");
            }} disabled={saving}><X size={14} /> Cancel</button>
            <button className="primary compact-button" type="button" onClick={save} disabled={disabled}><Save size={14} /> {saving ? "Saving" : "Save"}</button>
          </span>
        ) : (
          <button className="secondary compact-button" type="button" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
        )}
      </div>
      {editing ? (
        <div className="metadata-edit-grid">
          <label className="control">
            Tags
            <textarea className="tag-textarea" value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="baseline, needs-review" rows={compact ? 2 : 3} />
          </label>
          <div className="metadata-tag-preview" aria-label="Parsed tags">
            {parsedTags.length ? parsedTags.map((tag) => <span className="chip" key={tag} title={tag}>{tag}</span>) : <span className="compare-empty">No tags</span>}
          </div>
          <label className="control notes-control">
            Notes
            <textarea value={notesText} onChange={(event) => setNotesText(event.target.value)} placeholder="Why this run matters" rows={compact ? 2 : 4} />
          </label>
          {noteTooLong ? <small className="form-error">Notes must be at most 512 bytes.</small> : null}
          {error ? <small className="form-error">{error}</small> : null}
        </div>
      ) : (
        <div className="metadata-read">
          <TagList tags={run.tags} />
          <p title={note}>{note || "No notes yet."}</p>
        </div>
      )}
    </section>
  );
}

export function RunsChartStrip({ smoothing, groupAverage, onSmoothing, onGroupAverage }: { smoothing: number; groupAverage: boolean; onSmoothing: (value: number) => void; onGroupAverage: (value: boolean) => void }) {
  return (
    <div className="runs-chart-strip">
      <label className="control smoothing-control">
        <span>Smoothing</span>
        <input id="runs-smoothing" type="range" min="0" max="90" step="10" value={smoothing} onChange={(event) => onSmoothing(Number(event.target.value))} />
        <strong>{(smoothing / 100).toFixed(1)}</strong>
      </label>
      <label className="toggle-control">
        <span>Grouped avg</span>
        <input id="runs-group-average" type="checkbox" checked={groupAverage} onChange={(event) => onGroupAverage(event.target.checked)} />
      </label>
    </div>
  );
}

export function MetricChart({
  domain,
  emptyMessage = "Select one or more runs and a metric to draw the chart.",
  fullDomain,
  height = chartHeight,
  hover,
  metricKey,
  normalizedSeries,
  onMove,
  onPointHover,
  onLeave,
  onZoomRangeChange,
  padding = chartPadding,
  rangeSeries,
  showRange = true,
  width = chartWidth,
  xMode,
  zoomRange = null,
}: {
  domain: any;
  emptyMessage?: string;
  fullDomain?: any;
  height?: number;
  hover: HoverPoint;
  metricKey: string;
  normalizedSeries: any[];
  onMove: (event: MouseEvent<SVGSVGElement>) => void;
  onPointHover: (point: HoverPoint) => void;
  onLeave: () => void;
  onZoomRangeChange?: (range: ChartZoomRange) => void;
  padding?: number;
  rangeSeries?: any[];
  showRange?: boolean;
  width?: number;
  xMode: string;
  zoomRange?: ChartZoomRange;
}) {
  if (!domain || normalizedSeries.every((item) => !item.normalizedPoints?.length)) {
    return <div className="chart-area"><div className="empty">{emptyMessage}</div></div>;
  }
  const pointCount = normalizedSeries.reduce((sum, item) => sum + (item.normalizedPoints?.length ?? 0), 0);
  const showPointNodes = pointCount <= 1200;
  const xTicks = axisTicks(domain.minX, domain.maxX, 5);
  const yTicks = axisTicks(domain.minY, domain.maxY, 5);
  const xSpan = Math.max(1, domain.maxX - domain.minX);
  const ySpan = Math.max(1, domain.maxY - domain.minY);
  const xPos = (value: number) => padding + ((value - domain.minX) / xSpan) * (width - padding * 2);
  const yPos = (value: number) => height - padding - ((value - domain.minY) / ySpan) * (height - padding * 2);
  const hoverRows = hover ? tooltipRows(normalizedSeries, hover.point.xValue, xMode, hover.runId) : [];
  const hoverEdge = hover ? (hover.point.x < width * 0.3 ? "edge-left" : hover.point.x > width * 0.62 ? "edge-right" : "") : "";
  const hoverLeft = hover ? (hoverEdge === "edge-left" ? "16px" : `${Math.min(82, Math.max(18, (hover.point.x / width) * 100))}%`) : "0px";
  const legendLimit = normalizedSeries.length <= 12 ? normalizedSeries.length : 8;
  const legendSeries = normalizedSeries.slice(0, legendLimit);

  return (
    <div className="chart-area">
      <div className="chart-legend">
        {legendSeries.map((item, index) => (
          <span className="legend-chip" key={item.id}><i className={`legend-dot dot-${index % 5}`} style={{ backgroundColor: chartColor(index) }} /> {item.name}</span>
        ))}
        {normalizedSeries.length > legendSeries.length ? <span className="legend-chip legend-overflow">+{normalizedSeries.length - legendSeries.length} more plotted</span> : null}
      </div>
      <svg className="metric-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metricKey} metric chart`} onMouseMove={onMove} onMouseLeave={onLeave}>
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line className="grid-line" x1={padding} x2={width - padding} y1={yPos(tick)} y2={yPos(tick)} />
            <text className="tick-label" x={padding - 10} y={yPos(tick) + 4} textAnchor="end">{formatNumber(tick, 2)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x-${tick}`}>
            <line className="grid-line" x1={xPos(tick)} x2={xPos(tick)} y1={padding} y2={height - padding} />
            <text className="tick-label" x={xPos(tick)} y={height - 25} textAnchor="middle">{formatAxisValue(tick, xMode)}</text>
          </g>
        ))}
        <line className="axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <line className="axis" x1={padding} x2={padding} y1={padding} y2={height - padding} />
        <text className="axis-label" x={width / 2} y={height - 5} textAnchor="middle">{xMode === "time" ? "Logged time" : "Training step"}</text>
        <text className="axis-label" x={18} y={height / 2} textAnchor="middle" transform={`rotate(-90 18 ${height / 2})`}>{metricTitle(metricKey)}</text>
        {hover ? <line className="hover-guide" x1={hover.point.x} x2={hover.point.x} y1={padding} y2={height - padding} /> : null}
        {normalizedSeries.map((item, index) => (
          <g key={item.id}>
            <polyline className={`series series-${index % 5}`} points={item.path} style={{ stroke: chartColor(index) }} />
            {showPointNodes ? (item.normalizedPoints ?? []).map((point: any) => (
              <circle
                key={`${item.id}-${point.step}-${point.created_at}`}
                className={`series-point point-${index % 5}`}
                cx={point.x}
                cy={point.y}
                style={{ fill: chartColor(index), stroke: "var(--chart-card-bg, var(--surface))" }}
                onMouseEnter={() => onPointHover({ runId: item.id, runName: item.name, group: item.group, point, distance: 0 })}
                r={2.4}
              />
            )) : null}
          </g>
        ))}
        {hover ? <circle className="hover-ring" cx={hover.point.x} cy={hover.point.y} r={8} /> : null}
      </svg>
      {hover ? (
        <div
          className={`chart-tooltip ${hoverEdge}`}
          style={{ left: hoverLeft, top: `${Math.min(76, Math.max(18, (hover.point.y / height) * 100))}%` }}
        >
          <strong>{xMode === "time" ? formatAxisValue(hover.point.xValue, xMode) : `Step ${formatNumber(hover.point.step, 0)}`}</strong>
          {hoverRows.map((row) => (
            <span className={row.id === hover.runId ? "active" : ""} key={row.id}>
              <i className={`legend-dot dot-${row.index % 5}`} style={{ backgroundColor: chartColor(row.index) }} /> {row.name}
              <b>{formatNumber(row.value, 3)}</b>
            </span>
          ))}
        </div>
      ) : null}
      {showRange ? (
        <div className="chart-range-row">
          <MiniRange
            domain={fullDomain ?? domain}
            normalizedSeries={rangeSeries ?? normalizedSeries}
            onZoomRangeChange={onZoomRangeChange}
            width={width}
            xMode={xMode}
            zoomRange={zoomRange}
          />
          {zoomRange && onZoomRangeChange ? (
            <button className="chart-zoom-reset" type="button" onClick={() => onZoomRangeChange(null)}>
              <RefreshCw size={13} /> Reset zoom
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MiniRange({
  domain,
  normalizedSeries,
  onZoomRangeChange,
  width,
  xMode,
  zoomRange,
}: {
  domain: any;
  normalizedSeries: any[];
  onZoomRangeChange?: (range: ChartZoomRange) => void;
  width: number;
  xMode: string;
  zoomRange?: ChartZoomRange;
}) {
  const [dragAnchor, setDragAnchor] = useState<number | null>(null);
  const [draftRange, setDraftRange] = useState<ChartZoomRange>(null);
  const miniWidth = width;
  const miniHeight = 46;
  const padX = 12;
  const padY = 8;
  const xSpan = Math.max(1, domain.maxX - domain.minX);
  const ySpan = Math.max(1, domain.maxY - domain.minY);
  const miniX = (value: number) => padX + ((value - domain.minX) / xSpan) * (miniWidth - padX * 2);
  const miniY = (value: number) => miniHeight - padY - ((value - domain.minY) / ySpan) * (miniHeight - padY * 2);
  const activeRange = sanitizeRange(draftRange ?? zoomRange, domain);
  const activeMinX = activeRange ? miniX(activeRange.min) : 0;
  const activeMaxX = activeRange ? miniX(activeRange.max) : 0;

  function valueFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = svgPointFromClient(rect, event.clientX, event.clientY, miniWidth, miniHeight);
    const plotX = Math.max(padX, Math.min(miniWidth - padX, point.x));
    const ratio = (plotX - padX) / Math.max(1, miniWidth - padX * 2);
    return domain.minX + ratio * (domain.maxX - domain.minX);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!onZoomRangeChange) return;
    event.preventDefault();
    const value = valueFromPointer(event);
    setDragAnchor(value);
    setDraftRange({ min: value, max: value });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (dragAnchor === null) return;
    setDraftRange({ min: dragAnchor, max: valueFromPointer(event) });
  }

  function finishPointerRange(event: ReactPointerEvent<SVGSVGElement>) {
    if (!onZoomRangeChange || dragAnchor === null) return;
    const next = sanitizeRange({ min: dragAnchor, max: valueFromPointer(event) }, domain);
    setDragAnchor(null);
    setDraftRange(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!next || (next.max - next.min) < Math.max(1, (domain.maxX - domain.minX) * 0.03)) {
      onZoomRangeChange(null);
      return;
    }
    onZoomRangeChange(next);
  }

  return (
    <div className="chart-range" aria-label={`${xMode === "time" ? "Time" : "Step"} range overview`}>
      <svg
        viewBox={`0 0 ${miniWidth} ${miniHeight}`}
        aria-label={`Drag to zoom ${xMode === "time" ? "time" : "step"} range`}
        onPointerCancel={finishPointerRange}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerRange}
        role="img"
      >
        {normalizedSeries.slice(0, 5).map((item, index) => (
          <polyline
            className={`range-series series-${index % 5}`}
            key={item.id}
            points={(item.normalizedPoints ?? []).map((point: any) => `${miniX(point.xValue).toFixed(2)},${miniY(point.value).toFixed(2)}`).join(" ")}
          />
        ))}
        {activeRange ? (
          <>
            <rect className="range-window" x={activeMinX} y={3} width={Math.max(2, activeMaxX - activeMinX)} height={miniHeight - 6} />
            <line className="range-handle" x1={activeMinX} x2={activeMinX} y1={3} y2={miniHeight - 3} />
            <line className="range-handle" x1={activeMaxX} x2={activeMaxX} y1={3} y2={miniHeight - 3} />
          </>
        ) : null}
      </svg>
    </div>
  );
}

function sanitizeRange(range: ChartZoomRange | undefined, domain: any): ChartZoomRange {
  if (!range || !domain) return null;
  const min = Math.max(domain.minX, Math.min(Number(range.min), Number(range.max)));
  const max = Math.min(domain.maxX, Math.max(Number(range.min), Number(range.max)));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

function tooltipRows(normalizedSeries: any[], xValue: number, xMode: string, activeRunId?: string) {
  const indexed = normalizedSeries.map((item, index) => ({ item, index }));
  const active = activeRunId ? indexed.find((entry) => entry.item.id === activeRunId) : null;
  const rows = active
    ? [active, ...indexed.filter((entry) => entry.item.id !== activeRunId).slice(0, 4)]
    : indexed.slice(0, 5);
  return rows.map(({ item, index }) => {
    const points = item.normalizedPoints ?? [];
    const nearest = points.reduce((best: any, point: any) => {
      if (!best) return point;
      return Math.abs(point.xValue - xValue) < Math.abs(best.xValue - xValue) ? point : best;
    }, null);
    return {
      id: item.id,
      index,
      name: item.name,
      value: nearest?.value ?? null,
      label: xMode === "time" ? formatAxisValue(nearest?.xValue, xMode) : `Step ${formatNumber(nearest?.step, 0)}`,
    };
  });
}

export function HoverDetail({ hover, metricKey }: { hover: HoverPoint; metricKey: string }) {
  if (!hover) return <div className="empty">Hover a chart point to inspect the run at that timestamp.</div>;
  return (
    <div className="readout">
      <div className="readout-card">
        <span className="subtle">{hover.runName}</span>
        <strong>{formatNumber(hover.point.value, 4)}</strong>
        <small>{metricKey} at step {hover.point.step}</small>
        <small>{hover.point.created_at ? new Date(hover.point.created_at).toLocaleString() : "No timestamp"}</small>
      </div>
    </div>
  );
}

export function SeriesSummary({ summaries }: { summaries: Array<{ id: string; name: string; last: number | null }> }) {
  return (
    <div className="summary-list">
      <h3 className="subsection-title">Selected Series</h3>
      {summaries.map((item) => (
        <div className="summary-row" key={item.id}>
          <span>{item.name}</span>
          <strong>{formatNumber(item.last, 3)}</strong>
        </div>
      ))}
    </div>
  );
}

export function MetricCatalog({
  activeMetric,
  onMetricKey,
  onPinnedMetric,
  pinnedMetrics,
  rows,
}: {
  activeMetric: string;
  onMetricKey: (metric: string) => void;
  onPinnedMetric: (metric: string) => void;
  pinnedMetrics: string[];
  rows: MetricCatalogRow[];
}) {
  if (!rows.length) return <div className="empty">No metrics are available for the current run filters.</div>;
  return (
    <div className="metric-catalog">
      {rows.map((row) => {
        const pinned = pinnedMetrics.includes(row.key);
        const active = row.key === activeMetric;
        return (
          <article className={`metric-catalog-row ${active ? "active" : ""}`} key={row.key}>
            <button className="metric-catalog-main" onClick={() => onMetricKey(row.key)} type="button">
              <span>
                <strong>{row.label}</strong>
                <small>{row.namespace} · {row.selectedCount}/{row.runCount} selected · {formatNumber(row.pointCount, 0)} pts</small>
              </span>
              <b>{formatNumber(row.best, 3)}</b>
            </button>
            <button
              aria-label={pinned ? `Unpin ${row.key}` : `Pin ${row.key}`}
              aria-pressed={pinned}
              className={`icon-button metric-pin ${pinned ? "active" : ""}`}
              onClick={() => onPinnedMetric(row.key)}
              title={pinned ? "Pinned metric" : "Pin metric"}
              type="button"
            >
              <Star size={13} />
            </button>
          </article>
        );
      })}
    </div>
  );
}

export function MetricLeaderboard({ metricKey, runs }: { metricKey: string; runs: RunSummary[] }) {
  const goal = metricGoal(metricKey);
  const ranked = runs
    .map((run) => ({ run, aggregate: run.metric_aggregates?.[metricKey], value: metricGoalValue(run, metricKey) }))
    .filter((item) => item.aggregate)
    .sort((left, right) => goal === "minimize"
      ? (left.value ?? Number.POSITIVE_INFINITY) - (right.value ?? Number.POSITIVE_INFINITY)
      : (right.value ?? Number.NEGATIVE_INFINITY) - (left.value ?? Number.NEGATIVE_INFINITY))
    .slice(0, 6);
  if (!ranked.length) return <div className="empty compact-empty">No selected runs have {metricKey} yet.</div>;
  return (
    <div className="leaderboard-list">
      <h3 className="subsection-title">{metricGoalLabel(metricKey)} Leaderboard</h3>
      {ranked.map(({ run, aggregate, value }, index) => (
        <article className="leaderboard-row" key={run.id}>
          <span className="rank">{index + 1}</span>
          <span>
            <strong>{run.name}</strong>
            <small>{goal === "minimize" ? "minimum value" : `best step ${compactValue(aggregate?.best_step ?? "-")}`}</small>
          </span>
          <b>{formatNumber(value, 3)}</b>
        </article>
      ))}
    </div>
  );
}

export function RunDetail({
  activeMetricKey,
  artifacts = [],
  elementId,
  hover,
  loggedObjects = [],
  metricRows,
  objectRowsById = {},
  onRunMetadataSave,
  run,
  selectedCount,
  selectedRuns,
  timelineRows,
  workspaceSummary = false,
}: {
  activeMetricKey: string;
  artifacts?: Artifact[];
  elementId: string;
  hover: HoverPoint;
  loggedObjects?: LoggedObject[];
  metricRows: RunMetricRow[];
  objectRowsById?: Record<number, LoggedObjectRow[]>;
  onRunMetadataSave?: (runId: string, patch: { tags: string[]; notes: string }) => Promise<void>;
  run: RunSummary | null;
  selectedCount: number;
  selectedRuns?: RunSummary[];
  timelineRows: RunTimelineRow[];
  workspaceSummary?: boolean;
}) {
  if (!run) return <div className="empty">No run selected.</div>;
  const chartRuns = selectedRuns?.length ? selectedRuns : [run];
  const sourceRows = [
    ["Start time", formatRunTime(run.started_at ?? run.created_at)],
    ["End time", run.finished_at ? formatRunTime(run.finished_at) : "-"],
    ["Duration", durationLabel(run)],
    ["Host", compactValue(run.metadata.hostname ?? run.metadata.host ?? "-")],
    ["PID", compactValue(run.metadata.pid ?? "-")],
    ["Commit", compactValue(run.metadata.git_commit ?? run.metadata.commit ?? "-")],
  ];
  const artifactRows = artifacts.slice(0, 4);
  const artifactCount = artifactCountForRun(run, artifacts.length);
  const activeMetric = run.metric_aggregates?.[activeMetricKey];
  const activeBest = metricGoal(activeMetricKey) === "minimize" ? activeMetric?.min : activeMetric?.max;
  const configRows = [
    ["Algorithm", compactValue(run.config.algo ?? run.config.model ?? run.config.policy ?? "-")],
    ["Dataset/env", compactValue(run.config.dataset ?? run.config.dataset_name ?? run.config.env ?? "-")],
    ["Seed", compactValue(run.config.seed ?? "-")],
    ["Learning rate", compactValue(run.config.learning_rate ?? run.config.lr ?? "-")],
    ["Batch size", compactValue(run.config.batch_size ?? run.config.batch ?? "-")],
    ["Epochs/steps", compactValue(run.config.epochs ?? run.config.steps ?? run.config.total_steps ?? "-")],
  ];
  return (
    <div className={`detail-stack ${workspaceSummary ? "workspace-summary" : ""}`} id={elementId}>
      {!workspaceSummary ? (
        <header className="run-detail-hero">
          <div className="run-detail-title">
            <span className="analysis-eyebrow">Selected run</span>
            <h2 title={run.name}>{run.name}</h2>
            <p>{run.project} · {durationLabel(run)} · {selectedCount ? `${selectedCount} runs selected for charts` : "not in comparison set"}</p>
          </div>
          <div className="run-detail-badges">
            <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
            {run.tags?.slice(0, 3).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
            {(run.tags?.length ?? 0) > 3 ? <span className="chip">+{(run.tags?.length ?? 0) - 3}</span> : null}
          </div>
        </header>
      ) : null}
      <RunMetadataEditor compact onSave={onRunMetadataSave} run={run} title="Run tags and notes" />
      {!workspaceSummary ? (
        <section className="detail-section chart-selection-section">
          <h3><Activity size={15} /> Chart selection</h3>
          <div className="chart-selection-list">
            {chartRuns.slice(0, 8).map((selectedRun) => (
              <span className={selectedRun.id === run.id ? "active" : ""} key={selectedRun.id} title={selectedRun.name}>
                {selectedRun.name}
              </span>
            ))}
            {chartRuns.length > 8 ? <em>+{chartRuns.length - 8} more</em> : null}
          </div>
        </section>
      ) : selectedCount ? (
        <div className="workspace-summary-selection">
          <Activity size={14} />
          <span>{selectedCount} runs selected for chart context</span>
          <strong>{shortMetricName(activeMetricKey)}</strong>
        </div>
      ) : null}
      <div className="run-kpi-grid">
        <MetricCard label={`Latest ${shortMetricName(activeMetricKey)}`} value={formatNumber(activeMetric?.latest, 3)} tone="neutral" />
        <MetricCard label={`${metricGoalLabel(activeMetricKey)} ${shortMetricName(activeMetricKey)}`} value={formatNumber(activeBest, 3)} tone="good" />
        <MetricCard label="Metric keys" value={formatNumber(metricRows.length, 0)} tone="live" />
        <MetricCard label="Artifacts" value={formatNumber(artifactCount, 0)} tone={artifactCount ? "good" : "neutral"} />
      </div>
      {hover ? <div className="detail-row highlight"><span>Hovered point</span><strong>{hover.runName} / step {hover.point.step} / {formatNumber(hover.point.value, 4)}</strong></div> : null}
      {run.status === "failed" ? (
        <section className="failure-card">
          <strong>Failed run triage</strong>
          <div><span>Last metric step</span><b>{lastMetricStep(run)}</b></div>
          <div><span>Likely reason</span><b>{compactValue(run.metadata.error ?? run.metadata.exit_reason ?? "No failure reason logged")}</b></div>
          <div><span>Checkpoint coverage</span><b>{formatNumber(run.artifact_counts?.checkpoint ?? 0, 0)} checkpoints</b></div>
        </section>
      ) : null}
      <div className="detail-body-grid">
        <div className="detail-main-column">
          <section className="detail-section">
            <h3><Database size={15} /> Metric Summary</h3>
            <RunMetricTable rows={metricRows} />
          </section>
          {!workspaceSummary ? (
            <>
              <section className="detail-section">
                <h3><Folder size={15} /> Recent Artifacts ({artifacts.length})</h3>
                {artifactRows.length ? artifactRows.map((artifact) => (
                  <div className="artifact-mini" key={artifact.id}>
                    <span>{artifact.name}</span>
                    <small>{artifact.step === null ? "no step" : `step ${artifact.step}`}</small>
                    <small>{formatBytes(artifact.size_bytes)}</small>
                    <ArtifactMediaPreview artifact={artifact} compact fallback />
                  </div>
                )) : <small>No artifacts logged.</small>}
              </section>
              <RichObjectPanel objects={loggedObjects} rowsByObjectId={objectRowsById} title="Rich Objects" />
            </>
          ) : null}
          <details className="detail-section raw-detail">
            <summary><Database size={15} /> Raw configuration</summary>
            <pre>{JSON.stringify(run.config, null, 2)}</pre>
          </details>
          <details className="detail-section raw-detail">
            <summary><GitBranch size={15} /> Latest metrics</summary>
            <pre>{JSON.stringify(run.latest_metrics, null, 2)}</pre>
          </details>
        </div>
        <aside className="detail-side-rail">
          <section className="detail-section">
            <h3><Activity size={15} /> Timeline</h3>
            <RunTimeline rows={timelineRows} />
          </section>
          <section className="detail-section">
            <h3><Server size={15} /> Source</h3>
            {sourceRows.map(([label, value]) => <div className="detail-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </section>
          <section className="detail-section">
            <h3><Star size={15} /> Reproducibility</h3>
            <InfoRows rows={configRows} />
          </section>
          <section className="detail-section">
            <h3><Tag size={15} /> Tags</h3>
            <Chips values={run.tags} />
          </section>
        </aside>
      </div>
    </div>
  );
}

function artifactCountForRun(run: RunSummary, loadedCount: number) {
  const counted = Object.values(run.artifact_counts ?? {}).reduce((total, value) => (
    total + (typeof value === "number" && Number.isFinite(value) ? value : 0)
  ), 0);
  return counted || loadedCount;
}

export function RichObjectPanel({
  objects,
  rowsByObjectId = {},
  title = "Rich Objects",
}: {
  objects: LoggedObject[];
  rowsByObjectId?: Record<number, LoggedObjectRow[]>;
  title?: string;
}) {
  if (!objects.length) {
    return (
      <section className="detail-section rich-object-section">
        <h3><FileText size={15} /> {title}</h3>
        <small>No rich objects logged.</small>
      </section>
    );
  }
  return (
    <section className="detail-section rich-object-section">
      <h3><FileText size={15} /> {title} ({objects.length})</h3>
      <div className="rich-object-grid">
        {objects.slice(0, 12).map((object) => (
          <RichObjectCard key={object.id} object={object} rows={rowsByObjectId[object.id] ?? []} />
        ))}
      </div>
    </section>
  );
}

function RichObjectCard({ object, rows }: { object: LoggedObject; rows: LoggedObjectRow[] }) {
  const artifact = artifactFromLoggedObject(object);
  return (
    <article className={`rich-object-card kind-${object.kind}`}>
      <div className="rich-object-head">
        <span className="chip">{object.kind}</span>
        <strong title={object.key}>{object.key}</strong>
        <small>{object.step === null ? "no step" : `step ${object.step}`}</small>
      </div>
      {object.kind === "table" ? <TableObjectPreview object={object} rows={rows} /> : null}
      {object.kind === "histogram" ? <HistogramObjectPreview object={object} /> : null}
      {artifact ? <ArtifactMediaPreview artifact={artifact} fallback /> : null}
      {object.kind !== "table" && object.kind !== "histogram" && !artifact ? (
        <small className="artifact-media-fallback">Preview unavailable.</small>
      ) : null}
      <div className="artifact-actions">
        {artifact ? <span>{formatBytes(artifact.size_bytes)}</span> : null}
        <button className="copy-button" type="button" onClick={() => copyText(String(object.id))}><Copy size={13} /> ID</button>
      </div>
    </article>
  );
}

function TableObjectPreview({ object, rows }: { object: LoggedObject; rows: LoggedObjectRow[] }) {
  const summaryColumns = Array.isArray(object.summary?.columns)
    ? object.summary.columns.filter((value): value is string => typeof value === "string")
    : [];
  const rowObjects = rows.map((item) => item.row).slice(0, 20);
  const inferred = rowObjects.flatMap((row) => Object.keys(row));
  const columns = [...new Set([...summaryColumns, ...inferred])].slice(0, 8);
  if (!columns.length) return <small>Table preview is empty.</small>;
  return (
    <div className="rich-table-preview" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(96px, 1fr))` }}>
      {columns.map((column) => <strong key={column} title={column}>{column}</strong>)}
      {rowObjects.map((row, rowIndex) => columns.map((column) => (
        <span key={`${rowIndex}-${column}`} title={compactValue(row[column])}>{shortValue(compactValue(row[column]))}</span>
      )))}
      {Number(object.summary?.row_count ?? rowObjects.length) > rowObjects.length ? (
        <small className="rich-table-more">Showing {rowObjects.length} of {String(object.summary?.row_count)} rows</small>
      ) : null}
    </div>
  );
}

function HistogramObjectPreview({ object }: { object: LoggedObject }) {
  const value = object.value && typeof object.value === "object" ? object.value as Record<string, unknown> : {};
  const counts = Array.isArray(value.counts) ? value.counts.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).slice(0, 64) : [];
  const max = Math.max(1, ...counts);
  if (!counts.length) return <small>Histogram preview is empty.</small>;
  return (
    <div className="histogram-preview" aria-label={`${object.key} histogram preview`}>
      {counts.map((count, index) => (
        <span key={index} title={formatNumber(count, 2)} style={{ height: `${Math.max(6, (count / max) * 76)}px` }} />
      ))}
    </div>
  );
}

function artifactFromLoggedObject(object: LoggedObject): Artifact | null {
  if (!object.artifact_id || !object.artifact) return null;
  return {
    id: object.artifact_id,
    type: object.kind === "video" ? "rollout" : "file",
    name: object.artifact.name ?? object.key,
    uri: object.artifact.uri ?? "",
    step: object.step,
    size_bytes: object.artifact.size_bytes,
    metadata: {
      kind: object.kind,
      mime_type: object.artifact.mime_type,
      ...object.metadata,
    },
  };
}

function RunTimeline({ rows }: { rows: RunTimelineRow[] }) {
  return (
    <div className="run-timeline">
      {rows.map((row) => (
        <article className="run-timeline-row" key={row.id}>
          <span className={`timeline-dot ${row.tone}`} />
          <span>
            <strong>{row.label}</strong>
            <small>{row.detail}</small>
          </span>
          <b>{row.value}</b>
        </article>
      ))}
    </div>
  );
}

function RunMetricTable({ rows }: { rows: RunMetricRow[] }) {
  if (!rows.length) return <div className="empty compact-empty">No metric aggregates are available for this run.</div>;
  return (
    <div className="metric-summary-table">
      <div className="metric-summary-row metric-summary-head">
        <span>Metric</span>
        <span>Latest</span>
        <span>Goal</span>
        <span>Mean</span>
        <span>Step</span>
      </div>
      {rows.slice(0, 12).map((row) => (
        <div className="metric-summary-row" key={row.key}>
          <strong title={row.key}>{shortMetricName(row.key)}</strong>
          <span>{formatNumber(row.latest, 3)}</span>
          <span title={metricGoalLabel(row.key)}>{formatNumber(metricGoal(row.key) === "minimize" ? row.min : row.max, 3)}</span>
          <span>{formatNumber(row.mean, 3)}</span>
          <span>{formatNumber(row.bestStep, 0)}</span>
        </div>
      ))}
    </div>
  );
}

export function ArtifactPanel({ title, items }: { title: string; items: Artifact[] }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2></div>
      <div className="panel-body artifact-list">
        {items.length ? items.map((artifact) => (
          <article className="artifact-card" key={artifact.id}>
            <strong>{artifact.name}</strong>
            <small>{artifact.step === null ? "no step" : `step ${artifact.step}`}</small>
            <small>{safeArtifactUri(artifact.uri)}</small>
            <ArtifactMediaPreview artifact={artifact} />
            <div className="artifact-actions">
              <span>{formatBytes(artifact.size_bytes)}</span>
              {artifactCanUseDownloadRoute(artifact) ? (
                <a className="copy-button artifact-download" href={artifactDownloadUrl(artifact)}><Download size={13} /> Download</a>
              ) : null}
              <button className="copy-button" type="button" onClick={() => copyText(artifact.id)}><Copy size={13} /> ID</button>
            </div>
          </article>
        )) : <div className="empty">Nothing logged yet.</div>}
      </div>
    </section>
  );
}

type CompareRowView = {
  category: string;
  different: boolean;
  key: string;
  label: string;
  missingCount: number;
  numericSpread: number;
  path: string;
  reference: unknown;
  searchText: string;
  values: Record<string, unknown>;
};

export function SideBySide({
  artifactsByRun = {},
  configSortKey = "",
  diffOnly = false,
  layout = "auto",
  metricKey,
  onRunSort,
  onRunSortMetricKey,
  payload,
  referenceRunId: selectedReferenceRunId = "",
  rowSort = "signal",
  runSort = "selected",
  runSortMetricKey,
  search = "",
  tableMetrics,
}: {
  artifactsByRun?: Record<string, Artifact[]>;
  configSortKey?: string;
  diffOnly?: boolean;
  layout?: CompareLayout;
  metricKey: string;
  onRunSort?: (sort: CompareRunSort) => void;
  onRunSortMetricKey?: (metric: string) => void;
  payload: any;
  referenceRunId?: string;
  rowSort?: CompareRowSort;
  runSort?: CompareRunSort;
  runSortMetricKey?: string;
  search?: string;
  tableMetrics?: string[];
}) {
  if (!payload?.rows?.length) return <div className="empty">Select runs to compare configs, metrics, and attributes.</div>;
  const rawRuns = (payload.runs ?? []) as RunSummary[];
  const effectiveRunSortMetricKey = runSortMetricKey || metricKey;
  const metricTableKeys = uniqueMetricKeys([metricKey, ...(tableMetrics ?? [])]).slice(0, 7);
  const sortedRuns = sortCompareRuns(rawRuns, runSort, effectiveRunSortMetricKey, configSortKey, artifactsByRun);
  const searchTokens = compareSearchTokens(search);
  const runMatches = searchTokens.length
    ? sortedRuns.filter((run) => searchTokens.every((token) => compareRunSearchText(run, artifactsByRun).includes(token)))
    : sortedRuns;
  const runSearchActive = searchTokens.length > 0 && runMatches.length > 0;
  const selectedReferenceRun = selectedReferenceRunId ? sortedRuns.find((run) => run.id === selectedReferenceRunId) : null;
  const referencePreservedBySearch = Boolean(runSearchActive && selectedReferenceRun && !runMatches.some((run) => run.id === selectedReferenceRun.id));
  const visibleRuns = runSearchActive
    ? referencePreservedBySearch && selectedReferenceRun
      ? [selectedReferenceRun, ...runMatches]
      : runMatches
    : sortedRuns;
  const referenceRunId = (selectedReferenceRunId && visibleRuns.some((run) => run.id === selectedReferenceRunId) ? selectedReferenceRunId : "")
    || (payload.reference_run_id && visibleRuns.some((run: RunSummary) => run.id === payload.reference_run_id) ? payload.reference_run_id : "")
    || visibleRuns[0]?.id
    || sortedRuns[0]?.id
    || rawRuns[0]?.id
    || "";
  const resolvedLayout = layout === "auto" ? "rows" : layout;
  const allRows = buildCompareRows(payload.rows ?? [], visibleRuns, artifactsByRun).map((row) => ({
    ...row,
    different: compareRowIsDifferent(row, visibleRuns, referenceRunId),
    reference: row.values?.[referenceRunId],
  }));
  const diffRows = diffOnly ? allRows.filter((row) => row.different) : allRows;
  const searchedRows = runSearchActive ? diffRows : filterCompareRows(diffRows, search);
  const sortedRows = sortCompareRows(searchedRows, rowSort);
  const rowLimit = resolvedLayout === "rows" ? 40 : 80;
  const rows = sortedRows.slice(0, rowLimit);
  const hiddenCount = Math.max(0, sortedRows.length - rows.length);
  const searchActive = search.trim().length > 0;
  const hasRows = rows.length > 0;

  return (
    <div className="panel-body side-by-side" id="side-by-side">
      {runSearchActive ? (
        <small className="matrix-note search-scope-note">
          Search matched {runMatches.length} of {sortedRuns.length} compared runs by name, tags, notes, config, or artifacts{referencePreservedBySearch ? "; reference preserved for deltas" : ""}.
        </small>
      ) : null}
      {hasRows ? (
        <>
          <CompareSummary metricKey={metricKey} referenceRunId={referenceRunId} rows={sortedRows} runs={visibleRuns} />
          {resolvedLayout === "rows" ? (
            <CompareRunRows
              allRows={allRows}
              configSortKey={configSortKey}
              metricKey={metricKey}
              onRunSort={onRunSort}
              onRunSortMetricKey={onRunSortMetricKey}
              referenceRunId={referenceRunId}
              rows={rows}
              runSort={runSort}
              sortMetricKey={effectiveRunSortMetricKey}
              tableMetricKeys={metricTableKeys}
              runs={visibleRuns}
            />
          ) : (
            <CompareMatrix
              referenceRunId={referenceRunId}
              rows={rows}
              runs={visibleRuns}
            />
          )}
          <CompareArtifactStrip artifactsByRun={artifactsByRun} runs={visibleRuns} />
        </>
      ) : null}
      {!hasRows ? <div className="empty">No compared runs or rows match the current search.</div> : null}
      {hiddenCount ? (
        <small className="matrix-note">
          Showing {rows.length} of {sortedRows.length} rows{searchActive && !runSearchActive ? " after row search" : runSearchActive ? " for the matched runs" : ""}. Narrow the search or switch sorting to pull different evidence forward.
        </small>
      ) : null}
    </div>
  );
}

function CompareMatrix({ referenceRunId, rows, runs }: { referenceRunId: string; rows: CompareRowView[]; runs: RunSummary[] }) {
  return (
    <div className="compare-matrix" style={{ gridTemplateColumns: `minmax(210px, 0.85fr) repeat(${runs.length}, minmax(180px, 1fr))` }}>
      <div className="compare-head compare-attribute">Attribute</div>
      {runs.map((run) => (
        <CompareRunHead referenceRunId={referenceRunId} run={run} key={run.id} />
      ))}
      {rows.map((row) => (
        <div className="compare-row-fragment" key={row.key} role="row">
          <div className={`compare-attribute ${row.different ? "changed" : ""}`}>
            <small>{row.category}</small>
            <strong title={row.path}>{row.label}</strong>
          </div>
          {runs.map((run) => {
            const value = compactValue(row.values?.[run.id]);
            const referenceValue = row.values?.[referenceRunId];
            const changed = run.id !== referenceRunId && value !== compactValue(referenceValue);
            const delta = run.id === referenceRunId ? "" : relativeDeltaLabel(row.values?.[run.id], referenceValue);
            return (
              <div className={`compare-cell ${run.id === referenceRunId ? "reference" : ""} ${changed ? "changed" : ""}`} key={`${row.key}-${run.id}`} title={value}>
                <span>{shortValue(value)}</span>
                {delta ? <small className={delta.startsWith("+") ? "positive" : delta.startsWith("-") ? "negative" : ""}>{delta}</small> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CompareRunRows({
  allRows,
  configSortKey,
  metricKey,
  onRunSort,
  onRunSortMetricKey,
  referenceRunId,
  rows,
  runSort,
  runs,
  sortMetricKey,
  tableMetricKeys,
}: {
  allRows: CompareRowView[];
  configSortKey: string;
  metricKey: string;
  onRunSort?: (sort: CompareRunSort) => void;
  onRunSortMetricKey?: (metric: string) => void;
  referenceRunId: string;
  rows: CompareRowView[];
  runSort: CompareRunSort;
  runs: RunSummary[];
  sortMetricKey: string;
  tableMetricKeys: string[];
}) {
  const metricColumns = tableMetricKeys.length ? tableMetricKeys : [metricKey];
  const evidenceRows = rows.slice(0, Math.max(4, 8 - Math.max(0, metricColumns.length - 1)));
  const omittedEvidenceCount = Math.max(0, rows.length - evidenceRows.length);
  const fixedColumns = `280px repeat(${metricColumns.length}, minmax(148px, 170px)) 230px 96px 118px repeat(${evidenceRows.length}, 138px)`;
  const requestRunSort = (nextSort: CompareRunSort, nextMetricKey?: string) => {
    if (nextMetricKey) onRunSortMetricKey?.(nextMetricKey);
    onRunSort?.(nextSort);
  };
  return (
    <div className="compare-run-layout">
      <div className="compare-run-table" role="grid" style={{ gridTemplateColumns: fixedColumns }}>
        <button aria-label="Sort compared runs by name" className={`compare-row-head compare-sort-head sticky-run-cell ${runSort === "name" ? "active" : ""}`} onClick={() => requestRunSort("name")} type="button">Run</button>
        {metricColumns.map((tableMetricKey) => (
          <button
            aria-label={`Sort compared runs by ${tableMetricKey}`}
            className={`compare-row-head compare-sort-head ${sortMetricKey === tableMetricKey && (runSort === "metric-best" || runSort === "metric-latest") ? "active" : ""}`}
            key={tableMetricKey}
            onClick={() => requestRunSort("metric-best", tableMetricKey)}
            title={tableMetricKey}
            type="button"
          >
            <span>{shortMetricName(tableMetricKey)}</span>
            <small>{metricGoalLabel(tableMetricKey)}</small>
          </button>
        ))}
        <button aria-label="Sort compared runs by annotations" className={`compare-row-head compare-sort-head ${runSort === "notes" || runSort === "tags" ? "active" : ""}`} onClick={() => requestRunSort(runSort === "notes" ? "tags" : "notes")} type="button">Annotations</button>
        <button aria-label="Sort compared runs by artifact count" className={`compare-row-head compare-sort-head ${runSort === "artifacts" ? "active" : ""}`} onClick={() => requestRunSort("artifacts")} type="button">Artifacts</button>
        <button aria-label={`Sort compared runs by ${configSortKey || "config"}`} className={`compare-row-head compare-sort-head ${runSort === "config" ? "active" : ""}`} onClick={() => requestRunSort("config")} type="button">{configSortKey || "Config"}</button>
        {evidenceRows.map((row) => <div className="compare-row-head" key={row.key} title={row.path}>{row.label}</div>)}
        {runs.map((run) => {
          const note = runNoteText(run);
          return (
            <div className="compare-run-line" key={run.id} role="row">
              <div className={`compare-run-identity sticky-run-cell ${run.id === referenceRunId ? "reference" : ""}`}>
                <strong title={run.name}>{run.name}</strong>
                <span className="compare-run-meta-line">
                  <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
                  {run.id === referenceRunId ? <small className="compare-reference-badge">Reference</small> : <small>{run.project}</small>}
                </span>
              </div>
              {metricColumns.map((tableMetricKey) => {
                const aggregate = run.metric_aggregates?.[tableMetricKey];
                const referenceAggregate = runs.find((candidate) => candidate.id === referenceRunId)?.metric_aggregates?.[tableMetricKey];
                const latestValue = compareMetricValueForRun(allRows, run.id, tableMetricKey, "latest") ?? run.latest_metrics?.[tableMetricKey];
                const bestValue = compareMetricBestValueForRun(allRows, run.id, tableMetricKey) ?? (metricGoal(tableMetricKey) === "minimize" ? aggregate?.min : aggregate?.max);
                const referenceBestValue = compareMetricBestValueForRun(allRows, referenceRunId, tableMetricKey)
                  ?? (metricGoal(tableMetricKey) === "minimize" ? referenceAggregate?.min : referenceAggregate?.max);
                const delta = relativeDeltaLabel(bestValue, referenceBestValue);
                return (
                  <div className={`compare-run-cell compare-signal-cell compare-metric-cell ${tableMetricKey === metricKey ? "primary" : ""}`} key={`${run.id}-${tableMetricKey}`} title={tableMetricKey}>
                    <strong>{compactValue(bestValue)}</strong>
                    <small>latest {compactValue(latestValue)}{delta ? ` · ${delta}` : ""}</small>
                  </div>
                );
              })}
              <div className="compare-run-cell compare-annotations">
                <TagList tags={run.tags} />
                <small title={note}>{note || "No note"}</small>
              </div>
              <div className="compare-run-cell compare-artifact-count">{formatNumber(artifactTotalForRun(run), 0)}</div>
              <div className="compare-run-cell">{configSortKey ? compactValue(run.config?.[configSortKey]) : "-"}</div>
              {evidenceRows.map((row) => {
                const value = compactValue(row.values?.[run.id]);
                const referenceValue = row.values?.[referenceRunId];
                const changed = run.id !== referenceRunId && value !== compactValue(referenceValue);
                return (
                  <div className={`compare-run-cell ${changed ? "changed" : ""}`} key={`${run.id}-${row.key}`} title={value}>{shortValue(value)}</div>
                );
              })}
            </div>
          );
        })}
      </div>
      {omittedEvidenceCount ? (
        <small className="matrix-note compare-evidence-note">Showing the top {evidenceRows.length} evidence fields in row mode; {omittedEvidenceCount} more are available through search, sorting, or column layout.</small>
      ) : null}
    </div>
  );
}

function uniqueMetricKeys(keys: string[]) {
  const seen = new Set<string>();
  return keys.filter((key) => {
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function CompareSummary({ metricKey, referenceRunId, rows, runs }: { metricKey: string; referenceRunId: string; rows: CompareRowView[]; runs: RunSummary[] }) {
  if (!runs.length) return null;
  const goal = metricGoal(metricKey);
  const best = compareMetricBestRunFromRows(runs, rows, metricKey);
  const bestRun = best?.run ?? bestRunByMetric(runs, metricKey);
  const referenceRun = runs.find((run) => run.id === referenceRunId) ?? runs[0];
  const largestDeltas = rows
    .map((row) => {
      const reference = row.values?.[referenceRunId];
      const numericDeltas = runs
        .filter((run) => run.id !== referenceRunId)
        .map((run) => {
          const value = row.values?.[run.id];
          if (typeof value !== "number" || typeof reference !== "number" || !Number.isFinite(value) || !Number.isFinite(reference)) return null;
          return { run, value, delta: value - reference };
        })
        .filter((item): item is { run: RunSummary; value: number; delta: number } => Boolean(item));
      const strongest = numericDeltas.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))[0];
      return strongest ? { ...strongest, row } : null;
    })
    .filter((item): item is { run: RunSummary; value: number; delta: number; row: CompareRowView } => Boolean(item))
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, 3);
  const bestValue = best?.value ?? (bestRun ? metricBestValue(bestRun, metricKey) : null);
  const referenceValue = referenceRun ? compareMetricBestValueForRun(rows, referenceRun.id, metricKey) ?? metricBestValue(referenceRun, metricKey) : null;

  return (
    <section className="compare-summary" aria-label="Comparison summary">
      <div>
        <small>Objective</small>
        <strong>{metricKey}</strong>
        <span>{goal === "minimize" ? "Lower is better" : "Higher is better"}</span>
      </div>
      <div>
        <small>Best run</small>
        <strong title={bestRun?.name}>{bestRun?.name ?? "-"}</strong>
        <span>{compactValue(bestValue)}</span>
      </div>
      <div>
        <small>Reference</small>
        <strong title={referenceRun?.name}>{referenceRun?.name ?? "-"}</strong>
        <span>{compactValue(referenceValue)}</span>
      </div>
      <div>
        <small>Largest deltas</small>
        {largestDeltas.length ? (
          <ul>
            {largestDeltas.map((item) => (
              <li key={`${item.row.key}-${item.run.id}`}>
                <span title={item.row.path}>{item.row.label}</span>
                <strong>{item.delta > 0 ? "+" : ""}{compactValue(item.delta)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <span>No numeric deltas in the current view.</span>
        )}
      </div>
    </section>
  );
}

function CompareRunHead({ referenceRunId, run }: { referenceRunId: string; run: RunSummary }) {
  const note = runNoteText(run);
  const totalArtifacts = artifactTotalForRun(run);
  return (
    <div className={`compare-head ${run.id === referenceRunId ? "reference" : ""}`} title={run.name}>
      <span>{run.name}</span>
      <div className="compare-head-meta">
        <span className={`pill ${statusTone(run.status)}`}>{run.status}</span>
        {run.id === referenceRunId ? <small>Reference</small> : null}
      </div>
      <TagList tags={run.tags} />
      {note ? <small className="compare-head-note" title={note}>{note}</small> : null}
      {totalArtifacts ? <small>{formatNumber(totalArtifacts, 0)} artifacts</small> : null}
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags?.length) return <span className="compare-empty">-</span>;
  return (
    <span className="compare-tag-list">
      {tags.map((tag) => <span className="chip" key={tag} title={tag}>{tag}</span>)}
    </span>
  );
}

function CompareArtifactStrip({ artifactsByRun, runs }: { artifactsByRun: Record<string, Artifact[]>; runs: RunSummary[] }) {
  const artifactRuns = runs.filter((run) => artifactTotalForRun(run) || artifactsByRun[run.id]?.length);
  if (!artifactRuns.length) return null;
  return (
    <section className="compare-artifact-strip" aria-label="Compare artifacts">
      {artifactRuns.map((run) => {
        const artifacts = artifactsByRun[run.id] ?? [];
        const expected = artifactTotalForRun(run);
        return (
          <article className="compare-artifact-card" key={run.id}>
            <div className="compare-artifact-head">
              <strong title={run.name}>{run.name}</strong>
              <span>{formatNumber(expected || artifacts.length, 0)} artifacts</span>
            </div>
            <div className="compare-artifact-items">
              {artifacts.length ? artifacts.slice(0, 2).map((artifact) => (
                <div className="compare-artifact-item" key={artifact.id}>
                  <span title={artifact.name}>{artifact.name}</span>
                  <small>{artifact.step === null ? "no step" : `step ${artifact.step}`} · {formatBytes(artifact.size_bytes)}</small>
                  <ArtifactMediaPreview artifact={artifact} compact />
                </div>
              )) : <small>{expected ? "Loading metadata..." : "No artifacts"}</small>}
              {artifacts.length > 2 ? <small>+{artifacts.length - 2} more</small> : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function ArtifactMediaPreview({ artifact, compact = false, fallback = false }: { artifact: Artifact; compact?: boolean; fallback?: boolean }) {
  const kind = artifactMediaKind(artifact);
  if (!kind) return fallback ? <small className="artifact-media-fallback">Preview unavailable.</small> : null;
  const canPlay = artifactCanUseDownloadRoute(artifact);
  if (!canPlay) {
    return <small className="artifact-media-fallback">{compact ? "Preview unavailable" : "Media preview unavailable; download or copy ID."}</small>;
  }
  const src = artifactDownloadUrl(artifact);
  if (kind === "image") {
    return <img alt={artifact.name} className="artifact-media artifact-image" loading="lazy" src={src} />;
  }
  return kind === "audio" ? (
    <audio className="artifact-media" controls preload="metadata" src={src} />
  ) : (
    <video className="artifact-media" controls preload="metadata" src={src} />
  );
}

function artifactMediaKind(artifact: Artifact) {
  const mime = String(artifact.metadata?.mime_type ?? artifact.metadata?.mimeType ?? artifact.metadata?.content_type ?? artifact.metadata?.contentType ?? "").toLowerCase();
  const name = `${artifact.name} ${artifact.uri}`.toLowerCase();
  if (mime.includes("image") || /\.(png|jpe?g|webp|gif)(?:$|[?#])/.test(name)) return "image";
  if (mime.includes("audio") || /\.(mp3|m4a|wav|aac)(?:$|[?#])/.test(name)) return "audio";
  if (mime.includes("video") || /\.(mp4|mov|webm)(?:$|[?#])/.test(name)) return "video";
  return "";
}

function artifactCanUseDownloadRoute(artifact: Artifact) {
  const uri = String(artifact.uri ?? "").toLowerCase();
  return Boolean(artifact.id) && !uri.startsWith("demo://") && !/^https?:\/\//.test(uri);
}

function artifactDownloadUrl(artifact: Artifact) {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

function buildCompareRows(rawRows: any[], runs: RunSummary[], artifactsByRun: Record<string, Artifact[]>): CompareRowView[] {
  const seenRows = new Set<string>();
  return rawRows
    .map((row, index) => {
      const category = compareCategory(row.path);
      const label = comparePathLabel(row.path);
      const values = row.values ?? {};
      const compactValues = runs.map((run) => compactValue(values?.[run.id]));
      const numericValues = runs.map((run) => values?.[run.id]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const missingCount = compactValues.filter((value) => value === "-").length;
      const numericSpread = numericValues.length > 1 ? Math.max(...numericValues) - Math.min(...numericValues) : 0;
      const key = [category, label, ...compactValues].join("::");
      return {
        category,
        different: Boolean(row.different),
        key: `${index}:${key}`,
        label,
        missingCount,
        numericSpread,
        path: row.path,
        reference: row.reference,
        searchText: [category, label, row.path, ...compactValues].join(" ").toLowerCase(),
        values,
      };
    })
    .filter((row) => {
      const dedupeKey = row.key.replace(/^\d+:/, "");
      if (seenRows.has(dedupeKey)) return false;
      seenRows.add(dedupeKey);
      return true;
    });
}

function compareRowIsDifferent(row: CompareRowView, runs: RunSummary[], referenceRunId: string) {
  const referenceValue = compactValue(row.values?.[referenceRunId]);
  return runs.some((run) => run.id !== referenceRunId && compactValue(row.values?.[run.id]) !== referenceValue);
}

function filterCompareRows(rows: CompareRowView[], search: string) {
  const tokens = compareSearchTokens(search);
  if (!tokens.length) return rows;
  return rows.filter((row) => tokens.every((token) => row.searchText.includes(token)));
}

function compareSearchTokens(search: string) {
  return search.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function compareRunSearchText(run: RunSummary, artifactsByRun: Record<string, Artifact[]>) {
  return [
    run.name,
    run.status,
    run.project,
    run.tags?.join(" "),
    runNoteText(run),
    ...Object.entries(run.config ?? {}).map(([key, value]) => `${key} ${compactValue(value)}`),
    ...(artifactsByRun[run.id] ?? []).map((artifact) => `${artifact.name} ${artifact.type}`),
  ].filter(Boolean).join(" ").toLowerCase();
}

function sortCompareRows(rows: CompareRowView[], rowSort: CompareRowSort) {
  return [...rows].sort((left, right) => {
    if (rowSort === "changed") {
      const changed = Number(right.different) - Number(left.different);
      if (changed) return changed;
    }
    if (rowSort === "missing") {
      const missing = right.missingCount - left.missingCount;
      if (missing) return missing;
    }
    if (rowSort === "spread") {
      const spread = right.numericSpread - left.numericSpread;
      if (spread) return spread;
    }
    if (rowSort === "category") {
      const category = left.category.localeCompare(right.category);
      if (category) return category;
    }
    if (rowSort === "name") {
      const label = left.label.localeCompare(right.label);
      if (label) return label;
    }
    return compareRowRank(left.path) - compareRowRank(right.path) || left.label.localeCompare(right.label);
  });
}

function sortCompareRuns(runs: RunSummary[], runSort: CompareRunSort, metricKey: string, configSortKey: string, artifactsByRun: Record<string, Artifact[]>) {
  const selectedOrder = new Map(runs.map((run, index) => [run.id, index]));
  return [...runs].sort((left, right) => {
    const tie = (selectedOrder.get(left.id) ?? 0) - (selectedOrder.get(right.id) ?? 0) || left.name.localeCompare(right.name);
    if (runSort === "selected") return tie;
    if (runSort === "name") return left.name.localeCompare(right.name) || tie;
    if (runSort === "newest") return compareDatesDesc(left.created_at, right.created_at) || tie;
    if (runSort === "status") return statusPriority(left.status) - statusPriority(right.status) || left.status.localeCompare(right.status) || tie;
    if (runSort === "duration") return compareNumbersDesc(runDurationMs(left), runDurationMs(right)) || tie;
    if (runSort === "metric-latest") return compareNumbersDesc(left.latest_metrics?.[metricKey], right.latest_metrics?.[metricKey]) || tie;
    if (runSort === "metric-best") return compareMetricBest(left, right, metricKey) || tie;
    if (runSort === "artifacts") return compareNumbersDesc(artifactTotalForRun(left) + (artifactsByRun[left.id]?.length ?? 0), artifactTotalForRun(right) + (artifactsByRun[right.id]?.length ?? 0)) || tie;
    if (runSort === "tags") return compareNumbersDesc(left.tags?.length ?? 0, right.tags?.length ?? 0) || (left.tags ?? []).join(" ").localeCompare((right.tags ?? []).join(" ")) || tie;
    if (runSort === "notes") {
      const leftNote = runNoteText(left);
      const rightNote = runNoteText(right);
      return Number(Boolean(rightNote)) - Number(Boolean(leftNote)) || leftNote.localeCompare(rightNote) || tie;
    }
    if (runSort === "config") return compareConfigValues(left.config?.[configSortKey], right.config?.[configSortKey]) || tie;
    return tie;
  });
}

function compareDatesDesc(left: string, right: string) {
  return compareNumbersDesc(Date.parse(left), Date.parse(right));
}

function compareNumbersDesc(left: unknown, right: unknown) {
  const leftNumber = typeof left === "number" && Number.isFinite(left) ? left : null;
  const rightNumber = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (leftNumber === null && rightNumber === null) return 0;
  if (leftNumber === null) return 1;
  if (rightNumber === null) return -1;
  return rightNumber - leftNumber;
}

function compareMetricBest(left: RunSummary, right: RunSummary, metricKey: string) {
  const goal = metricGoal(metricKey);
  const leftValue = goal === "minimize" ? left.metric_aggregates?.[metricKey]?.min : left.metric_aggregates?.[metricKey]?.max;
  const rightValue = goal === "minimize" ? right.metric_aggregates?.[metricKey]?.min : right.metric_aggregates?.[metricKey]?.max;
  return goal === "minimize" ? compareNumbersAsc(leftValue, rightValue) : compareNumbersDesc(leftValue, rightValue);
}

function bestRunByMetric(runs: RunSummary[], metricKey: string) {
  return [...runs].sort((left, right) => compareMetricBest(left, right, metricKey))[0] ?? null;
}

function metricBestValue(run: RunSummary | undefined, metricKey: string) {
  if (!run) return null;
  const aggregate = run.metric_aggregates?.[metricKey];
  return metricGoal(metricKey) === "minimize" ? aggregate?.min : aggregate?.max;
}

function compareMetricBestRunFromRows(runs: RunSummary[], rows: CompareRowView[], metricKey: string) {
  const goal = metricGoal(metricKey);
  const candidates = runs
    .map((run) => {
      const value = compareMetricBestValueForRun(rows, run.id, metricKey);
      return typeof value === "number" && Number.isFinite(value) ? { run, value } : null;
    })
    .filter((item): item is { run: RunSummary; value: number } => Boolean(item));
  if (!candidates.length) return null;
  return candidates.sort((left, right) => goal === "minimize" ? left.value - right.value : right.value - left.value)[0];
}

function compareMetricBestValueForRun(rows: CompareRowView[], runId: string, metricKey: string) {
  const reducers = metricGoal(metricKey) === "minimize" ? ["min", "latest", "mean"] : ["max", "latest", "mean"];
  for (const reducer of reducers) {
    const value = compareMetricValueForRun(rows, runId, metricKey, reducer);
    if (value !== null) return value;
  }
  return null;
}

function compareMetricValueForRun(rows: CompareRowView[], runId: string, metricKey: string, reducer: string) {
  const row = rows.find((candidate) => candidate.path === `metric/${metricKey}/${reducer}`);
  const value = row?.values?.[runId];
  return value === undefined || value === null ? null : value;
}

function compareNumbersAsc(left: unknown, right: unknown) {
  const leftNumber = typeof left === "number" && Number.isFinite(left) ? left : null;
  const rightNumber = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (leftNumber === null && rightNumber === null) return 0;
  if (leftNumber === null) return 1;
  if (rightNumber === null) return -1;
  return leftNumber - rightNumber;
}

function compareConfigValues(left: unknown, right: unknown) {
  const leftMissing = left === undefined || left === null || left === "";
  const rightMissing = right === undefined || right === null || right === "";
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return compactValue(left).localeCompare(compactValue(right), undefined, { numeric: true });
}

function runDurationMs(run: RunSummary) {
  const start = Date.parse(run.started_at ?? run.created_at);
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function statusPriority(status: string) {
  if (status === "failed") return 0;
  if (status === "running") return 1;
  if (status === "finished") return 2;
  return 3;
}

function relativeDeltaLabel(value: unknown, reference: unknown) {
  if (typeof value !== "number" || typeof reference !== "number" || !Number.isFinite(value) || !Number.isFinite(reference)) return "";
  const delta = value - reference;
  if (delta === 0) return "0";
  if (reference === 0) return `${delta > 0 ? "+" : ""}${formatNumber(delta, 3)}`;
  const percent = (delta / Math.abs(reference)) * 100;
  return `${percent > 0 ? "+" : ""}${formatNumber(percent, 1)}%`;
}

export function AlertList({ rows }: { rows: AlertRow[] }) {
  if (!rows.length) return <div className="empty">No alerts from the current run filters.</div>;
  return (
    <div className="event-list">
      {rows.map((row) => (
        <article className={`event-row ${row.severity}`} key={row.id}>
          <span className="event-marker" />
          <div>
            <strong>{row.title}</strong>
            <small>{row.detail}</small>
          </div>
          <span className={`pill ${row.tone}`}>{row.label}</span>
        </article>
      ))}
    </div>
  );
}

export function DatasetTable({ rows, metricKey }: { rows: DatasetRow[]; metricKey: string }) {
  if (!rows.length) return <div className="empty">No dataset or environment metadata found in the current run configs.</div>;
  return (
    <div className="compact-table">
      <div className="compact-row compact-head">
        <span>Dataset</span>
        <span>Runs</span>
        <span>Seeds</span>
        <span>{shortMetricName(metricKey)}</span>
      </div>
      {rows.map((row) => (
        <div className="compact-row" key={row.name}>
          <strong>{row.name}</strong>
          <span>{row.runs}</span>
          <span>{row.seeds.join(", ") || "-"}</span>
          <span>{formatNumber(row.best, 2)}</span>
        </div>
      ))}
    </div>
  );
}

export function ArtifactBrowser({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return <div className="empty">No artifacts logged for the selected run.</div>;
  return (
    <div className="artifact-browser">
      {artifacts.map((artifact) => (
        <article className="browser-row" key={artifact.id}>
          <div className="browser-icon"><ArtifactIcon type={artifact.type} /></div>
          <div>
            <strong>{artifact.name}</strong>
            <small>{safeArtifactUri(artifact.uri)}</small>
          </div>
          <span>{artifact.step === null ? "no step" : `step ${artifact.step}`}</span>
          <span>{formatBytes(artifact.size_bytes)}</span>
          {artifactCanUseDownloadRoute(artifact) ? (
            <a className="copy-button artifact-download" href={artifactDownloadUrl(artifact)}><Download size={13} /> Download</a>
          ) : (
            <button className="copy-button artifact-download unavailable" disabled title="Download unavailable for metadata-only demo artifact" type="button">
              <Download size={13} /> Unavailable
            </button>
          )}
          <button className="copy-button" type="button" onClick={() => copyText(artifact.id)}><Copy size={13} /> Copy ID</button>
        </article>
      ))}
    </div>
  );
}

function ArtifactIcon({ type }: { type: string }) {
  if (type === "checkpoint") return <Box size={15} />;
  if (type === "rollout") return <Activity size={15} />;
  return <FileText size={15} />;
}

export function ModelLineage({ rows }: { rows: ModelRow[] }) {
  if (!rows.length) return <div className="empty">No checkpoints logged for the selected run.</div>;
  return (
    <div className="timeline-list">
      {rows.map((row) => (
        <article className="timeline-row" key={row.id}>
          <span className="timeline-dot" />
          <div>
            <strong>{row.name}</strong>
            <small>{safeArtifactUri(row.uri)}</small>
          </div>
          <span>{row.step}</span>
          <span>{row.evalReturn}</span>
        </article>
      ))}
    </div>
  );
}

export function ModelContext({ run }: { run: RunSummary | null }) {
  if (!run) return <div className="empty">No run selected.</div>;
  const rows = [
    ["Run", run.name],
    ["Algorithm", compactValue(run.config.algo ?? run.config.model ?? "-")],
    ["Environment", compactValue(run.config.env ?? run.config.dataset ?? "-")],
    ["Seed", compactValue(run.config.seed ?? "-")],
    ["Learning rate", compactValue(run.config.learning_rate ?? run.config.lr ?? "-")],
    ["Checkpoints", formatNumber(run.artifact_counts.checkpoint, 0)],
  ];
  return <InfoRows rows={rows} />;
}

export function ReportList({ rows }: { rows: ReportRow[] }) {
  if (!rows.length) return <div className="empty">No local saved views yet.</div>;
  return (
    <div className="event-list">
      {rows.map((row) => (
        <article className="event-row neutral" key={row.id}>
          <span className="event-marker" />
          <div>
            <strong>{row.name}</strong>
            <small>{row.scope}</small>
          </div>
          <span className="pill live">local</span>
        </article>
      ))}
    </div>
  );
}

export function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function IntegrationCard({ item }: { item: IntegrationRow }) {
  const Icon = item.icon;
  return (
    <article className="integration-card">
      <div className="integration-top">
        <span className="browser-icon"><Icon size={15} /></span>
        <span className={`pill ${item.tone}`}>{item.status}</span>
      </div>
      <strong>{item.name}</strong>
      <small>{item.detail}</small>
    </article>
  );
}

export function ApiTable({ rows }: { rows: ApiRow[] }) {
  return (
    <div className="api-list">
      {rows.map((row) => (
        <article className="api-row" key={`${row.method}-${row.path}`}>
          <span>{row.method}</span>
          <code>{row.path}</code>
          <small>{row.description}</small>
          <button className="copy-button" type="button" onClick={() => copyText(`${row.method} ${row.path}`)}><Copy size={13} /> Copy</button>
        </article>
      ))}
    </div>
  );
}

export function MetricCard({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function InfoRows({ rows }: { rows: string[][] }) {
  return (
    <div className="settings-list">
      {rows.map(([label, value]) => <SettingRow label={label} value={value} key={label} />)}
    </div>
  );
}

function Chips({ values }: { values: string[] }) {
  return (
    <div className="chips">
      {values.map((value) => <span className="chip" title={value} key={value}>{value}</span>)}
    </div>
  );
}

function copyText(value: string) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}
