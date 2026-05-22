export function accountInitials(displayName, email) {
  const nameParts = String(displayName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const sourceParts = nameParts.length
    ? nameParts
    : String(email || "")
      .split("@")[0]
      .replace(/[._+-]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const letters = sourceParts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return letters || "IM";
}

export function accountDisplayLabel(displayName, email) {
  const name = String(displayName || "").trim();
  const mail = String(email || "").trim();
  if (name && mail) return `${name} (${mail})`;
  return name || mail || "Account";
}

export function safeAccountAvatarUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}
