"use client";

import { BookOpen, CircleHelp, Moon, Sun, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { MouseEvent, ReactNode } from "react";

import { navGroups, shellTabPath } from "../../dashboard-config";
import type { ShellTabId } from "../../dashboard-config";

const navGroupLabels: Record<(typeof navGroups)[number]["id"], string> = {
  operate: "Operate",
  data: "Data",
  system: "System",
};

export function DashboardNav({
  accountMenu,
  activeTab,
  compactNav = false,
  mobileOpen = false,
  onAutoOpenChange,
  onMobileClose,
  onSelect,
  onShortcutHelp,
  onThemeToggle,
  theme,
}: {
  accountMenu?: ReactNode;
  activeTab: ShellTabId;
  compactNav?: boolean;
  mobileOpen?: boolean;
  onAutoOpenChange: (open: boolean) => void;
  onMobileClose?: () => void;
  onSelect: (tabId: ShellTabId) => void;
  onShortcutHelp?: () => void;
  onThemeToggle: () => void;
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

  function handleTabSelect(event: MouseEvent<HTMLAnchorElement>, tabId: ShellTabId) {
    event.preventDefault();
    onMobileClose?.();
    onSelect(tabId);
    onAutoOpenChange(false);
    if (event.detail > 0) event.currentTarget.blur();
  }

  return (
    <nav
      className="tabs"
      aria-hidden={hiddenCompactNav ? true : undefined}
      aria-label="Dashboard sections"
      onMouseEnter={() => { if (!compactNav) onAutoOpenChange(true); }}
      onMouseLeave={() => {
        // Don't collapse out from under a focused rail item (keyboard user
        // tabbing through while the pointer drifts off); onBlur handles those.
        if (!compactNav && !navRef.current?.contains(document.activeElement)) onAutoOpenChange(false);
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
      <div className="tab-scroll">
        {navGroups.map((group) => (
          <div className="tab-group" key={group.id}>
            <span className="tab-group-label">{navGroupLabels[group.id]}</span>
            {group.items.map((tab) => {
              const Icon = tab.icon;
              return (
                <a
                  aria-label={tab.label}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
                  href={shellTabPath(tab.id)}
                  key={tab.id}
                  onClick={(event) => handleTabSelect(event, tab.id)}
                  tabIndex={compactTabIndex}
                  title={tab.label}
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
          aria-label={themeLabel}
          aria-pressed={dark}
          className="tab-button nav-theme-button"
          onClick={onThemeToggle}
          tabIndex={compactTabIndex}
          title={themeLabel}
          type="button"
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
          <span className="tab-label">{dark ? "Light mode" : "Dark mode"}</span>
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
