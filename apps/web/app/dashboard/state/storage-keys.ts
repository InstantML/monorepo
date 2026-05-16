// Single source of truth for browser-persistence keys.
//
// These literals are a stable contract: saved views and workspace layouts in
// users' browsers are addressed by these exact strings. Never rename them.
// Centralised here as the first step of the dashboard shell decomposition so
// the shell, models, and components stop re-declaring the prefixes inline.

export const THEME_KEY = "instantml:next:theme";
export const NAV_PINNED_KEY = "instantml:next:nav-pinned";
export const RUNS_RAIL_COLLAPSED_KEY = "instantml:next:runs-rail-collapsed";

export const SAVED_VIEW_PREFIX = "instantml:next:local:view:";
export const LEGACY_SAVED_VIEW_PREFIX = "instantml:next:view:";
export const WORKSPACE_VIEW_PREFIX = "instantml:next:local:workspace:";

/** Strip any known saved-view prefix to get the user-facing view name. */
export function savedViewLabel(key: string): string {
  return key.replace(SAVED_VIEW_PREFIX, "").replace(LEGACY_SAVED_VIEW_PREFIX, "");
}
