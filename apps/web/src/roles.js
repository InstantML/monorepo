export const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  member: "Write/read",
  viewer: "Read only",
};

export function roleLabel(role) {
  return ROLE_LABELS[String(role || "").toLowerCase()] || "Unknown";
}

export function roleCapabilities(role) {
  const normalized = String(role || "").toLowerCase();
  const admin = normalized === "owner" || normalized === "admin";
  const writeRuns = admin || normalized === "member";
  return {
    manage_billing: admin,
    manage_members: admin,
    write_runs: writeRuns,
    manage_api_keys: admin,
  };
}

export function canManageOrg(role) {
  const capabilities = roleCapabilities(role);
  return capabilities.manage_billing && capabilities.manage_members;
}

export function canWriteRuns(role) {
  return roleCapabilities(role).write_runs;
}
