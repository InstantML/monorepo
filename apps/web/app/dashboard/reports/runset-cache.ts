"use client";

/**
 * Shared runset resolution cache for report panel renderers (perf audit B7).
 *
 * Every panel in a report grid used to independently re-resolve its runset —
 * one `/runs?project=…` GET per project per panel, plus per-pinned-run
 * lookups, all awaited sequentially. Reports commonly stack many panels on
 * the same runset, so identical requests multiplied by panel count.
 *
 * This module gives all renderers (panel charts, run-set table, parallel
 * coordinates, run comparer) one short-TTL promise cache:
 *
 * - keyed by a stable stringify of the runset fetch spec plus the resolution
 *   options, so panels with identical specs join the same in-flight promise;
 * - module-scoped, so simultaneous mounts dedupe even across blocks;
 * - per-project (and per-pinned-run) fetches run in parallel via Promise.all;
 * - a rejected cached promise is evicted immediately, so the panels that
 *   awaited it fail individually while the next panel to ask retries fresh.
 *
 * Callers pass an AbortSignal that detaches *their* wait (rejecting with an
 * AbortError) without cancelling the shared fetch other panels may still be
 * consuming.
 */

type ApiLike = {
  get(path: string, options?: { signal?: AbortSignal }): Promise<unknown>;
};

export type RunsetFetchSpec = {
  projects: string[];
  pinned_run_ids?: string[] | null;
  limit?: number | null;
};

/** A raw run payload plus the project used as its normalization fallback. */
export type RawRunsetRun = { raw: Record<string, unknown>; project: string };

export type RunsetResolveOptions = {
  /** Per-project listing page size (already clamped by the caller). */
  perProjectLimit: number;
  /** Total cap across projects + pinned runs; Infinity leaves it uncapped. */
  maxRuns: number;
  /** Listing page size used when resolving "project/name" pinned shorthands. */
  pinnedLookupLimit: number;
  /** Whether pinned_run_ids participate in resolution. */
  includePinned: boolean;
};

const RUNSET_CACHE_TTL_MS = 30_000;

type CacheEntry<T> = { promise: Promise<T>; expiresAt: number };

const runsetCache = new Map<string, CacheEntry<RawRunsetRun[]>>();
const runByIdCache = new Map<string, CacheEntry<unknown>>();

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

/**
 * Reject when the caller's signal aborts, but leave the underlying shared
 * promise running for the other panels that reference it.
 */
function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  const promise = create();
  cache.set(key, { promise, expiresAt: now + RUNSET_CACHE_TTL_MS });
  // Failed resolutions must not be served to later panels — evict so the next
  // panel retries; the panels already awaiting this promise still see the
  // rejection and fail on their own.
  promise.catch(() => {
    const current = cache.get(key);
    if (current?.promise === promise) cache.delete(key);
  });
  return promise;
}

function runsetCacheKey(spec: RunsetFetchSpec, options: RunsetResolveOptions): string {
  return JSON.stringify({
    projects: spec.projects ?? [],
    pinned: options.includePinned ? spec.pinned_run_ids ?? [] : [],
    limit: spec.limit ?? null,
    perProjectLimit: options.perProjectLimit,
    maxRuns: Number.isFinite(options.maxRuns) ? options.maxRuns : null,
    pinnedLookupLimit: options.pinnedLookupLimit,
    includePinned: options.includePinned,
  });
}

async function listProjectRuns(api: ApiLike, project: string, limit: number): Promise<unknown[]> {
  const params = new URLSearchParams({ project, limit: String(limit) });
  const payload = (await api.get(`/runs?${params.toString()}`)) as { runs?: unknown } | null;
  return Array.isArray(payload?.runs) ? payload.runs : [];
}

/**
 * Cached single-run GET, shared with the run comparer so repeated panels that
 * reference the same run ids reuse one request per TTL window.
 */
export function fetchRunByIdCached(api: ApiLike, id: string, signal?: AbortSignal): Promise<unknown> {
  const trimmed = id.trim();
  const promise = remember(runByIdCache, trimmed, () => api.get(`/runs/${encodeURIComponent(trimmed)}`));
  return raceWithSignal(promise, signal);
}

async function resolvePinnedRun(
  api: ApiLike,
  ref: string,
  pinnedLookupLimit: number,
): Promise<RawRunsetRun | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  // Accept "project/name" shorthand by listing the project and looking up the
  // matching run name.
  if (trimmed.includes("/")) {
    const [project, ...rest] = trimmed.split("/");
    const name = rest.join("/");
    try {
      const runs = await listProjectRuns(api, project, pinnedLookupLimit);
      const match = runs.find(
        (run) => !!run && typeof run === "object" && (run as { name?: unknown }).name === name,
      );
      return match ? { raw: match as Record<string, unknown>, project } : null;
    } catch {
      return null;
    }
  }
  try {
    const payload = (await fetchRunByIdCached(api, trimmed)) as { run?: unknown } | null;
    const run = payload?.run ?? payload;
    if (!run || typeof run !== "object") return null;
    const raw = run as Record<string, unknown>;
    return { raw, project: typeof raw.project === "string" ? raw.project : "" };
  } catch {
    return null;
  }
}

/**
 * Resolve a runset spec to its raw run payloads (deduplicated by run id, in
 * project order, capped at `maxRuns`). Callers normalize the raw payloads
 * into their own row shapes.
 */
export function resolveRunsetRuns(
  api: ApiLike,
  spec: RunsetFetchSpec,
  options: RunsetResolveOptions,
  signal?: AbortSignal,
): Promise<RawRunsetRun[]> {
  const key = runsetCacheKey(spec, options);
  const promise = remember(runsetCache, key, async () => {
    const collected = new Map<string, RawRunsetRun>();
    const projectLists = await Promise.all(
      (spec.projects ?? []).map(async (project) => ({
        project,
        runs: await listProjectRuns(api, project, options.perProjectLimit),
      })),
    );
    for (const { project, runs } of projectLists) {
      if (collected.size >= options.maxRuns) break;
      for (const raw of runs) {
        if (collected.size >= options.maxRuns) break;
        if (!raw || typeof raw !== "object") continue;
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== "string" || !id || collected.has(id)) continue;
        collected.set(id, { raw: raw as Record<string, unknown>, project });
      }
    }
    if (options.includePinned && collected.size < options.maxRuns) {
      const pinned = await Promise.all(
        (spec.pinned_run_ids ?? []).map((ref) => resolvePinnedRun(api, ref, options.pinnedLookupLimit)),
      );
      for (const entry of pinned) {
        if (collected.size >= options.maxRuns) break;
        if (!entry) continue;
        const id = (entry.raw as { id?: unknown }).id;
        if (typeof id !== "string" || !id || collected.has(id)) continue;
        collected.set(id, entry);
      }
    }
    return Array.from(collected.values());
  });
  return raceWithSignal(promise, signal);
}

/** Test hook: clear the module caches (not used by production code). */
export function clearRunsetCachesForTests() {
  runsetCache.clear();
  runByIdCache.clear();
}
