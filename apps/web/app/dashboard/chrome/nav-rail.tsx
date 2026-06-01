"use client";

import { BookOpen, CircleHelp, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import type { MouseEvent } from "react";

import { tabToPath } from "../../../src/routes.js";
import { navGroups } from "../../dashboard-config";
import type { TabId } from "../../dashboard-types";

export function DashboardNav({
  activeTab,
  compactNav = false,
  mobileOpen = false,
  onAutoOpenChange,
  onMobileClose,
  onPinnedChange,
  onSelect,
  onShortcutHelp,
  pinned,
}: {
  activeTab: TabId;
  compactNav?: boolean;
  mobileOpen?: boolean;
  onAutoOpenChange: (open: boolean) => void;
  onMobileClose?: () => void;
  onPinnedChange: (pinned: boolean) => void;
  onSelect: (tabId: TabId) => void;
  onShortcutHelp?: () => void;
  pinned: boolean;
}) {
  const navRef = useRef<HTMLElement>(null);
  const hiddenCompactNav = compactNav && !mobileOpen;
  const compactTabIndex = hiddenCompactNav ? -1 : undefined;

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
    onMobileClose?.();
    if (event.detail > 0) event.currentTarget.blur();
  }

  return (
    <nav
      className={`tabs ${pinned ? "pinned" : ""}`}
      aria-hidden={hiddenCompactNav ? true : undefined}
      aria-label="Dashboard sections"
      onMouseEnter={() => onAutoOpenChange(true)}
      onMouseLeave={() => onAutoOpenChange(false)}
      onFocus={() => onAutoOpenChange(true)}
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
            {group.items.map((tab) => {
              const Icon = tab.icon;
              return (
                <a
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
                  href={tabToPath(tab.id)}
                  key={tab.id}
                  onClick={(event) => handleTabSelect(event, tab.id)}
                  tabIndex={compactTabIndex}
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
          tabIndex={compactTabIndex}
          title={pinned ? "Unpin sidebar" : "Pin sidebar open"}
          type="button"
        >
          {pinned ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          <span className="tab-label">{pinned ? "Unpin" : "Pin"}</span>
        </button>
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
      </div>
    </nav>
  );
}
