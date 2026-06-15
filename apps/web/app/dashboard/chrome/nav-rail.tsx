"use client";

import { BookOpen, ChevronDown, CircleHelp, Moon, PanelLeftClose, PanelLeftOpen, Sun, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { MouseEvent, ReactNode } from "react";

import { InstantMlMark } from "../../instantml-mark";
import { navGroups, shellTabPath } from "../../dashboard-config";
import type { ShellTabId } from "../../dashboard-config";

const navGroupLabels: Record<(typeof navGroups)[number]["id"], string> = {
  operate: "Operate",
  data: "Data",
  system: "System",
};

export type NavBadge = { value: string; tone?: "alert" };

export function DashboardNav({
  accountMenu,
  activeTab,
  badges = {},
  compactNav = false,
  mobileOpen = false,
  onAutoOpenChange,
  onMobileClose,
  onPinnedChange,
  onProjectPicker,
  onSelect,
  onShortcutHelp,
  onThemeToggle,
  pinned,
  project,
  theme,
}: {
  accountMenu?: ReactNode;
  activeTab: ShellTabId;
  badges?: Partial<Record<ShellTabId, NavBadge>>;
  compactNav?: boolean;
  mobileOpen?: boolean;
  onAutoOpenChange: (open: boolean) => void;
  onMobileClose?: () => void;
  onPinnedChange: (pinned: boolean) => void;
  onProjectPicker?: () => void;
  onSelect: (tabId: ShellTabId) => void;
  onShortcutHelp?: () => void;
  onThemeToggle: () => void;
  pinned: boolean;
  project?: string;
  theme: "light" | "dark";
}) {
  const navRef = useRef<HTMLElement>(null);
  const hiddenCompactNav = compactNav && !mobileOpen;
  const compactTabIndex = hiddenCompactNav ? -1 : undefined;
  const dark = theme === "dark";
  const themeLabel = dark ? "Switch to light mode" : "Switch to dark mode";

  useEffect(() => {
    if (!mobileOpen) return;
    window.setTimeout(() => {
      navRef.current?.querySelector<HTMLElement>(".tab-button.active")?.scrollIntoView({ block: "center" });
    }, 0);
  }, [activeTab, mobileOpen]);

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

  function handleTabSelect(event: MouseEvent<HTMLAnchorElement>, tabId: ShellTabId) {
    event.preventDefault();
    onMobileClose?.();
    onSelect(tabId);
    onAutoOpenChange(false);
    if (event.detail > 0) event.currentTarget.blur();
  }

  return (
    <nav
      className={`tabs ${pinned ? "pinned" : ""}`}
      aria-hidden={hiddenCompactNav ? true : undefined}
      aria-label="Dashboard sections"
      onMouseEnter={() => { if (!pinned && !compactNav) onAutoOpenChange(true); }}
      onMouseLeave={() => {
        // Don't collapse out from under a focused rail item (keyboard user
        // tabbing through while the pointer drifts off); onBlur handles those.
        if (!pinned && !compactNav && !navRef.current?.contains(document.activeElement)) onAutoOpenChange(false);
      }}
      onFocus={(event) => {
        // Also expand for keyboard focus. Both hover and focus expand on enter —
        // before any click — so an icon click still lands on its first press.
        if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) onAutoOpenChange(true);
      }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) onAutoOpenChange(false); }}
      ref={navRef}
    >
      <div className="nav-drawer-head">
        <span>Navigation</span>
        <button aria-label="Close navigation" className="icon-button framed" onClick={onMobileClose} tabIndex={compactTabIndex} type="button">
          <X size={15} />
        </button>
      </div>
      {/* Rail brand block + PROJECT selector card (desktop, per shell mock). */}
      <div className="rail-brand" aria-hidden={hiddenCompactNav ? true : undefined}>
        <span className="rail-brandmark"><InstantMlMark size={13} /></span>
        <span className="rail-brand-name">InstantML</span>
      </div>
      {onProjectPicker ? (
        <button
          className="rail-project"
          onClick={onProjectPicker}
          tabIndex={compactTabIndex}
          title="Change project"
          type="button"
        >
          <span className="rail-project-body">
            <span className="rail-project-label">Project</span>
            <span className="rail-project-name">{project || "All projects"}</span>
          </span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      ) : null}
      <div className="tab-scroll">
        {navGroups.map((group) => (
          <div className="tab-group" key={group.id}>
            <span className="tab-group-label">{navGroupLabels[group.id]}</span>
            {group.items.map((tab) => {
              const Icon = tab.icon;
              const badge = badges[tab.id];
              return (
                <a
                  aria-label={tab.label}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
                  href={shellTabPath(tab.id)}
                  key={tab.id}
                  onClick={(event) => handleTabSelect(event, tab.id)}
                  tabIndex={compactTabIndex}
                  title={pinned ? undefined : tab.label}
                >
                  <Icon size={15} /> <span className="tab-label">{tab.label}</span>
                  {badge ? <span className={`tab-count ${badge.tone === "alert" ? "is-alert" : ""}`}>{badge.value}</span> : null}
                </a>
              );
            })}
          </div>
        ))}
      </div>
      <div className="nav-footer">
        <button
          aria-label={themeLabel}
          aria-pressed={dark}
          className="tab-button nav-theme-button"
          onClick={onThemeToggle}
          tabIndex={compactTabIndex}
          title={pinned ? undefined : themeLabel}
          type="button"
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
          <span className="tab-label">{dark ? "Light mode" : "Dark mode"}</span>
        </button>
        <button
          aria-label={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          aria-pressed={pinned}
          className={`tab-button nav-pin-button ${pinned ? "active" : ""}`}
          onClick={() => handlePinnedChange(!pinned)}
          tabIndex={compactTabIndex}
          type="button"
        >
          {pinned ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          <span className="tab-label">{pinned ? "Unpin" : "Pin"}</span>
        </button>
        {accountMenu ? <div className="rail-foot">{accountMenu}</div> : null}
      </div>
      <div className="nav-mobile-actions">
        <Link className="tab-button" href="/docs" aria-label="Docs" tabIndex={compactTabIndex}>
          <BookOpen size={15} />
          <span className="tab-label">Docs</span>
        </Link>
        {onShortcutHelp ? (
          <button className="tab-button" type="button" onClick={onShortcutHelp} aria-label="Keyboard shortcuts" tabIndex={compactTabIndex}>
            <CircleHelp size={15} />
            <span className="tab-label">Shortcuts</span>
          </button>
        ) : null}
        <button className="tab-button" type="button" onClick={onThemeToggle} aria-label={themeLabel} aria-pressed={dark} tabIndex={compactTabIndex}>
          {dark ? <Sun size={15} /> : <Moon size={15} />}
          <span className="tab-label">{dark ? "Light mode" : "Dark mode"}</span>
        </button>
      </div>
    </nav>
  );
}
