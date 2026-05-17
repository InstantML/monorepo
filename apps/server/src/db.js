import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";

export const RUN_STATUSES = new Set(["running", "finished", "failed"]);
export const ARTIFACT_TYPES = new Set(["checkpoint", "rollout", "file"]);
export const ATTRIBUTE_TYPES = new Set(["config", "float_series", "string_series", "file", "file_series", "histogram_series", "tag"]);
export const MEMBERSHIP_ROLES = new Set(["owner", "admin", "member", "viewer"]);
export const DEFAULT_ORG_ID = "local";
export const DEFAULT_ORG_SLUG = "local";
const GiB = 1024 ** 3;
const DEMO_RUN_COUNT = 1_000;
const DEMO_STEPS = [0, 40, 80, 120, 160, 200];
const METRIC_SERIES_INDEX = Symbol("metricSeriesIndex");
const MAX_TEXT_BYTES = 512;
const PROJECT_METADATA_BYTES = 512;
const RUN_METADATA_BYTES = 1024;
const ARTIFACT_METADATA_BYTES = 512;

export const PLAN_TIERS = Object.freeze({
  free: Object.freeze({
    id: "free",
    label: "Free",
    monthly_base_usd: 0,
    included_seats: 2,
    included_storage_bytes: 2 * GiB,
    projects: 2,
    runs: 100,
    metric_points: 1_000_000,
    warehouse_kind: "shared",
    min_replica_memory_gb: 8,
    max_replica_memory_gb: 8,
    num_replicas: 1,
  }),
  pro: Object.freeze({
    id: "pro",
    label: "Pro",
    monthly_base_usd: 199,
    included_seats: 3,
    included_storage_bytes: 1024 * GiB,
    projects: 100,
    runs: 100_000,
    metric_points: 250_000_000,
    warehouse_kind: "standard",
    min_replica_memory_gb: 12,
    max_replica_memory_gb: 12,
    num_replicas: 1,
  }),
  premium: Object.freeze({
    id: "premium",
    label: "Premium",
    monthly_base_usd: 699,
    included_seats: 10,
    included_storage_bytes: 5 * 1024 * GiB,
    projects: 500,
    runs: 1_000_000,
    metric_points: 2_000_000_000,
    warehouse_kind: "dedicated",
    min_replica_memory_gb: 16,
    max_replica_memory_gb: 16,
    num_replicas: 2,
  }),
});

const LEGACY_PLAN_ALIASES = Object.freeze({
  lab: "pro",
  startup: "pro",
  growth: "premium",
});

export const USAGE_OVERAGE_POLICY = Object.freeze({
  paid_extra_seats: "tracked_not_billed",
  seats: "paid_extra_seats",
  projects: "blocked_at_limit",
  runs: "blocked_at_limit",
  metric_points: "blocked_at_limit",
  storage: "blocked_at_limit",
  artifacts: "visibility_only",
  api_keys: "visibility_only",
});

export class ValidationError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}
export class PlanLimitError extends Error {}

export function defaultDbPath() {
  return path.join(".instantml", "instantml.json");
}

export function utcNow() {
  return new Date().toISOString();
}

export function emptyState() {
  return {
    users: [],
    userIdentities: [],
    organizations: [defaultOrganization()],
    memberships: [],
    serviceAccounts: [],
    apiKeys: [],
    projects: [],
    runs: [],
    metrics: [],
    metricSeries: [],
    artifacts: [],
    attributes: [],
    imports: [],
    ingestRequests: [],
    auditEvents: [],
    nextMetricId: 1,
    nextAttributeId: 1,
    nextImportId: 1,
    nextAuditEventId: 1,
  };
}

export function loadState(dbPath) {
  if (!fs.existsSync(dbPath)) return emptyState();
  const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  return normalizeState({
    users: Array.isArray(parsed.users) ? parsed.users : [],
    userIdentities: Array.isArray(parsed.userIdentities) ? parsed.userIdentities : [],
    organizations: Array.isArray(parsed.organizations) ? parsed.organizations : [],
    memberships: Array.isArray(parsed.memberships) ? parsed.memberships : [],
    serviceAccounts: Array.isArray(parsed.serviceAccounts) ? parsed.serviceAccounts : [],
    apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
    metricSeries: Array.isArray(parsed.metricSeries) ? parsed.metricSeries : null,
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    attributes: Array.isArray(parsed.attributes) ? parsed.attributes : [],
    imports: Array.isArray(parsed.imports) ? parsed.imports : [],
    ingestRequests: Array.isArray(parsed.ingestRequests) ? parsed.ingestRequests : [],
    auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents : [],
    nextMetricId: Number.isInteger(parsed.nextMetricId) ? parsed.nextMetricId : 1,
    nextAttributeId: Number.isInteger(parsed.nextAttributeId) ? parsed.nextAttributeId : 1,
    nextImportId: Number.isInteger(parsed.nextImportId) ? parsed.nextImportId : 1,
    nextAuditEventId: Number.isInteger(parsed.nextAuditEventId) ? parsed.nextAuditEventId : 1,
  });
}

export function openStore(dbPath = defaultDbPath()) {
  return createStore(loadState(dbPath), dbPath);
}

export function createStore(state = emptyState(), dbPath = null) {
  const persist = () => {
    if (!dbPath) return;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(state, null, 2));
  };
  return {
    state,
    close: () => persist(),
    createUser: (input) => write(persist, () => createUser(state, input)),
    listUsers: () => listUsers(state),
    createOrganization: (input) => write(persist, () => createOrganization(state, input)),
    listOrganizations: () => listOrganizations(state),
    createApiKey: (orgId, input = {}) => write(persist, () => createApiKey(state, orgId, input)),
    listApiKeys: (orgId) => listApiKeys(state, orgId),
    authenticateApiKey: (token) => write(persist, () => authenticateApiKey(state, token)),
    createProject: (input) => write(persist, () => createProject(state, input)),
    listProjects: (input = {}) => listProjects(state, input),
    createRun: (input) => write(persist, () => createRun(state, input)),
    getRun: (id) => getRun(state, id),
    listRuns: (input = {}) => listRuns(state, input),
    updateRun: (id, input) => write(persist, () => updateRun(state, id, input)),
    logMetrics: (runId, input, options = {}) => write(persist, () => logMetrics(state, runId, input, options)),
    getMetrics: (runId, input = {}) => getMetrics(state, runId, input),
    createAttributes: (runId, input) => write(persist, () => createAttributes(state, runId, input)),
    listAttributes: (runId, input = {}) => listAttributes(state, runId, input),
    createArtifact: (runId, input) => write(persist, () => createArtifact(state, runId, input)),
    prevalidateArtifact: (runId, input) => prevalidateArtifact(state, runId, input),
    getArtifact: (artifactId) => getArtifact(state, artifactId),
    listArtifacts: (runId) => listArtifacts(state, runId),
    sideBySide: (input = {}) => sideBySide(state, input),
    importNeptune: (input = {}) => write(persist, () => importNeptune(state, input)),
    importWandb: (input = {}) => write(persist, () => importWandb(state, input)),
    importMlflow: (input = {}) => write(persist, () => importMlflow(state, input)),
    listImports: (input = {}) => listImports(state, input),
    overview: (input = {}) => overview(state, input),
    runsSummary: (input = {}) => runsSummary(state, input),
    exportData: (input = {}) => exportData(state, input),
    usageSummary: (input = {}) => usageSummary(state, input),
    usageExport: (input = {}) => usageExport(state, input),
    resetDemo: (input = {}) => write(persist, () => resetDemo(state, input)),
  };
}

export function createUser(state, input) {
  const email = validateEmail(input?.email ?? input?.primary_email);
  const provider = input?.provider === undefined || input?.provider === null ? null : validateName(input.provider, "provider");
  const providerSubject = input?.provider_subject === undefined || input?.provider_subject === null ? null : validateName(input.provider_subject, "provider_subject");
  const existingIdentity =
    provider && providerSubject ? state.userIdentities.find((identity) => identity.provider === provider && identity.provider_subject === providerSubject) : null;
  if (existingIdentity) return getUserRecord(state, existingIdentity.user_id);
  let user = state.users.find((candidate) => candidate.primary_email.toLowerCase() === email.toLowerCase());
  if (!user) {
    user = {
      id: randomUUID(),
      primary_email: email,
      display_name: input?.display_name === undefined || input?.display_name === null ? null : validateName(input.display_name, "display_name"),
      avatar_url: input?.avatar_url === undefined || input?.avatar_url === null ? null : validateName(input.avatar_url, "avatar_url"),
      created_at: utcNow(),
      last_seen_at: utcNow(),
    };
    state.users.push(user);
  } else {
    user.last_seen_at = utcNow();
  }
  if (provider && providerSubject) {
    state.userIdentities.push({
      id: randomUUID(),
      user_id: user.id,
      provider,
      provider_subject: providerSubject,
      email,
      email_verified: input?.email_verified === undefined ? true : Boolean(input.email_verified),
      created_at: utcNow(),
    });
  }
  return getUserRecord(state, user.id);
}

export function listUsers(state) {
  return [...state.users].sort((a, b) => a.primary_email.localeCompare(b.primary_email)).map(clone);
}

export function createOrganization(state, input) {
  const slug = validateSlug(input?.slug ?? input?.name, "organization slug");
  const name = validateName(input?.name ?? slug, "organization name");
  const existing = state.organizations.find((organization) => organization.slug.toLowerCase() === slug.toLowerCase());
  if (existing) return clone(existing);
  const ownerUserId = input?.owner_user_id === undefined || input?.owner_user_id === null ? null : validateName(input.owner_user_id, "owner_user_id");
  if (ownerUserId) getUserRecord(state, ownerUserId);
  const planTier = validatePlanTier(input?.plan_tier ?? "free");
  const organization = {
    id: randomUUID(),
    slug,
    name,
    plan_tier: planTier,
    account_type: "customer",
    seat_limit: PLAN_TIERS[planTier].included_seats,
    created_by_user_id: ownerUserId,
    created_at: utcNow(),
  };
  state.organizations.push(organization);
  if (ownerUserId) {
    state.memberships.push({
      id: randomUUID(),
      org_id: organization.id,
      user_id: ownerUserId,
      role: "owner",
      status: "active",
      created_at: utcNow(),
    });
  }
  audit(state, organization.id, "organization.created", { slug });
  return clone(organization);
}

export function listOrganizations(state) {
  ensureDefaultOrg(state);
  return [...state.organizations].sort((a, b) => a.slug.localeCompare(b.slug)).map(clone);
}

export function createApiKey(state, orgId, input = {}) {
  const org = getOrganization(state, orgId);
  const name = validateName(input?.name ?? "SDK API key", "api key name");
  const serviceAccount = {
    id: randomUUID(),
    org_id: org.id,
    name,
    created_by_user_id: input?.created_by_user_id === undefined || input?.created_by_user_id === null ? null : validateName(input.created_by_user_id, "created_by_user_id"),
    created_at: utcNow(),
    disabled_at: null,
  };
  if (serviceAccount.created_by_user_id) getUserRecord(state, serviceAccount.created_by_user_id);
  state.serviceAccounts.push(serviceAccount);
  const secret = `instantml_${randomBytes(24).toString("base64url")}`;
  const key = {
    id: randomUUID(),
    org_id: org.id,
    service_account_id: serviceAccount.id,
    name,
    key_prefix: secret.slice(0, 14),
    key_hash: hashSecret(secret),
    scopes: validateScopes(input?.scopes ?? ["sdk:ingest", "artifacts:write", "imports:write"]),
    created_at: utcNow(),
    last_used_at: null,
    revoked_at: null,
  };
  state.apiKeys.push(key);
  audit(state, org.id, "api_key.created", { api_key_id: key.id, name });
  return {
    api_key: secret,
    key: publicApiKey(key),
    service_account: clone(serviceAccount),
  };
}

export function listApiKeys(state, orgId) {
  const org = getOrganization(state, orgId);
  return state.apiKeys
    .filter((key) => key.org_id === org.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(publicApiKey);
}

export function authenticateApiKey(state, token) {
  const secret = validateName(token, "api key");
  const digest = hashSecret(secret);
  for (const key of state.apiKeys) {
    if (key.revoked_at) continue;
    if (!constantTimeEqual(key.key_hash, digest)) continue;
    const serviceAccount = state.serviceAccounts.find((candidate) => candidate.id === key.service_account_id);
    if (!serviceAccount || serviceAccount.disabled_at) throw new UnauthorizedError("api key is disabled");
    key.last_used_at = utcNow();
    return {
      org_id: key.org_id,
      api_key_id: key.id,
      service_account_id: serviceAccount.id,
      scopes: [...key.scopes],
    };
  }
  throw new UnauthorizedError("invalid api key");
}

export function createProject(state, input, options = {}) {
  const orgId = resolveOrgId(state, input?.org_id);
  const name = validateName(input?.name, "project name");
  const description = input?.description ?? null;
  if (description !== null && typeof description !== "string") throw new ValidationError("description must be a string");
  const existing = state.projects.find((project) => project.org_id === orgId && project.name === name);
  if (existing) return clone(existing);
  if (!options.skipPlanCapacity) {
    assertPlanCapacity(state, orgId, { projects: 1, storage_bytes: PROJECT_METADATA_BYTES }, "create a project");
  }
  const project = { id: randomUUID(), org_id: orgId, name, description, created_at: utcNow() };
  state.projects.push(project);
  return clone(project);
}

export function listProjects(state, input = {}) {
  const orgId = input.org_id ? resolveOrgId(state, input.org_id) : null;
  return state.projects
    .filter((project) => (orgId ? project.org_id === orgId : true))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(clone);
}

export function createRun(state, input, options = {}) {
  const orgId = resolveOrgId(state, input?.org_id);
  const projectName = validateName(input?.project, "project name");
  const projectExists = state.projects.some((project) => project.org_id === orgId && project.name === projectName);
  if (!options.skipPlanCapacity) {
    assertPlanCapacity(state, orgId, {
      projects: projectExists ? 0 : 1,
      runs: 1,
      storage_bytes: RUN_METADATA_BYTES + (projectExists ? 0 : PROJECT_METADATA_BYTES),
    }, "create a run");
  }
  const project = createProject(state, { org_id: orgId, name: projectName }, { skipPlanCapacity: true });
  const now = utcNow();
  const run = {
    id: randomUUID(),
    org_id: orgId,
    project_id: project.id,
    project: project.name,
    name: validateName(input?.name || `${project.name}-run`, "run name"),
    status: "running",
    config: validateObject(input?.config ?? {}, "config"),
    tags: validateTags(input?.tags ?? []),
    metadata: validateObject(input?.metadata ?? {}, "metadata"),
    created_at: now,
    started_at: now,
    finished_at: null,
  };
  state.runs.push(run);
  for (const [key, value] of Object.entries(run.config)) {
    createAttribute(state, run.id, { path: `config/${key}`, type: "config", value, summary: { source: "run.config" } });
  }
  for (const tag of run.tags) {
    createAttribute(state, run.id, { path: "sys/tags", type: "tag", value: tag, summary: { group: false } });
  }
  return clone(run);
}

export function getRun(state, id) {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) throw new NotFoundError("run not found");
  return runSummaryForRun(state, run);
}

export function listRuns(state, input = {}) {
  const limit = validateLimit(input.limit, 100, 500);
  const offset = validateOffset(input.offset);
  const sortBy = validateRunSort(input.sort_by ?? input.sortBy ?? "created");
  const metricKey = input.metric_key ? validateName(input.metric_key, "metric key") : "eval/return_mean";
  return sortRunRecords(state, filterRuns(state, input), sortBy, metricKey)
    .slice(offset, offset + limit)
    .map(clone);
}

export function updateRun(state, id, input) {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) throw new NotFoundError("run not found");
  const hasStatus = Object.hasOwn(input ?? {}, "status");
  const hasTags = Object.hasOwn(input ?? {}, "tags");
  const hasNotes = Object.hasOwn(input ?? {}, "notes");
  if (!hasStatus && !hasTags && !hasNotes) throw new ValidationError("at least one of status, tags, or notes is required");
  if (hasStatus) {
    const status = input?.status;
    if (!RUN_STATUSES.has(status)) throw new ValidationError("status must be one of: failed, finished, running");
    run.status = status;
    run.finished_at = status === "finished" || status === "failed" ? utcNow() : null;
  }
  if (hasTags) run.tags = validateTags(input.tags);
  if (hasNotes) {
    const note = validateNotePatch(input.notes);
    run.metadata = validateObject(run.metadata ?? {}, "metadata");
    if (note) run.metadata.notes = note;
    else delete run.metadata.notes;
  }
  return clone(run);
}

export function logMetrics(state, runId, input, options = {}) {
  const run = ensureRun(state, runId);
  authorizeOrg(run.org_id, options.auth);
  const idempotencyKey = options.idempotencyKey === undefined || options.idempotencyKey === null || options.idempotencyKey === "" ? null : validateName(options.idempotencyKey, "idempotency key");
  const bodyHash = idempotencyKey ? hashCanonical({ run_id: runId, body: input }) : null;
  if (idempotencyKey) {
    const existing = state.ingestRequests.find((request) => request.org_id === run.org_id && request.idempotency_key === idempotencyKey);
    if (existing) {
      if (existing.body_hash !== bodyHash) throw new ConflictError("idempotency key was already used with a different payload");
      return existing.response.inserted;
    }
  }
  const step = validateStep(input?.step);
  const metrics = validateMetrics(input?.metrics);
  const now = input?.timestamp ? validateTimestamp(input.timestamp) : utcNow();
  const previewCompletion = input?.preview_completion === undefined ? null : validatePreviewCompletion(input.preview_completion);
  if (!options.skipPlanCapacity) {
    assertPlanCapacity(state, run.org_id, { metric_points: Object.keys(metrics).length }, "log metrics");
  }
  for (const [key, value] of Object.entries(metrics)) {
    const metric = { id: state.nextMetricId++, org_id: run.org_id, run_id: runId, key, step, value, created_at: now };
    state.metrics.push(metric);
    updateMetricSeries(state, metric);
    if (!options.skipMetricAttributes) {
      createAttribute(state, runId, {
        path: key,
        type: "float_series",
        step,
        timestamp: now,
        value,
        summary: {
          preview: Boolean(input?.preview),
          preview_completion: previewCompletion,
        },
      });
    }
  }
  const response = { inserted: Object.keys(metrics).length };
  if (idempotencyKey) {
    state.ingestRequests.push({
      id: randomUUID(),
      org_id: run.org_id,
      run_id: runId,
      idempotency_key: idempotencyKey,
      body_hash: bodyHash,
      response,
      created_at: utcNow(),
    });
  }
  return response.inserted;
}

export function getMetrics(state, runId, input = {}) {
  ensureRun(state, runId);
  const limit = validateLimit(input.limit, 1000, 5000);
  const key = input.key ? validateName(input.key, "metric key") : null;
  const start = optionalStep(input.start_step, "start_step");
  const end = optionalStep(input.end_step, "end_step");
  if (start !== null && end !== null && start > end) throw new ValidationError("start_step must be less than or equal to end_step");
  return state.metrics
    .filter((metric) => metric.run_id === runId)
    .filter((metric) => (key ? metric.key === key : true))
    .filter((metric) => (start !== null ? metric.step >= start : true))
    .filter((metric) => (end !== null ? metric.step <= end : true))
    .sort((a, b) => a.step - b.step || a.id - b.id)
    .slice(0, limit)
    .map(({ key: metricKey, step, value, created_at }) => ({ key: metricKey, step, value, created_at }));
}

export function createAttributes(state, runId, input) {
  ensureRun(state, runId);
  const attributes = Array.isArray(input?.attributes) ? input.attributes : [input];
  if (attributes.length === 0) throw new ValidationError("attributes must not be empty");
  const validated = attributes.map((attribute) => validateAttributeInput(state, runId, attribute));
  return validated.map((attribute) => appendAttribute(state, attribute));
}

export function listAttributes(state, runId, input = {}) {
  ensureRun(state, runId);
  const limit = validateLimit(input.limit, 1000, 5000);
  const type = input.type ? validateAttributeType(input.type) : null;
  const pathPrefix = input.path_prefix ? validateName(input.path_prefix, "path_prefix") : null;
  return state.attributes
    .filter((attribute) => attribute.run_id === runId)
    .filter((attribute) => (type ? attribute.type === type : true))
    .filter((attribute) => (pathPrefix ? attribute.path.startsWith(pathPrefix) : true))
    .sort((a, b) => (a.step ?? -1) - (b.step ?? -1) || a.id - b.id)
    .slice(0, limit)
    .map(clone);
}

export function createArtifact(state, runId, input, options = {}) {
  const artifact = validateArtifactInput(state, runId, input);
  if (!options.skipPlanCapacity) {
    assertPlanCapacity(state, artifact.org_id, {
      storage_bytes: (artifact.size_bytes ?? 0) + ARTIFACT_METADATA_BYTES,
    }, "create an artifact");
  }
  state.artifacts.push(artifact);
  appendAttribute(state, validateAttributeInput(state, runId, {
    path: input?.path ?? `artifacts/${artifact.name}`,
    type: artifact.step === null ? "file" : "file_series",
    step: artifact.step,
    value: artifact.uri,
    artifact_id: artifact.id,
    summary: { artifact_type: artifact.type, size_bytes: artifact.size_bytes, sha256: artifact.sha256, mime_type: artifact.mime_type },
  }));
  return clone(artifact);
}

export function prevalidateArtifact(state, runId, input) {
  const artifact = validateArtifactInput(state, runId, {
    ...input,
    type: input?.type ?? "file",
    uri: "instantml://preflight",
    size_bytes: 1,
    sha256: "preflight",
    storage_path: "preflight",
  });
  validateAttributeInput(state, runId, {
    path: input?.path ?? `artifacts/${artifact.name}`,
    type: artifact.step === null ? "file" : "file_series",
    step: artifact.step,
    value: artifact.uri,
    artifact_id: artifact.id,
    summary: { artifact_type: artifact.type, size_bytes: artifact.size_bytes, sha256: artifact.sha256, mime_type: artifact.mime_type },
  });
  return true;
}

export function getArtifact(state, artifactId) {
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new NotFoundError("artifact not found");
  return clone(artifact);
}

export function listArtifacts(state, runId) {
  ensureRun(state, runId);
  return state.artifacts
    .filter((artifact) => artifact.run_id === runId)
    .sort((a, b) => (a.step ?? -1) - (b.step ?? -1) || a.created_at.localeCompare(b.created_at))
    .map(clone);
}

export function sideBySide(state, input = {}) {
  const runIds = parseRunIds(input.run_ids ?? input.runs);
  const diffOnly = input.diff_only === "true" || input.diff_only === true;
  const referenceRunId = input.reference_run_id || runIds[0] || null;
  const runs = runIds.map((id) => getRun(state, id));
  const orgId = input.org_id ? resolveOrgId(state, input.org_id) : null;
  if (orgId && runs.some((run) => run.org_id !== orgId)) throw new ForbiddenError("run belongs to a different organization");
  const valuesByRun = new Map(runs.map((run) => [run.id, sideBySideValuesForRun(state, run.id)]));
  const paths = new Set();
  for (const values of valuesByRun.values()) Object.keys(values).forEach((key) => paths.add(key));
  const rows = [...paths].sort().map((attributePath) => {
    const values = {};
    for (const run of runs) values[run.id] = valuesByRun.get(run.id)[attributePath] ?? null;
    const reference = referenceRunId ? values[referenceRunId] ?? null : null;
    const different = new Set(Object.values(values).map(stableJson)).size > 1;
    return { path: attributePath, values, reference_run_id: referenceRunId, reference, different };
  });
  return { runs, reference_run_id: referenceRunId, rows: diffOnly ? rows.filter((row) => row.different) : rows };
}

export function importNeptune(state, input = {}) {
  return importCanonical(state, normalizeNeptuneImport(state, input));
}

export function importWandb(state, input = {}) {
  return importCanonical(state, normalizeWandbImport(state, input));
}

export function importMlflow(state, input = {}) {
  return importCanonical(state, normalizeMlflowImport(state, input));
}

function importCanonical(state, canonical) {
  const orgId = resolveOrgId(state, canonical.org_id);
  const sourceType = validateName(canonical.source_type, "source_type");
  const project = validateName(canonical.project, "project");
  const runs = validateCanonicalImportRuns(canonical.runs);
  const summary = { ...summarizeCanonicalImport(project, runs), ...(canonical.summary ?? {}) };
  const draft = clone(state);
  const importedRunIds = commitCanonicalImport(draft, { orgId, sourceType, project, runs });
  const record = {
    id: draft.nextImportId++,
    org_id: orgId,
    source_type: sourceType,
    project,
    run_ids: importedRunIds,
    summary,
    created_at: utcNow(),
  };
  draft.imports.push(record);
  if (canonical.dry_run) return { dry_run: true, summary };
  Object.assign(state, draft);
  return { dry_run: false, import: clone(record), summary };
}

function commitCanonicalImport(state, canonical) {
  const importedRunIds = [];
  for (const item of canonical.runs) {
    const run = createRun(state, {
      org_id: canonical.orgId,
      project: canonical.project,
      name: item.name,
      config: item.config,
      tags: item.tags,
      metadata: canonicalRunMetadata(canonical.sourceType, item),
    });
    importedRunIds.push(run.id);
    for (const metric of item.metrics) {
      logMetrics(state, run.id, { step: metric.step, timestamp: metric.timestamp, metrics: { [metric.key]: metric.value } });
    }
    if (item.attributes.length) createAttributes(state, run.id, { attributes: item.attributes });
    for (const artifact of item.artifacts) createArtifact(state, run.id, artifact);
    updateRun(state, run.id, { status: item.status });
    applyImportedRunTimestamps(state, run.id, item);
  }
  return importedRunIds;
}

function canonicalRunMetadata(sourceType, item) {
  const metadata = clone(item.metadata);
  metadata.import = {
    source_type: sourceType,
    external_run_id: item.external_run_id,
  };
  return metadata;
}

function applyImportedRunTimestamps(state, runId, item) {
  if (!item.started_at && !item.finished_at) return;
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new NotFoundError("run not found");
  if (item.started_at) run.started_at = item.started_at;
  if (item.finished_at && (run.status === "finished" || run.status === "failed")) run.finished_at = item.finished_at;
}

function validateCanonicalImportRuns(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError("runs must be a non-empty list");
  return value.map((candidate, index) => {
    const run = validateObject(candidate, "run");
    return {
      external_run_id: run.external_run_id === undefined || run.external_run_id === null ? null : validateName(String(run.external_run_id), "external_run_id"),
      name: validateName(run.name ?? `imported-run-${index + 1}`, "run name"),
      status: RUN_STATUSES.has(run.status) ? run.status : "finished",
      config: validateObject(run.config ?? {}, "run config"),
      tags: validateTags(run.tags ?? []),
    metadata: validateObject(run.metadata ?? {}, "run metadata"),
    started_at: run.started_at === undefined || run.started_at === null ? null : validateTimestamp(run.started_at),
    finished_at: run.finished_at === undefined || run.finished_at === null ? null : validateTimestamp(run.finished_at),
    metrics: optionalList(run.metrics, "run metrics").map((candidateMetric, metricIndex) => {
        const metric = validateObject(candidateMetric, "run metric");
        return {
          key: validateName(metric.key, "metric key"),
          step: metric.step === undefined || metric.step === null ? metricIndex : validateStep(metric.step),
          value: validateMetricValue(metric.value),
          timestamp: metric.timestamp === undefined || metric.timestamp === null ? null : validateTimestamp(metric.timestamp),
        };
      }),
      attributes: optionalList(run.attributes, "run attributes"),
      artifacts: optionalList(run.artifacts, "run artifacts"),
    };
  });
}

function normalizeNeptuneImport(state, input) {
  return {
    org_id: input.org_id,
    dry_run: isDryRun(input),
    source_type: "neptune_exporter_json",
    project: input.project,
    runs: optionalList(input.runs, "runs").map((candidate) => {
      const item = validateObject(candidate, "neptune run");
      const metadata = validateObject(item.metadata ?? {}, "neptune metadata");
      const neptuneId = item.id ?? item.neptune_id ?? metadata.neptune_id ?? null;
      return {
        external_run_id: neptuneId,
        name: item.name,
        status: RUN_STATUSES.has(item.status) ? item.status : "finished",
        config: item.config ?? {},
        tags: item.tags ?? [],
        metadata: {
          neptune: {
            run_id: neptuneId,
            metadata,
          },
        },
        metrics: optionalList(item.metrics, "run metrics").map((candidateMetric) => {
          const metric = validateObject(candidateMetric, "run metric");
          return {
            key: metric.key,
            step: metric.step ?? 0,
            value: metric.value,
            timestamp: metric.timestamp ?? null,
          };
        }),
        attributes: optionalList(item.attributes, "run attributes"),
        artifacts: optionalList(item.artifacts, "run artifacts"),
      };
    }),
  };
}

function normalizeWandbImport(state, input) {
  return {
    org_id: input.org_id,
    dry_run: isDryRun(input),
    source_type: "wandb_json",
    project: input.project,
    runs: optionalList(input.runs, "runs").map((item) => normalizeWandbRun(validateObject(item, "wandb run"))),
  };
}

function normalizeMlflowImport(state, input) {
  validateImportSchemaVersion(input.schema_version);
  const warnings = [];
  const skipped = { artifact_directories: 0 };
  const runs = optionalList(input.runs, "runs").map((item, index) => normalizeMlflowRun(validateObject(item, "mlflow run"), index, warnings, skipped));
  const summary = {};
  if (warnings.length) summary.warnings = warnings;
  if (skipped.artifact_directories) summary.skipped = skipped;
  return {
    org_id: input.org_id,
    dry_run: isDryRun(input),
    source_type: "mlflow_json",
    project: input.project,
    runs,
    summary,
  };
}

function normalizeMlflowRun(item, index, warnings, skipped) {
  const info = validateObject(item.info ?? {}, "mlflow info");
  const data = validateObject(item.data ?? {}, "mlflow data");
  const params = keyValueObject(optionalList(data.params, "mlflow params"), "mlflow param");
  const tags = keyValueObject(optionalList(data.tags, "mlflow tags"), "mlflow tag", { allowDuplicateRunName: true });
  const runId = info.run_id ?? info.run_uuid ?? item.run_id ?? null;
  const runUuid = info.run_uuid ?? info.run_id ?? null;
  const experimentId = info.experiment_id === undefined || info.experiment_id === null ? null : String(info.experiment_id);
  const status = mapMlflowStatus(info.status ?? item.status);
  const startedAt = mlflowTimestamp(info.start_time, "mlflow start_time");
  const finishedAt = mlflowTimestamp(info.end_time, "mlflow end_time");
  const latestMetrics = mlflowMetrics(optionalList(data.metrics, "mlflow latest metrics"), "mlflow latest metric");
  const historyMetrics = mlflowMetrics(optionalList(item.metric_history, "mlflow metric_history"), "mlflow history metric");
  const historyKeys = new Set(historyMetrics.map((metric) => metric.key));
  const fallbackMetrics = latestMetrics.filter((metric) => !historyKeys.has(metric.key));
  if (item.metric_history_complete !== true) {
    warnings.push(`mlflow run ${runId ?? index + 1} metric history may be incomplete; latest metrics were used only for missing keys`);
  }
  const artifactRoot = item.artifact_root_uri ?? info.artifact_uri ?? null;
  const artifacts = optionalList(item.artifacts, "mlflow artifacts")
    .map((artifact) => normalizeMlflowArtifact(validateObject(artifact, "mlflow artifact"), artifactRoot, skipped))
    .filter(Boolean);
  return {
    external_run_id: runId,
    name: info.run_name ?? tags["mlflow.runName"] ?? runId ?? `mlflow-run-${index + 1}`,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    config: params,
    tags: [],
    metadata: {
      mlflow: {
        run_id: runId,
        run_uuid: runUuid,
        experiment_id: experimentId,
        status: info.status ?? item.status ?? null,
        start_time: startedAt,
        end_time: finishedAt,
        artifact_uri: info.artifact_uri ?? null,
        params,
        tags,
        latest_metrics: latestMetricsByKey(latestMetrics),
        metric_history_complete: item.metric_history_complete === true,
      },
    },
    metrics: [...historyMetrics, ...fallbackMetrics],
    attributes: [],
    artifacts,
  };
}

function keyValueObject(entries, field, options = {}) {
  const values = {};
  for (const candidate of entries) {
    const entry = validateObject(candidate, field);
    const key = validateName(entry.key, `${field} key`);
    if (typeof entry.value !== "string") throw new ValidationError(`${field} value must be a string`);
    if (Object.hasOwn(values, key) && !(options.allowDuplicateRunName && key === "mlflow.runName")) throw new ValidationError(`${field} keys must be unique`);
    values[key] = entry.value;
  }
  return values;
}

function mlflowMetrics(entries, field) {
  return entries.map((candidate, index) => {
    const metric = validateObject(candidate, field);
    return {
      key: validateName(metric.key, "metric key"),
      step: metric.step === undefined || metric.step === null ? index : validateStep(metric.step),
      value: validateMetricValue(metric.value),
      timestamp: mlflowTimestamp(metric.timestamp, "mlflow metric timestamp"),
    };
  });
}

function latestMetricsByKey(metrics) {
  const latest = {};
  for (const metric of metrics) latest[metric.key] = { value: metric.value, step: metric.step, timestamp: metric.timestamp };
  return latest;
}

function normalizeMlflowArtifact(artifact, artifactRoot, skipped) {
  if (artifact.is_dir === true) {
    skipped.artifact_directories += 1;
    return null;
  }
  const artifactPath = validateRelativeArtifactPath(artifact.path ?? artifact.name, "mlflow artifact path");
  return normalizeExternalArtifact("mlflow", {
    name: path.posix.basename(artifactPath),
    type: artifact.type ?? null,
    uri: artifact.uri ?? joinArtifactUri(artifactRoot, artifactPath),
    step: artifact.step ?? null,
    size_bytes: artifact.file_size ?? artifact.size_bytes ?? null,
    metadata: {
      ...validateObject(artifact.metadata ?? {}, "mlflow artifact metadata"),
      path: artifactPath,
      root_uri: artifactRoot,
      is_dir: false,
    },
  });
}

function validateRelativeArtifactPath(value, field) {
  const text = validateName(value, field).replaceAll("\\", "/");
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text)) throw new ValidationError(`${field} must be a relative path`);
  if (text.split("/").some((part) => part === "..")) throw new ValidationError(`${field} must not contain traversal`);
  return text;
}

function joinArtifactUri(root, artifactPath) {
  if (root === undefined || root === null || root === "") return `mlflow://${artifactPath}`;
  return `${validateName(String(root), "artifact root uri").replace(/\/+$/, "")}/${artifactPath}`;
}

function mapMlflowStatus(value) {
  const text = String(value ?? "FINISHED").toUpperCase();
  if (text === "RUNNING" || text === "SCHEDULED") return "running";
  if (text === "FINISHED") return "finished";
  if (text === "FAILED" || text === "KILLED") return "failed";
  throw new ValidationError("mlflow status must be one of: RUNNING, SCHEDULED, FINISHED, FAILED, KILLED");
}

function mlflowTimestamp(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} must be finite`);
    return validateDateRange(new Date(value), field);
  }
  if (typeof value === "string") return validateTimestamp(value);
  throw new ValidationError(`${field} must be epoch milliseconds or an ISO-compatible datetime`);
}

function normalizeWandbRun(item) {
  const metadata = validateObject(item.metadata ?? {}, "wandb metadata");
  const summary = validateObject(item.summary ?? {}, "wandb summary");
  const runId = item.id ?? item.run_id ?? null;
  return {
    external_run_id: runId,
    name: item.name ?? runId ?? "wandb-run",
    status: mapExternalRunStatus(item.state ?? item.status),
    config: item.config ?? {},
    tags: item.tags ?? [],
    metadata: {
      wandb: {
        run_id: runId,
        state: item.state ?? item.status ?? null,
        summary,
        metadata,
      },
    },
    metrics: wandbHistoryMetrics(optionalList(item.history, "wandb history")),
    attributes: [],
    artifacts: optionalList(item.artifacts, "wandb artifacts").map((artifact) => normalizeExternalArtifact("wandb", validateObject(artifact, "wandb artifact"))),
  };
}

function wandbHistoryMetrics(history) {
  const metrics = [];
  for (const [rowIndex, row] of history.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ValidationError("wandb history rows must be objects");
    const step = row._step === undefined || row._step === null ? rowIndex : validateStep(row._step, "_step");
    const timestamp = externalTimestamp(row._timestamp);
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith("_") || value === null || (typeof value === "string" && value.trim() === "") || typeof value === "boolean") continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      metrics.push({ key, step, value, timestamp });
    }
  }
  return metrics;
}

function normalizeExternalArtifact(source, artifact) {
  const name = validateName(artifact.name ?? artifact.path, "artifact name");
  const externalType = artifact.type === undefined || artifact.type === null ? null : validateName(String(artifact.type), "artifact type");
  const metadata = validateObject(artifact.metadata ?? {}, "artifact metadata");
  if (externalType) metadata.external_type = externalType;
  metadata.source = source;
  return {
    type: mapExternalArtifactType(externalType, name),
    name,
    uri: validateName(artifact.uri ?? `${source}://${name}`, "artifact uri"),
    step: artifact.step === undefined || artifact.step === null ? null : validateStep(artifact.step),
    size_bytes: artifact.size_bytes ?? artifact.file_size ?? null,
    metadata,
  };
}

function mapExternalArtifactType(externalType, name) {
  const text = `${externalType ?? ""} ${name}`.toLowerCase();
  if (text.includes("checkpoint") || text.includes("model") || /\.(pt|pth|ckpt|safetensors|onnx)$/.test(text)) return "checkpoint";
  if (text.includes("rollout") || text.includes("video") || /\.(mp4|mov|webm)$/.test(text)) return "rollout";
  return "file";
}

function mapExternalRunStatus(value) {
  const text = String(value ?? "").toLowerCase();
  if (text === "running") return "running";
  if (text === "failed" || text === "crashed" || text === "killed") return "failed";
  return "finished";
}

function externalTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError("timestamp must be finite");
    return validateDateRange(new Date(value * 1000), "timestamp");
  }
  return validateTimestamp(value);
}

function validateMetricValue(value) {
  return validateJsonNumber(value, "metric values");
}

function isDryRun(input) {
  return input.dry_run === true || input.dry_run === "true";
}

function validateImportSchemaVersion(value) {
  if (value === undefined || value === null) return 1;
  if (value !== 1) throw new ValidationError("schema_version must be 1");
  return value;
}

export function listImports(state, input = {}) {
  const orgId = input.org_id ? resolveOrgId(state, input.org_id) : null;
  return state.imports
    .filter((record) => (orgId ? record.org_id === orgId : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(clone);
}

export function overview(state, input = {}) {
  const runs = filterRuns(state, input);
  const runIds = new Set(runs.map((run) => run.id));
  const metricKey = input.metric_key ? validateName(input.metric_key, "metric key") : "eval/return_mean";
  const matchingSeries = state.metricSeries.filter((series) => runIds.has(series.run_id));
  const selectedSeries = matchingSeries.filter((series) => series.key === metricKey);
  return {
    total_runs: runs.length,
    active_runs: runs.filter((run) => run.status === "running").length,
    failed_runs: runs.filter((run) => run.status === "failed").length,
    metric_points: matchingSeries.reduce((sum, series) => sum + series.count, 0),
    best_eval_return: selectedSeries.length ? Math.max(...selectedSeries.map((series) => series.max)) : null,
  };
}

export function runsSummary(state, input = {}) {
  const limit = validateLimit(input.limit, 100, 500);
  const offset = validateOffset(input.offset);
  const sortBy = validateRunSort(input.sort_by ?? input.sortBy ?? "created");
  const metricKey = input.metric_key ? validateName(input.metric_key, "metric key") : "eval/return_mean";
  const filtered = sortRunRecords(state, filterRuns(state, input), sortBy, metricKey);
  const page = filtered.slice(offset, offset + limit);
  const metricKeys = new Set();
  const filteredRunIds = new Set(filtered.map((run) => run.id));
  state.metricSeries.filter((series) => filteredRunIds.has(series.run_id)).forEach((series) => metricKeys.add(series.key));
  const runs = page.map((run) => runSummaryForRun(state, run));
  return { runs, limit, offset, total: filtered.length, metric_keys: [...metricKeys].sort() };
}

function runSummaryForRun(state, run) {
  const latest = latestMetricsForRun(state, run.id);
  const aggregates = metricAggregatesForRun(state, run.id);
  return {
    ...clone(run),
    latest_metrics: latest,
    metric_aggregates: aggregates,
    metric_keys: Object.keys(latest).sort(),
    artifact_counts: artifactCountsForRun(state, run.id),
  };
}

export function exportData(state, input = {}) {
  const projects = input.project || input.project_id || input.org_id ? listProjectsForExport(state, input) : state.projects;
  const projectIds = new Set(projects.map((project) => project.id));
  const runs = state.runs.filter((run) => projectIds.has(run.project_id));
  const runIds = new Set(runs.map((run) => run.id));
  const orgIds = new Set(projects.map((project) => project.org_id));
  return {
    version: 1,
    exported_at: utcNow(),
    organizations: state.organizations.filter((organization) => orgIds.has(organization.id)).map(clone),
    projects: projects.map(clone),
    runs: runs.map(clone),
    metric_series: state.metricSeries.filter((series) => runIds.has(series.run_id)).map(clone),
    metrics: state.metrics.filter((metric) => runIds.has(metric.run_id)).sort((a, b) => a.run_id.localeCompare(b.run_id) || a.step - b.step || a.id - b.id).map(clone),
    attributes: state.attributes.filter((attribute) => runIds.has(attribute.run_id)).map(clone),
    artifacts: state.artifacts.filter((artifact) => runIds.has(artifact.run_id)).map(clone),
    imports: state.imports.filter((record) => record.run_ids.some((runId) => runIds.has(runId))).map(clone),
  };
}

export function usageSummary(state, input = {}) {
  ensureDefaultOrg(state);
  const orgs = input.org_id ? [getOrganization(state, input.org_id)] : [...state.organizations].sort((a, b) => a.slug.localeCompare(b.slug));
  const usagePeriod = currentUsagePeriod();
  return {
    schema_version: 1,
    generated_at: utcNow(),
    billing_precision: "not_billable",
    units: { bytes: "bytes", metric_points: "rows" },
    usage_period: usagePeriod,
    plans: publicPlanTiers(),
    overage_policy: clone(USAGE_OVERAGE_POLICY),
    organizations: orgs.map((org) => usageForOrganization(state, org, usagePeriod)),
  };
}

export function usageExport(state, input = {}) {
  const summary = usageSummary(state, input);
  return {
    schema_version: summary.schema_version,
    exported_at: utcNow(),
    generated_at: summary.generated_at,
    format: "json",
    units: summary.units,
    source: "computed_current_state",
    billing_precision: summary.billing_precision,
    usage_period: summary.usage_period,
    plans: summary.plans,
    overage_policy: summary.overage_policy,
    organizations: summary.organizations,
    notes: [
      "Computed from the current Node JSON state.",
      "Artifact bytes are exact only when size_bytes is present.",
      "This export is for billing/debug planning and is not invoice truth.",
    ],
  };
}

export function resetDemo(state, input = {}) {
  const orgId = resolveOrgId(state, input.org_id);
  const demoProject = state.projects.find((project) => project.org_id === orgId && project.name === "demo");
  assertPlanCapacity(state, orgId, demoUsageDelta(!demoProject), "reset the demo dataset");
  if (demoProject) {
    const demoRunIds = new Set(state.runs.filter((run) => run.project_id === demoProject.id).map((run) => run.id));
    state.projects = state.projects.filter((project) => project.id !== demoProject.id);
    state.runs = state.runs.filter((run) => !demoRunIds.has(run.id));
    state.metrics = state.metrics.filter((metric) => !demoRunIds.has(metric.run_id));
    state.metricSeries = state.metricSeries.filter((series) => !demoRunIds.has(series.run_id));
    invalidateMetricSeriesIndex(state);
    state.artifacts = state.artifacts.filter((artifact) => !demoRunIds.has(artifact.run_id));
    state.attributes = state.attributes.filter((attribute) => !demoRunIds.has(attribute.run_id));
    state.ingestRequests = state.ingestRequests.filter((request) => !demoRunIds.has(request.run_id));
  }
  for (let index = 0; index < DEMO_RUN_COUNT; index += 1) {
    const seed = demoSeed(index);
    const workload = demoWorkload(index);
    const run = createRun(state, {
      org_id: orgId,
      project: "demo",
      name: demoRunName(workload, index, seed),
      config: demoConfig(workload, index, seed),
      tags: demoTags(workload, index, seed),
      metadata: demoMetadata(workload, index, seed),
    }, { skipPlanCapacity: true });
    for (const step of DEMO_STEPS) {
      logMetrics(state, run.id, {
        step,
        metrics: demoMetrics(workload, index, seed, step),
      }, { skipMetricAttributes: true, skipPlanCapacity: true });
    }
    updateRun(state, run.id, { status: demoStatus(index) });
    for (const artifact of demoArtifacts(workload, index, seed)) createArtifact(state, run.id, artifact, { skipPlanCapacity: true });
  }
  return runsSummary(state, { org_id: orgId, project: "demo", limit: 100, offset: 0 });
}

function demoUsageDelta(projectIsNew) {
  let metricPoints = 0;
  let artifacts = 0;
  let artifactBytes = 0;
  for (let index = 0; index < DEMO_RUN_COUNT; index += 1) {
    const seed = demoSeed(index);
    const workload = demoWorkload(index);
    for (const step of DEMO_STEPS) metricPoints += Object.keys(demoMetrics(workload, index, seed, step)).length;
    const rows = demoArtifacts(workload, index, seed);
    artifacts += rows.length;
    artifactBytes += rows.reduce((sum, artifact) => sum + (Number.isInteger(artifact.size_bytes) ? artifact.size_bytes : 0), 0);
  }
  return {
    projects: projectIsNew ? 1 : 0,
    runs: DEMO_RUN_COUNT,
    metric_points: metricPoints,
    storage_bytes: artifactBytes + artifacts * ARTIFACT_METADATA_BYTES + DEMO_RUN_COUNT * RUN_METADATA_BYTES + (projectIsNew ? PROJECT_METADATA_BYTES : 0),
  };
}

function demoSeed(index) {
  return 7 + ((index * 37) % 100_000);
}

function demoWorkload(index) {
  return index % 10 < 6 ? "llm" : "rl";
}

function demoStatus(index) {
  if (index % 97 === 0) return "failed";
  if (index % 89 === 0) return "running";
  return "finished";
}

function demoHardware(index) {
  const gpuModels = ["NVIDIA A100 80GB", "NVIDIA H100 80GB", "NVIDIA L4 24GB", "RTX 4090 24GB"];
  const gpuCounts = [8, 4, 2, 1];
  const gpuMemory = [80, 80, 24, 24];
  const cpuModels = ["AMD EPYC 7B13", "Intel Xeon Platinum 8481C", "AMD EPYC 9654", "Apple M3 Max"];
  const cpuCores = [96, 64, 128, 16];
  const ramGb = [768, 512, 1024, 128];
  const clouds = ["gcp/us-central1", "aws/us-west-2", "lambda/us-south", "local/lab"];
  const choice = index % gpuModels.length;
  return {
    cpu_model: cpuModels[choice],
    cpu_cores: cpuCores[choice],
    ram_gb: ramGb[choice],
    gpu_model: gpuModels[choice],
    gpu_count: gpuCounts[choice],
    gpu_memory_gb: gpuMemory[choice],
    cloud: clouds[choice],
  };
}

function demoRunName(workload, index, seed) {
  if (workload === "llm") {
    const models = ["llama3-8b", "mistral-7b", "qwen2.5-7b", "t5-large", "bert-base"];
    const tasks = ["sft", "dpo", "summarization", "classification", "rag-eval"];
    return `llm-${models[index % models.length]}-${tasks[Math.floor(index / models.length) % tasks.length]}-seed-${seed}`;
  }
  const algos = ["ppo", "sac", "dqn", "td3"];
  const envs = ["cartpole", "hopper", "ant", "humanoid", "panda-reach", "minigrid"];
  return `rl-${algos[index % algos.length]}-${envs[Math.floor(index / algos.length) % envs.length]}-seed-${seed}`;
}

function demoConfig(workload, index, seed) {
  const hardware = demoHardware(index);
  if (workload === "llm") {
    const models = ["llama3-8b", "mistral-7b", "qwen2.5-7b", "t5-large", "bert-base"];
    const datasets = ["alpaca-clean", "open-orca", "math-mix", "customer-support", "code-help"];
    const tasks = ["sft", "dpo", "summarization", "classification", "rag-eval"];
    return {
      workload: "llm",
      framework: "transformers",
      trainer: index % 4 === 0 ? "deepspeed-zero3" : "hf-trainer",
      task: tasks[index % tasks.length],
      model: models[index % models.length],
      dataset: datasets[Math.floor(index / 3) % datasets.length],
      seed,
      learning_rate: index % 3 === 0 ? 0.00005 : 0.00002,
      batch_size: [16, 32, 64, 128][index % 4],
      gradient_accumulation_steps: [1, 2, 4, 8][Math.floor(index / 2) % 4],
      sequence_length: [1024, 2048, 4096, 8192][Math.floor(index / 5) % 4],
      precision: index % 5 === 0 ? "fp16" : "bf16",
      optimizer: index % 7 === 0 ? "adafactor" : "adamw",
      scheduler: index % 2 === 0 ? "cosine" : "linear",
      lora_rank: [0, 8, 16, 32][Math.floor(index / 7) % 4],
      hardware,
    };
  }
  const algos = ["ppo", "sac", "dqn", "td3"];
  const envs = ["CartPole-v1", "Hopper-v4", "Ant-v4", "Humanoid-v4", "PandaReach-v3", "MiniGrid-DoorKey-8x8"];
  return {
    workload: "rl",
    framework: "stable-baselines3",
    algo: algos[index % algos.length],
    env: envs[Math.floor(index / 4) % envs.length],
    seed,
    learning_rate: index % 2 === 0 ? 0.0003 : 0.0001,
    num_envs: [4, 8, 16, 32][index % 4],
    rollout_steps: [128, 256, 512, 1024][Math.floor(index / 3) % 4],
    batch_size: [64, 128, 256, 512][Math.floor(index / 5) % 4],
    gamma: index % 3 === 0 ? 0.995 : 0.99,
    gae_lambda: [0.9, 0.95, 0.97][index % 3],
    clip_range: [0.1, 0.2, 0.3][Math.floor(index / 2) % 3],
    entropy_coef: [0.0, 0.001, 0.01][Math.floor(index / 7) % 3],
    reward_shaping: index % 4 === 0,
    hardware,
  };
}

function demoTags(workload, index, seed) {
  const hardware = demoHardware(index);
  const gpuLabel = hardware.gpu_model.split(/\s+/)[1]?.toLowerCase() ?? "gpu";
  const tags = [
    "demo",
    index % 3 === 0 ? "baseline" : "candidate",
    index % 97 === 0 ? "needs-triage" : "healthy",
    `seed-${seed}`,
    `${hardware.gpu_count}x-${gpuLabel}`,
    hardware.cloud.replace("/", "-"),
  ];
  if (workload === "llm") tags.push("llm", index % 5 === 0 ? "long-context" : "fine-tune");
  else tags.push("rl", index % 4 === 0 ? "robotics" : "control");
  return tags;
}

function demoMetadata(workload, index, seed) {
  const hardware = demoHardware(index);
  const notes = workload === "llm"
    ? `Synthetic LLM run ${index}: compare loss, perplexity, throughput, gradient norm, eval quality, and hardware pressure.`
    : `Synthetic RL run ${index}: compare reward stability, KL/entropy, success rate, rollout speed, and hardware utilization.`;
  return {
    source: "demo-reset",
    host: `trainer-${String(index % 64).padStart(3, "0")}`,
    notes,
    owner: ["research", "platform", "infra", "evals"][index % 4],
    git: {
      branch: index % 2 === 0 ? "main" : "sweep/demo",
      commit: `demo${((index * 2654435761) >>> 0).toString(16).padStart(8, "0")}`,
    },
    hardware: { ...hardware, cuda: "12.4", driver: "550.54" },
    demo: { schema: "rich-llm-rl-v1", run_index: index, seed },
  };
}

function demoMetrics(workload, index, seed, step) {
  const metrics = {};
  const progress = Math.min(1, Math.max(0, step / 200));
  const wave = Math.sin(seed * 0.017 + step / 19);
  addSystemMetrics(metrics, index, progress, wave);
  if (workload === "llm") addLlmMetrics(metrics, index, seed, step, progress, wave);
  else addRlMetrics(metrics, index, seed, step, progress, wave);
  return metrics;
}

function addSystemMetrics(metrics, index, progress, wave) {
  const hardware = demoHardware(index);
  putMetric(metrics, "system/cpu_percent", 34 + 38 * progress + wave * 6 + (index % 9));
  putMetric(metrics, "system/cpu_threads", 12 + (index % 32));
  putMetric(metrics, "system/memory_percent", 42 + 24 * progress + (index % 7));
  putMetric(metrics, "system/process_memory_gb", Math.min(hardware.ram_gb * (0.18 + progress * 0.22), hardware.ram_gb * 0.85));
  putMetric(metrics, "system/disk_read_mb_s", 80 + 160 * (1 - progress) + Math.abs(wave) * 25);
  putMetric(metrics, "system/disk_write_mb_s", 20 + 90 * progress + (index % 11));
  putMetric(metrics, "system/network_rx_mb_s", 12 + 38 * progress + Math.abs(wave) * 6);
  putMetric(metrics, "system/network_tx_mb_s", 6 + 28 * progress + (index % 5));
  putMetric(metrics, "gpu/0/utilization_percent", clamp(55 + 38 * progress + wave * 8, 0, 100));
  putMetric(metrics, "gpu/0/memory_percent", clamp(48 + 36 * progress + (index % 13), 0, 99));
  putMetric(metrics, "gpu/0/memory_allocated_gb", hardware.gpu_memory_gb * (0.42 + 0.43 * progress));
  putMetric(metrics, "gpu/0/temperature_c", 54 + 18 * progress + wave * 3);
  putMetric(metrics, "gpu/0/power_watts", 140 + 65 * Math.sqrt(hardware.gpu_count) + 120 * progress);
  putMetric(metrics, "gpu/0/sm_clock_mhz", 1200 + 270 * progress);
  putMetric(metrics, "data/loader_wait_ms", Math.max(2, 42 - 24 * progress + Math.abs(wave) * 10));
}

function addLlmMetrics(metrics, index, seed, step, progress, wave) {
  const baseLoss = 2.8 - 1.7 * progress + (index % 7) * 0.025 + wave * 0.04;
  const evalLoss = baseLoss + 0.12 + Math.cos(seed * 0.013) * 0.03;
  const lrPeak = index % 3 === 0 ? 0.00005 : 0.00002;
  const lr = progress < 0.1 ? lrPeak * Math.max(progress / 0.1, 0.05) : lrPeak * Math.max(1 - (progress - 0.1) / 0.9, 0.03);
  putMetric(metrics, "train/loss", Math.max(baseLoss, 0.18));
  putMetric(metrics, "train/perplexity", Math.min(Math.exp(Math.max(baseLoss, 0.18)), 80));
  putMetric(metrics, "train/learning_rate", lr);
  putMetric(metrics, "train/grad_norm", 0.4 + (1 - progress) * 2.8 + Math.abs(wave) * 0.5);
  putMetric(metrics, "train/tokens_per_second", 18_000 + (index % 17) * 950 - progress * 2_200);
  putMetric(metrics, "train/samples_per_second", 120 + (index % 9) * 12 - progress * 18);
  putMetric(metrics, "train/steps_per_second", 1.8 + (index % 5) * 0.12 - progress * 0.3);
  putMetric(metrics, "train/tokens_seen", step * (48_000 + (index % 13) * 2_000));
  putMetric(metrics, "optimizer/weight_decay", index % 4 === 0 ? 0 : 0.01);
  putMetric(metrics, "optimizer/beta2", 0.95 + (index % 5) * 0.009);
  putMetric(metrics, "data/sequence_length", [1024, 2048, 4096, 8192][Math.floor(index / 5) % 4]);
  putMetric(metrics, "data/tokens_per_batch", [16_384, 32_768, 65_536, 131_072][index % 4]);
  putMetric(metrics, "eval/loss", Math.max(evalLoss, 0.2));
  putMetric(metrics, "eval/perplexity", Math.min(Math.exp(Math.max(evalLoss, 0.2)), 90));
  putMetric(metrics, "eval/accuracy", Math.min(0.96, 0.42 + progress * 0.42 + (index % 11) * 0.006));
  putMetric(metrics, "eval/f1", Math.min(0.97, 0.38 + progress * 0.47 + (index % 7) * 0.007));
  putMetric(metrics, "eval/rouge_l", clamp(0.22 + progress * 0.44 + wave * 0.015, 0, 0.92));
  putMetric(metrics, "eval/exact_match", Math.min(0.78, 0.12 + progress * 0.38 + (index % 5) * 0.01));
  putMetric(metrics, "generation/tokens_per_second", 650 + (index % 19) * 25 - progress * 40);
  putMetric(metrics, "generation/latency_ms", 220 - progress * 70 + Math.abs(wave) * 16);
  putMetric(metrics, "quality/win_rate", clamp(0.28 + progress * 0.48 + wave * 0.02, 0, 0.95));
}

function addRlMetrics(metrics, index, seed, step, progress, wave) {
  const reward = 25 + progress * (260 + (index % 23) * 4) + wave * 18;
  const success = Math.min(0.99, 0.08 + progress * 0.82 + (index % 13) * 0.006);
  putMetric(metrics, "rollout/ep_rew_mean", reward);
  putMetric(metrics, "rollout/ep_len_mean", 90 + progress * 360 + (index % 41));
  putMetric(metrics, "rollout/exploration_rate", Math.max(0.05, 1 - progress * 0.82));
  putMetric(metrics, "eval/mean_reward", reward * (1.02 + (seed % 5) * 0.004));
  putMetric(metrics, "eval/return_mean", reward * 1.06);
  putMetric(metrics, "eval/success_rate", success);
  putMetric(metrics, "eval/collision_rate", Math.max(0.01, 0.38 - progress * 0.31 + Math.abs(wave) * 0.02));
  putMetric(metrics, "train/approx_kl", Math.min(0.12, 0.004 + progress * 0.035 + Math.abs(wave) * 0.006));
  putMetric(metrics, "train/clip_fraction", Math.min(0.55, 0.02 + progress * 0.23 + Math.abs(wave) * 0.03));
  putMetric(metrics, "train/clip_range", [0.1, 0.2, 0.3][Math.floor(index / 2) % 3]);
  putMetric(metrics, "train/entropy_loss", -1.8 + progress * 1.2 - Math.abs(wave) * 0.08);
  putMetric(metrics, "train/explained_variance", clamp(0.15 + progress * 0.78 + wave * 0.03, -0.2, 0.99));
  putMetric(metrics, "train/learning_rate", index % 2 === 0 ? 0.0003 : 0.0001);
  putMetric(metrics, "train/loss", Math.max(0.08, 1.9 - progress * 1.35 + Math.abs(wave) * 0.08));
  putMetric(metrics, "train/policy_gradient_loss", -0.02 - progress * 0.025 + wave * 0.004);
  putMetric(metrics, "train/value_loss", Math.max(0.04, 1.4 - progress * 0.95 + Math.abs(wave) * 0.05));
  putMetric(metrics, "time/fps", 650 + (index % 37) * 24 - progress * 80);
  putMetric(metrics, "time/iterations", step / 20);
  putMetric(metrics, "time/total_timesteps", step * [512, 1024, 2048, 4096][index % 4]);
  putMetric(metrics, "reward/extrinsic", reward * 0.82);
  putMetric(metrics, "reward/intrinsic", Math.max(0, 20 * (1 - progress) + Math.abs(wave) * 4));
  putMetric(metrics, "agent/action_std", Math.max(0.05, 0.9 - progress * 0.55 + Math.abs(wave) * 0.04));
}

function demoArtifacts(workload, index, seed) {
  const artifacts = [
    {
      type: "checkpoint",
      name: `checkpoint-step-100-seed-${seed}.pt`,
      uri: `demo://checkpoints/checkpoint-step-100-seed-${seed}.pt`,
      step: 100,
      size_bytes: 24_000_000 + seed * 32,
      metadata: { step: 100, best: index % 3 === 0 },
    },
    {
      type: "checkpoint",
      name: `checkpoint-step-200-seed-${seed}.pt`,
      uri: `demo://checkpoints/checkpoint-step-200-seed-${seed}.pt`,
      step: 200,
      size_bytes: 48_000_000 + seed * 64,
      metadata: { step: 200, best: true },
    },
  ];
  if (workload === "llm") {
    artifacts.push(
      {
        type: "file",
        name: `eval-generations-seed-${seed}.jsonl`,
        uri: `demo://generations/eval-generations-seed-${seed}.jsonl`,
        step: 200,
        size_bytes: 256_000 + seed,
        mime_type: "application/jsonl",
        metadata: { kind: "generations", rows: 128 },
      },
      {
        type: "file",
        name: `sample-audio-seed-${seed}.mp3`,
        uri: `demo://audio/sample-audio-seed-${seed}.mp3`,
        step: 200,
        size_bytes: 1_200_000 + seed,
        mime_type: "audio/mpeg",
        metadata: { kind: "audio", duration_seconds: 18 + (index % 12), caption: "Synthetic eval sample for media compare UI" },
      },
    );
  } else {
    artifacts.push(
      {
        type: "rollout",
        name: `eval-rollout-seed-${seed}.mp4`,
        uri: `demo://rollouts/eval-rollout-seed-${seed}.mp4`,
        step: 200,
        size_bytes: 8_000_000 + seed * 12,
        mime_type: "video/mp4",
        metadata: { kind: "video", frames: 2400, fps: 30, return: 200 + seed },
      },
      {
        type: "file",
        name: `episode-trace-seed-${seed}.jsonl`,
        uri: `demo://traces/episode-trace-seed-${seed}.jsonl`,
        step: 200,
        size_bytes: 640_000 + seed,
        mime_type: "application/jsonl",
        metadata: { kind: "episode_trace", episodes: 32 },
      },
    );
  }
  artifacts.push({
    type: "file",
    name: `run-config-seed-${seed}.json`,
    uri: `demo://configs/run-config-seed-${seed}.json`,
    step: null,
    size_bytes: 4096 + seed,
    mime_type: "application/json",
    metadata: { kind: "config" },
  });
  return artifacts;
}

function putMetric(metrics, key, value) {
  metrics[key] = Number(value.toFixed(4));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createAttribute(state, runId, input) {
  return appendAttribute(state, validateAttributeInput(state, runId, input));
}

function validateAttributeInput(state, runId, input) {
  const run = ensureRun(state, runId);
  const type = validateAttributeType(input?.type);
  const step = input?.step === undefined || input?.step === null ? null : validateStep(input.step);
  const timestamp = input?.timestamp ? validateTimestamp(input.timestamp) : utcNow();
  const value = validateAttributeValue(type, input?.value);
  return {
    org_id: run.org_id,
    run_id: runId,
    path: validateName(input?.path, "attribute path"),
    type,
    step,
    timestamp,
    value,
    summary: validateObject(input?.summary ?? {}, "attribute summary"),
    artifact_id: input?.artifact_id === undefined || input?.artifact_id === null ? null : validateName(input.artifact_id, "artifact_id"),
  };
}

function appendAttribute(state, input) {
  const attribute = {
    id: state.nextAttributeId++,
    ...input,
    created_at: utcNow(),
  };
  state.attributes.push(attribute);
  return clone(attribute);
}

function validateArtifactInput(state, runId, input) {
  const run = ensureRun(state, runId);
  const type = input?.type;
  if (!ARTIFACT_TYPES.has(type)) throw new ValidationError("type must be one of: checkpoint, file, rollout");
  return {
    id: randomUUID(),
    org_id: run.org_id,
    run_id: runId,
    type,
    name: validateName(input?.name, "artifact name"),
    uri: validateName(input?.uri, "artifact uri"),
    step: input?.step === undefined || input?.step === null ? null : validateStep(input.step),
    size_bytes: input?.size_bytes === undefined || input?.size_bytes === null ? null : validateNonnegativeInteger(input.size_bytes, "size_bytes"),
    sha256: input?.sha256 === undefined || input?.sha256 === null ? null : validateName(input.sha256, "sha256"),
    mime_type: input?.mime_type === undefined || input?.mime_type === null ? null : validateName(input.mime_type, "mime_type"),
    storage_path: input?.storage_path === undefined || input?.storage_path === null ? null : validateName(input.storage_path, "storage_path"),
    metadata: validateObject(input?.metadata ?? {}, "metadata"),
    created_at: utcNow(),
  };
}

function latestMetricsForRun(state, runId) {
  const latest = {};
  for (const series of state.metricSeries.filter((candidate) => candidate.run_id === runId)) latest[series.key] = series.latest;
  return latest;
}

function metricAggregatesForRun(state, runId) {
  const aggregates = {};
  for (const series of state.metricSeries.filter((candidate) => candidate.run_id === runId)) {
    aggregates[series.key] = {
      latest: series.latest,
      min: series.min,
      max: series.max,
      mean: series.mean,
      variance: series.variance,
      count: series.count,
      best_step: series.best_step,
    };
  }
  return aggregates;
}

function artifactCountsForRun(state, runId) {
  const counts = { checkpoint: 0, rollout: 0, file: 0 };
  for (const artifact of state.artifacts) if (artifact.run_id === runId) counts[artifact.type] += 1;
  return counts;
}

function usageForOrganization(state, org, usagePeriod = currentUsagePeriod()) {
  const planTier = validatePlanTier(org.plan_tier ?? "free");
  const limits = clone(PLAN_TIERS[planTier]);
  const projects = state.projects.filter((project) => project.org_id === org.id);
  const runs = state.runs.filter((run) => run.org_id === org.id);
  const runIds = new Set(runs.map((run) => run.id));
  const metrics = state.metrics.filter((metric) => metric.org_id === org.id);
  const metricPointsCurrentPeriod = metrics.filter((metric) => isWithinUsagePeriod(metric.created_at, usagePeriod)).length;
  const metricSeries = state.metricSeries.filter((series) => series.org_id === org.id);
  const artifacts = state.artifacts.filter((artifact) => artifact.org_id === org.id);
  const attributes = state.attributes.filter((attribute) => attribute.org_id === org.id);
  const imports = state.imports.filter((record) => record.org_id === org.id);
  const apiKeys = state.apiKeys.filter((key) => key.org_id === org.id && !key.revoked_at);
  const memberships = state.memberships.filter((membership) => membership.org_id === org.id);
  const seats = org.id === DEFAULT_ORG_ID ? Math.max(1, memberships.length) : memberships.length;
  const artifactBytesExact = artifacts.reduce((sum, artifact) => sum + (Number.isInteger(artifact.size_bytes) ? artifact.size_bytes : 0), 0);
  const artifactBytesUnknownCount = artifacts.filter((artifact) => !Number.isInteger(artifact.size_bytes)).length;
  const estimatedMetadataBytes = estimateJsonBytes({
    organization: org,
    projects,
    runs,
    metrics,
    metric_series: metricSeries,
    artifacts: artifacts.map(({ storage_path, ...artifact }) => artifact),
    attributes,
    imports,
    api_keys: apiKeys.map(publicApiKey),
  });
  const usage = {
    seats,
    paid_extra_seats: Math.max(0, seats - limits.included_seats),
    projects: projects.length,
    runs: runs.length,
    metric_points: metricPointsCurrentPeriod,
    metric_points_current_period: metricPointsCurrentPeriod,
    metric_points_retained_total: metrics.length,
    metric_series: metricSeries.filter((series) => runIds.has(series.run_id)).length,
    artifacts: artifacts.length,
    api_keys: apiKeys.length,
    artifact_bytes_exact: artifactBytesExact,
    artifact_bytes_unknown_count: artifactBytesUnknownCount,
    estimated_metadata_bytes: estimatedMetadataBytes,
    estimated_storage_bytes_for_warnings: artifactBytesExact + estimatedMetadataBytes,
    billable_storage_bytes: null,
    billing_precision: "not_billable",
  };
  return {
    org_id: org.id,
    org_slug: org.slug,
    org_name: org.name,
    plan_tier: planTier,
    tier_source: "organization",
    authoritative_for_plan: true,
    usage_period: usagePeriod,
    usage,
    limits,
    warnings: usageWarnings(usage, limits),
  };
}

function usageWarnings(usage, limits) {
  return [
    usageLimitWarning("seats", usage.seats, limits.included_seats, USAGE_OVERAGE_POLICY.seats),
    usageLimitWarning("projects", usage.projects, limits.projects, USAGE_OVERAGE_POLICY.projects),
    usageLimitWarning("runs", usage.runs, limits.runs, USAGE_OVERAGE_POLICY.runs),
    usageLimitWarning("metric_points", usage.metric_points, limits.metric_points, USAGE_OVERAGE_POLICY.metric_points),
    usageLimitWarning("storage", usage.estimated_storage_bytes_for_warnings, limits.included_storage_bytes, USAGE_OVERAGE_POLICY.storage),
  ].filter(Boolean);
}

function currentUsagePeriod(now = new Date()) {
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const endsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return {
    kind: "calendar_month",
    timezone: "UTC",
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    reset_at: endsAt.toISOString(),
  };
}

function isWithinUsagePeriod(value, period) {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis >= Date.parse(period.starts_at) && millis < Date.parse(period.ends_at);
}

function usageLimitWarning(target, value, limit, policy) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const ratio = value / limit;
  const blocking = policy === "blocked_at_limit";
  if (target === "seats") {
    if (value <= limit) return null;
    return usageWarningRow(target, "paid_extra_seats", value, limit, ratio, policy, blocking);
  }
  if (ratio >= 1) return usageWarningRow(target, "over_limit", value, limit, ratio, policy, blocking);
  if (ratio >= 0.8) return usageWarningRow(target, "approaching_limit", value, limit, ratio, policy, blocking);
  return null;
}

function usageWarningRow(target, status, value, limit, ratio, policy, blocking) {
  return {
    target,
    status,
    value,
    limit,
    ratio: Number(ratio.toFixed(4)),
    policy,
    blocking,
    code: `${target}_${status}`,
    message: usageWarningMessage(target, status, blocking),
  };
}

function usageWarningMessage(target, status, blocking) {
  const label = target.replaceAll("_", " ");
  if (status === "approaching_limit" && blocking) return `${label} usage is approaching the plan limit. New writes will be blocked at the limit.`;
  if (status === "over_limit" && blocking) return `${label} usage is at or above the plan limit. New writes are blocked until usage drops or the plan is upgraded.`;
  if (status === "paid_extra_seats") return "Seat count is above the included plan seats and is tracked for future billing.";
  return `${label} usage is above the plan limit.`;
}

function assertPlanCapacity(state, orgId, delta = {}, action = "write data") {
  const org = getOrganization(state, orgId);
  const snapshot = usageForOrganization(state, org);
  const checks = [
    ["projects", snapshot.usage.projects, delta.projects ?? 0, snapshot.limits.projects],
    ["runs", snapshot.usage.runs, delta.runs ?? 0, snapshot.limits.runs],
    ["metric_points", snapshot.usage.metric_points, delta.metric_points ?? 0, snapshot.limits.metric_points],
    ["storage", snapshot.usage.estimated_storage_bytes_for_warnings, delta.storage_bytes ?? 0, snapshot.limits.included_storage_bytes],
  ];
  for (const [target, current, change, limit] of checks) {
    if (!Number.isFinite(limit) || limit <= 0) continue;
    if (current > limit) throw planLimitError(target, "is already above", snapshot.limits.label, action);
    if (change > 0 && current + change > limit) throw planLimitError(target, "would exceed", snapshot.limits.label, action);
  }
}

function planLimitError(target, reason, planLabel, action) {
  return new PlanLimitError(`plan limit exceeded: ${target} ${reason} the ${planLabel} limit while trying to ${action}`);
}

function estimateJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sideBySideValuesForRun(state, runId) {
  const run = state.runs.find((candidate) => candidate.id === runId);
  const values = {};
  for (const [key, value] of Object.entries(run?.config ?? {})) values[`config/${key}`] = value;
  for (const [key, value] of Object.entries(run?.metadata ?? {})) values[`metadata/${key}`] = value;
  for (const tag of run?.tags ?? []) values[`tag/${tag}`] = true;
  for (const [key, value] of Object.entries(latestMetricsForRun(state, runId))) values[`metric/${key}/latest`] = value;
  for (const [key, aggregate] of Object.entries(metricAggregatesForRun(state, runId))) {
    values[`metric/${key}/max`] = aggregate.max;
    values[`metric/${key}/mean`] = Number(aggregate.mean.toFixed(6));
  }
  for (const attribute of state.attributes.filter((candidate) => candidate.run_id === runId)) values[`attribute/${attribute.path}`] = attribute.value;
  return values;
}

function filterRuns(state, input) {
  if (input.status && !RUN_STATUSES.has(input.status)) {
    throw new ValidationError("status must be one of: failed, finished, running");
  }
  const orgId = input.org_id ? resolveOrgId(state, input.org_id) : null;
  return state.runs
    .filter((run) => (orgId ? run.org_id === orgId : true))
    .filter((run) => (input.project_id ? run.project_id === input.project_id : true))
    .filter((run) => (input.project ? run.project === input.project : true))
    .filter((run) => (input.status ? run.status === input.status : true))
    .filter((run) => {
      if (!input.q) return true;
      const haystack = `${run.name} ${run.project} ${JSON.stringify(run.tags)} ${JSON.stringify(run.config)} ${JSON.stringify(run.metadata)}`.toLowerCase();
      const queryParts = String(input.q).toLowerCase().split(/\s+/).filter(Boolean);
      return queryParts.every((part) => haystack.includes(part));
    });
}

function sortRunRecords(state, runs, sortBy, metricKey) {
  const copy = [...runs];
  if (sortBy === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (sortBy === "status") return copy.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));
  if (sortBy === "metric-latest") return copy.sort((a, b) => numericDesc(metricAggregatesForRun(state, a.id)[metricKey]?.latest, metricAggregatesForRun(state, b.id)[metricKey]?.latest));
  if (sortBy === "metric-best") return copy.sort((a, b) => numericDesc(metricAggregatesForRun(state, a.id)[metricKey]?.max, metricAggregatesForRun(state, b.id)[metricKey]?.max));
  if (sortBy === "duration") return copy.sort((a, b) => numericDesc(durationSeconds(a), durationSeconds(b)));
  return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function validateRunSort(value) {
  const sortBy = value === undefined || value === null || value === "" ? "created" : String(value);
  if (!new Set(["created", "metric-latest", "metric-best", "name", "status", "duration"]).has(sortBy)) {
    throw new ValidationError("sort_by must be one of: created, duration, metric-best, metric-latest, name, status");
  }
  return sortBy;
}

function numericDesc(left, right) {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return rightValue - leftValue;
}

function durationSeconds(run) {
  if (!run?.started_at || !run?.finished_at) return null;
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

function ensureRun(state, runId) {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new NotFoundError("run not found");
  return run;
}

function authorizeOrg(orgId, auth) {
  if (auth && auth.org_id !== orgId) throw new ForbiddenError("run belongs to a different organization");
}

function getUserRecord(state, userId) {
  const user = state.users.find((candidate) => candidate.id === userId);
  if (!user) throw new NotFoundError("user not found");
  return clone(user);
}

function getOrganization(state, orgId) {
  const id = resolveOrgId(state, orgId);
  const organization = state.organizations.find((candidate) => candidate.id === id);
  if (!organization) throw new NotFoundError("organization not found");
  return organization;
}

function resolveOrgId(state, rawOrgId) {
  ensureDefaultOrg(state);
  if (rawOrgId === undefined || rawOrgId === null || rawOrgId === "") return DEFAULT_ORG_ID;
  const orgId = validateName(rawOrgId, "org_id");
  if (!state.organizations.some((organization) => organization.id === orgId)) throw new NotFoundError("organization not found");
  return orgId;
}

function defaultOrganization() {
  return {
    id: DEFAULT_ORG_ID,
    slug: DEFAULT_ORG_SLUG,
    name: "Local",
    plan_tier: "premium",
    account_type: "customer",
    seat_limit: PLAN_TIERS.premium.included_seats,
    created_by_user_id: null,
    created_at: "1970-01-01T00:00:00.000Z",
  };
}

function ensureDefaultOrg(state) {
  if (!state.organizations.some((organization) => organization.id === DEFAULT_ORG_ID)) {
    state.organizations.unshift(defaultOrganization());
  }
}

function normalizeState(state) {
  ensureDefaultOrg(state);
  for (const organization of state.organizations) {
    organization.plan_tier = validatePlanTier(organization.plan_tier ?? "free");
    organization.account_type = organization.account_type ?? "customer";
    organization.seat_limit = organization.seat_limit ?? PLAN_TIERS[organization.plan_tier].included_seats;
    if (organization.id === DEFAULT_ORG_ID) {
      organization.plan_tier = "premium";
      organization.seat_limit = PLAN_TIERS.premium.included_seats;
    }
  }
  for (const membership of state.memberships) membership.status = membership.status ?? "active";
  for (const project of state.projects) project.org_id = project.org_id ?? DEFAULT_ORG_ID;
  for (const run of state.runs) run.org_id = run.org_id ?? state.projects.find((project) => project.id === run.project_id)?.org_id ?? DEFAULT_ORG_ID;
  for (const metric of state.metrics) metric.org_id = metric.org_id ?? state.runs.find((run) => run.id === metric.run_id)?.org_id ?? DEFAULT_ORG_ID;
  for (const series of state.metricSeries ?? []) series.org_id = series.org_id ?? state.runs.find((run) => run.id === series.run_id)?.org_id ?? DEFAULT_ORG_ID;
  for (const artifact of state.artifacts) artifact.org_id = artifact.org_id ?? state.runs.find((run) => run.id === artifact.run_id)?.org_id ?? DEFAULT_ORG_ID;
  for (const attribute of state.attributes) attribute.org_id = attribute.org_id ?? state.runs.find((run) => run.id === attribute.run_id)?.org_id ?? DEFAULT_ORG_ID;
  for (const record of state.imports) record.org_id = record.org_id ?? DEFAULT_ORG_ID;
  if (!Array.isArray(state.metricSeries) || (state.metricSeries.length === 0 && state.metrics.length > 0)) state.metricSeries = rebuildMetricSeries(state.metrics);
  return state;
}

function rebuildMetricSeries(metrics) {
  const state = { metricSeries: [] };
  for (const metric of [...metrics].sort((a, b) => a.id - b.id)) updateMetricSeries(state, metric);
  return state.metricSeries;
}

function metricSeriesKey(runId, key) {
  return `${runId}\u0000${key}`;
}

function metricSeriesIndex(state) {
  if (!state[METRIC_SERIES_INDEX]) {
    Object.defineProperty(state, METRIC_SERIES_INDEX, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: new Map(state.metricSeries.map((series) => [metricSeriesKey(series.run_id, series.key), series])),
    });
  }
  return state[METRIC_SERIES_INDEX];
}

function invalidateMetricSeriesIndex(state) {
  if (state[METRIC_SERIES_INDEX]) state[METRIC_SERIES_INDEX] = null;
}

function updateMetricSeries(state, metric) {
  const index = metricSeriesIndex(state);
  const key = metricSeriesKey(metric.run_id, metric.key);
  let series = index.get(key);
  if (!series) {
    series = {
      org_id: metric.org_id,
      run_id: metric.run_id,
      key: metric.key,
      count: 0,
      sum: 0,
      sum_sq: 0,
      min: metric.value,
      max: metric.value,
      mean: 0,
      variance: 0,
      latest: metric.value,
      latest_step: metric.step,
      latest_metric_id: metric.id,
      best: metric.value,
      best_step: metric.step,
      updated_at: metric.created_at,
    };
    state.metricSeries.push(series);
    index.set(key, series);
  }
  series.count += 1;
  series.sum += metric.value;
  series.sum_sq += metric.value * metric.value;
  series.min = Math.min(series.min, metric.value);
  if (metric.value > series.max || (metric.value === series.max && metric.step > series.best_step)) {
    series.max = metric.value;
    series.best = metric.value;
    series.best_step = metric.step;
  }
  if (metric.step > series.latest_step || (metric.step === series.latest_step && metric.id > series.latest_metric_id)) {
    series.latest = metric.value;
    series.latest_step = metric.step;
    series.latest_metric_id = metric.id;
  }
  series.mean = series.sum / series.count;
  series.variance = Math.max(0, series.sum_sq / series.count - series.mean ** 2);
  series.updated_at = metric.created_at;
}

function listProjectsForExport(state, input) {
  const orgId = input.org_id ? resolveOrgId(state, input.org_id) : null;
  return state.projects.filter((project) => {
    if (orgId && project.org_id !== orgId) return false;
    if (input.project_id && project.id !== input.project_id) return false;
    if (input.project && project.name !== input.project) return false;
    return true;
  });
}

function validateName(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be a non-empty string`);
  return value.trim();
}

function validateEmail(value) {
  const email = validateName(value, "email").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("email must be a valid email address");
  return email;
}

function validateSlug(value, field) {
  const slug = validateName(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new ValidationError(`${field} must use lowercase letters, numbers, and hyphens`);
  return slug;
}

function validatePlanTier(value) {
  const rawPlanTier = validateName(value, "plan_tier").toLowerCase();
  const planTier = LEGACY_PLAN_ALIASES[rawPlanTier] ?? rawPlanTier;
  if (!Object.hasOwn(PLAN_TIERS, planTier)) throw new ValidationError("plan_tier must be one of: free, pro, premium");
  return planTier;
}

function validateScopes(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError("scopes must be a non-empty list");
  return value.map((scope) => validateName(scope, "scope"));
}

function validateObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
  stableJson(value);
  return clone(value);
}

function validateTags(value) {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
    throw new ValidationError("tags must be a list of non-empty strings");
  }
  return value.map((tag) => tag.trim());
}

function validateNotePatch(value) {
  if (typeof value !== "string") throw new ValidationError("notes must be a string");
  const text = value.trim();
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new ValidationError(`notes must be at most ${MAX_TEXT_BYTES} bytes`);
  return text;
}

function validateStep(value, field = "step") {
  const number = validateJsonNumber(value, field);
  if (number < 0) throw new ValidationError(`${field} must be a nonnegative number`);
  return number;
}

function optionalStep(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const number = validateQueryNumber(value, field);
  if (number < 0) throw new ValidationError(`${field} must be a nonnegative number`);
  return number;
}

function validateNonnegativeInteger(value, field) {
  const number = validateJsonNumber(value, field);
  if (!Number.isInteger(number) || number < 0) throw new ValidationError(`${field} must be a nonnegative integer`);
  return number;
}

function validateAttributeType(value) {
  if (!ATTRIBUTE_TYPES.has(value)) throw new ValidationError("type must be one of: config, file, file_series, float_series, histogram_series, string_series, tag");
  return value;
}

function validateAttributeValue(type, value) {
  if (value === undefined) throw new ValidationError("attribute value is required");
  if (type === "float_series") {
    return validateJsonNumber(value, "float_series value");
  }
  if (type === "tag" && typeof value !== "string") throw new ValidationError("tag value must be a string");
  stableJson(value);
  return clone(value);
}

function validateTimestamp(value) {
  const text = validateName(value, "timestamp");
  if (Number.isNaN(Date.parse(text))) throw new ValidationError("timestamp must be an ISO-compatible datetime");
  return new Date(text).toISOString();
}

function validateDateRange(date, field) {
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be within supported datetime range`);
  return date.toISOString();
}

function validatePreviewCompletion(value) {
  const number = validateJsonNumber(value, "preview_completion");
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new ValidationError("preview_completion must be between 0 and 1");
  return number;
}

function validateLimit(value, fallback, max) {
  const limit = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new ValidationError(`limit must be between 1 and ${max}`);
  return limit;
}

function validateOffset(value) {
  const offset = value === undefined || value === null || value === "" ? 0 : Number(value);
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError("offset must be a nonnegative integer");
  return offset;
}

function validateJsonNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${field} must be finite numbers`);
  return value;
}

function validateQueryNumber(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} must be a finite number`);
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  throw new ValidationError(`${field} must be a finite number`);
}

function validateMetrics(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new ValidationError("metrics must be a non-empty object");
  }
  const metrics = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanKey = validateName(key, "metric key");
    metrics[cleanKey] = validateMetricValue(raw);
  }
  return metrics;
}

function optionalList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list`);
  return value;
}

function parseRunIds(value) {
  const runIds = Array.isArray(value) ? value : String(value ?? "").split(",");
  const clean = runIds.map((id) => String(id).trim()).filter(Boolean);
  if (clean.length === 0) throw new ValidationError("run_ids must include at least one run");
  return clean.map((id) => validateName(id, "run id"));
}

function summarizeCanonicalImport(project, runs) {
  let metrics = 0;
  let attributes = 0;
  let artifacts = 0;
  for (const run of runs) {
    metrics += Array.isArray(run.metrics) ? run.metrics.length : 0;
    attributes += Array.isArray(run.attributes) ? run.attributes.length : 0;
    artifacts += Array.isArray(run.artifacts) ? run.artifacts.length : 0;
  }
  return { project, runs: runs.length, metrics, attributes, artifacts };
}

function publicApiKey(key) {
  const { key_hash, ...visible } = key;
  return clone(visible);
}

function publicPlanTiers() {
  return Object.fromEntries(Object.entries(PLAN_TIERS).map(([id, tier]) => [id, clone(tier)]));
}

function hashSecret(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function hashCanonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function audit(state, orgId, action, metadata = {}) {
  state.auditEvents.push({
    id: state.nextAuditEventId++,
    org_id: orgId,
    actor_type: "system",
    action,
    metadata,
    created_at: utcNow(),
  });
}

function stableJson(value) {
  try {
    return canonicalJson(value);
  } catch {
    throw new ValidationError("value must be JSON serializable");
  }
}

function write(persist, fn) {
  const result = fn();
  persist();
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
