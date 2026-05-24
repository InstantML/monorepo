export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export function formatBytes(value) {
  if (value == null) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let size = Math.max(0, Number(value));
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 10 || Number.isInteger(size) ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

export function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatRelativeTime(value, now = new Date()) {
  if (!value) return "Never";
  const then = new Date(value);
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

export function toneForStatus(status) {
  if (["high", "failed", "limit", "read_only_payment_required", "storage_unconfigured"].includes(status)) {
    return "danger";
  }
  if (["medium", "warning", "provisioning", "storage_locked", "past_due_grace"].includes(status)) {
    return "warn";
  }
  if (["low", "disabled", "expired", "revoked"].includes(status)) {
    return "muted";
  }
  return "good";
}

export function statusLabel(value) {
  return String(value ?? "unknown").replaceAll("_", " ");
}

export function storageLine(storage) {
  const route = storage?.route_status ? `route ${statusLabel(storage.route_status)}` : "no route";
  return `${statusLabel(storage?.storage_choice)} / ${statusLabel(storage?.storage_state)} / ${route}`;
}
