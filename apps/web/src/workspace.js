/**
 * Workspace slug utilities shared between the auth flow UI and tests.
 *
 * These functions mirror the server-side logic in apps/rust-server/src/store/auth.rs
 * (derive_workspace_slug, slugify) and must remain in sync.
 */

/**
 * Derive a workspace slug from a Clerk display name or email handle.
 *
 * Priority: display name → email handle (everything before @).
 *
 * @param {string} displayName - Clerk user full name (may be empty).
 * @param {string} email - Clerk primary email address.
 * @returns {string} URL-safe slug.
 */
export function deriveClerkSlug(displayName, email) {
  const source = displayName.trim() || email.split("@")[0] || email;
  return slugify(source);
}

/**
 * Convert an arbitrary string to a URL-safe slug matching the server's slugify function.
 *
 * Rules:
 * - Lowercase all characters.
 * - Replace non-alphanumeric ASCII with "-".
 * - Collapse consecutive "-" to one.
 * - Strip leading/trailing "-".
 * - Clamp to 63 characters.
 * - Fall back to "workspace" if result is empty.
 *
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "workspace";
  return slug.slice(0, 63);
}
