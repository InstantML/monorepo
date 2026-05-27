"use client";

import { BookOpen, CircleHelp, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { useRef } from "react";
import type { MouseEvent } from "react";

import { tabToPath } from "../../../src/routes.js";
import { navGroups } from "../../dashboard-config";
import type { TabId } from "../../dashboard-types";

export function DashboardNav({
  activeTab,
  onAutoOpenChange,
  onPinnedChange,
  onSelect,
  onShortcutHelp,
  onSignOut,
  onThemeToggle,
  pinned,
  theme,
}: {
  activeTab: TabId;
  onAutoOpenChange: (open: boolean) => void;
  onPinnedChange: (pinned: boolean) => void;
  onSelect: (tabId: TabId) => void;
  onShortcutHelp?: () => void;
  onSignOut?: () => void;
  onThemeToggle?: () => void;
  pinned: boolean;
  theme?: "light" | "dark";
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
    onAutoOpenChange(false);
    if (event.detail > 0) event.currentTarget.blur();
  }

  return (
    <nav
      className={`tabs ${pinned ? "pinned" : ""}`}
      aria-label="Dashboard sections"
      onMouseEnter={() => onAutoOpenChange(true)}
      onMouseLeave={() => onAutoOpenChange(false)}
      onFocus={() => onAutoOpenChange(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) onAutoOpenChange(false); }}
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
      <div className="nav-mobile-actions">
        <a className="tab-button" href="/docs" aria-label="Docs">
          <BookOpen size={15} />
          <span className="tab-label">Docs</span>
        </a>
        {onThemeToggle ? (
          <button
            className="tab-button"
            type="button"
            onClick={onThemeToggle}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            <span className="tab-label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
        ) : null}
        {onShortcutHelp ? (
          <button className="tab-button" type="button" onClick={onShortcutHelp} aria-label="Keyboard shortcuts">
            <CircleHelp size={15} />
            <span className="tab-label">Shortcuts</span>
          </button>
        ) : null}
        {onSignOut ? (
          <button className="tab-button" type="button" onClick={onSignOut} aria-label="Sign out">
            <LogOut size={15} />
            <span className="tab-label">Sign out</span>
          </button>
        ) : null}
      </div>
    </nav>
  );
}
