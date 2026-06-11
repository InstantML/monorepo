"use client";

import { Archive, Box, CheckCircle2, Copy, Download, GitBranch, ListPlus, Package, Search, ShieldCheck, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, queryString, retryTransientRequest } from "../../../src/api.js";
import { ArtifactBrowser } from "./artifact-browser";
import { MetricCard } from "../ui/metric-card";
import { RichObjectPanel } from "../detail/rich-object-panel";
import { PageHead } from "../ui/page-head";
import { formatBytes } from "../../dashboard-models";
import { formatNumber } from "../../../src/state.js";
import type {
  Artifact,
  ArtifactCollection,
  ArtifactLineageGraph,
  ArtifactManifestEntry,
  ArtifactVersion,
  ArtifactCollectionsEnvelope,
  ArtifactManifestEnvelope,
  ArtifactVersionEnvelope,
  ArtifactVersionsEnvelope,
  LoggedObject,
  LoggedObjectRow,
  RunSummary,
} from "../../dashboard-types";

type ArtifactTotals = { file: number; checkpoint: number; rollout: number };

type Props = {
  api: {
    get: <T = unknown>(path: string, options?: { signal?: AbortSignal }) => Promise<T>;
    put: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>;
    patch: <T = unknown>(path: string, body: Record<string, unknown>) => Promise<T>;
    delete: <T = unknown>(path: string, body?: Record<string, unknown>) => Promise<T>;
  };
  artifactTotals: ArtifactTotals;
  canManageArtifacts: boolean;
  loggedObjects: LoggedObject[];
  objectRowsById: Record<number, LoggedObjectRow[]>;
  primaryRun: RunSummary | null;
  project: string;
  visibleArtifacts: Artifact[];
};

const artifactTypeOptions = ["", "model", "dataset", "checkpoint", "table", "media", "file"];
const COLLECTION_PAGE_LIMIT = 100;
const VERSION_PAGE_LIMIT = 100;
const MANIFEST_PAGE_LIMIT = 100;

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Visible IDs/snippets remain selectable when clipboard permission is denied.
  }
}

function selectedVersionForCollection(collection: ArtifactCollection | null, versions: ArtifactVersion[], selectedVersionId: string) {
  const collectionVersions = collection ? versions.filter((version) => version.collection_id === collection.id) : versions;
  if (selectedVersionId) {
    const selected = collectionVersions.find((version) => version.id === selectedVersionId);
    if (selected) return selected;
  }
  const best = collection?.best_version ? collectionVersions.find((version) => version.id === collection.best_version?.id) : null;
  const latest = collection?.latest_version ? collectionVersions.find((version) => version.id === collection.latest_version?.id) : null;
  return best ?? latest ?? collectionVersions[0] ?? null;
}

function artifactUrlState() {
  if (typeof window === "undefined") return { collection: "", version: "" };
  const params = new URLSearchParams(window.location.search);
  return { collection: params.get("collection") ?? "", version: params.get("version") ?? "" };
}

function replaceArtifactUrl(collectionId: string, versionId: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (collectionId) url.searchParams.set("collection", collectionId);
  else url.searchParams.delete("collection");
  if (versionId) url.searchParams.set("version", versionId);
  else url.searchParams.delete("version");
  window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
}

export function ArtifactsTabPane({
  api,
  artifactTotals,
  canManageArtifacts,
  loggedObjects,
  objectRowsById,
  primaryRun,
  project,
  visibleArtifacts,
}: Props) {
  const [collections, setCollections] = useState<ArtifactCollection[]>([]);
  const [collectionTotal, setCollectionTotal] = useState(0);
  const [collectionHasMore, setCollectionHasMore] = useState(false);
  const [collectionLoadingMore, setCollectionLoadingMore] = useState(false);
  const [collectionQuery, setCollectionQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [versionTotal, setVersionTotal] = useState(0);
  const [versionHasMore, setVersionHasMore] = useState(false);
  const [versionLoadingMore, setVersionLoadingMore] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [manifestEntries, setManifestEntries] = useState<ArtifactManifestEntry[]>([]);
  const [manifestTotal, setManifestTotal] = useState(0);
  const [manifestHasMore, setManifestHasMore] = useState(false);
  const [manifestLoadingMore, setManifestLoadingMore] = useState(false);
  const [lineage, setLineage] = useState<ArtifactLineageGraph>({ nodes: [], edges: [] });
  const [versionedUnsupported, setVersionedUnsupported] = useState(false);
  const [legacyArtifacts, setLegacyArtifacts] = useState<Artifact[]>([]);
  const [legacyLoading, setLegacyLoading] = useState("");
  const [loading, setLoading] = useState("Loading artifact collections...");
  const [error, setError] = useState("");
  const [mutationBusy, setMutationBusy] = useState("");
  const selectedVersionIdRef = useRef("");

  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0] ?? null,
    [collections, selectedCollectionId],
  );
  const selectedVersion = useMemo(
    () => selectedVersionForCollection(selectedCollection, versions, selectedVersionId),
    [selectedCollection, selectedVersionId, versions],
  );
  const manifestCountLabel = manifestTotal > manifestEntries.length ? `${manifestEntries.length}/${manifestTotal}` : `${manifestEntries.length}`;

  useEffect(() => {
    selectedVersionIdRef.current = selectedVersion?.id ?? "";
  }, [selectedVersion?.id]);

  useEffect(() => {
    if (!selectedCollection?.id && !selectedVersion?.id) return;
    replaceArtifactUrl(selectedCollection?.id ?? "", selectedVersion?.id ?? "");
  }, [selectedCollection?.id, selectedVersion?.id]);

  useEffect(() => {
    function syncFromUrl() {
      const state = artifactUrlState();
      setSelectedCollectionId(state.collection);
      setSelectedVersionId(state.version);
    }
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function loadCollections() {
      setLoading("Loading artifact collections...");
      setError("");
      setVersionedUnsupported(false);
      try {
        const payload = await retryTransientRequest(
          () => api.get<ArtifactCollectionsEnvelope>(`/api/artifact-collections${queryString({ project, q: collectionQuery, type: typeFilter, limit: COLLECTION_PAGE_LIMIT, offset: 0 })}`, { signal: controller.signal }),
          { signal: controller.signal },
        );
        if (cancelled) return;
        const rows = (payload.collections ?? []) as ArtifactCollection[];
        setCollections(rows);
        setCollectionTotal(Number(payload.total ?? rows.length));
        setCollectionHasMore(Boolean(payload.has_more));
        const urlCollection = artifactUrlState().collection;
        setSelectedCollectionId((current) => {
          if (urlCollection && rows.some((row) => row.id === urlCollection)) return urlCollection;
          return rows.some((row) => row.id === current) ? current : rows[0]?.id ?? "";
        });
      } catch (loadError) {
        if (!cancelled && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          if (loadError instanceof ApiError && loadError.status === 404) {
            setVersionedUnsupported(true);
          } else {
            setError(loadError instanceof Error ? loadError.message : "Unable to load artifact collections.");
          }
          setCollections([]);
          setCollectionTotal(0);
          setCollectionHasMore(false);
        }
      } finally {
        if (!cancelled) setLoading("");
      }
    }
    loadCollections();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, collectionQuery, project, typeFilter]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function loadVersions() {
      if (!selectedCollection?.id) {
        setVersions([]);
        setVersionTotal(0);
        setVersionHasMore(false);
        setVersionLoadingMore(false);
        setSelectedVersionId("");
        setManifestEntries([]);
        setManifestTotal(0);
        setManifestHasMore(false);
        setManifestLoadingMore(false);
        setLineage({ nodes: [], edges: [] });
        return;
      }
      setError("");
      setVersions([]);
      setVersionTotal(0);
      setVersionHasMore(false);
      setVersionLoadingMore(false);
      setSelectedVersionId("");
      setManifestEntries([]);
      setManifestTotal(0);
      setManifestHasMore(false);
      setManifestLoadingMore(false);
      setLineage({ nodes: [], edges: [] });
      try {
        const payload = await retryTransientRequest(
          () => api.get<ArtifactVersionsEnvelope>(`/api/artifact-collections/${encodeURIComponent(selectedCollection.id)}/versions${queryString({ limit: VERSION_PAGE_LIMIT, offset: 0 })}`, { signal: controller.signal }),
          { signal: controller.signal },
        );
        if (cancelled) return;
        const rows = (payload.versions ?? []) as ArtifactVersion[];
        setVersions(rows);
        setVersionTotal(Number(payload.total ?? rows.length));
        setVersionHasMore(Boolean(payload.has_more));
        const urlVersion = artifactUrlState().version;
        setSelectedVersionId((current) => {
          if (urlVersion && rows.some((row) => row.id === urlVersion)) return urlVersion;
          return rows.some((row) => row.id === current) ? current : rows[0]?.id ?? "";
        });
      } catch (loadError) {
        if (!cancelled && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load artifact versions.");
          setVersions([]);
          setVersionTotal(0);
          setVersionHasMore(false);
          setVersionLoadingMore(false);
          setSelectedVersionId("");
          setManifestEntries([]);
          setManifestTotal(0);
          setManifestHasMore(false);
          setManifestLoadingMore(false);
          setLineage({ nodes: [], edges: [] });
        }
      }
    }
    loadVersions();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, selectedCollection?.id]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function loadVersionDetail() {
      if (!selectedVersion?.id) {
        setManifestEntries([]);
        setManifestTotal(0);
        setManifestHasMore(false);
        setManifestLoadingMore(false);
        setLineage({ nodes: [], edges: [] });
        return;
      }
      setError("");
      setManifestEntries([]);
      setManifestTotal(0);
      setManifestHasMore(false);
      setManifestLoadingMore(false);
      setLineage({ nodes: [], edges: [] });
      try {
        const [manifestPayload, lineagePayload] = await Promise.all([
          retryTransientRequest(
            () => api.get<ArtifactManifestEnvelope>(`/api/artifact-versions/${encodeURIComponent(selectedVersion.id)}/manifest${queryString({ limit: MANIFEST_PAGE_LIMIT })}`, { signal: controller.signal }),
            { signal: controller.signal },
          ),
          retryTransientRequest(
            () => api.get<ArtifactLineageGraph>(`/api/artifact-versions/${encodeURIComponent(selectedVersion.id)}/lineage${queryString({ limit: 200 })}`, { signal: controller.signal }),
            { signal: controller.signal },
          ),
        ]);
        if (cancelled) return;
        const rows = (manifestPayload.entries ?? []) as ArtifactManifestEntry[];
        setManifestEntries(rows);
        setManifestTotal(Number(manifestPayload.total ?? rows.length));
        setManifestHasMore(Boolean(manifestPayload.has_more));
        setLineage({
          nodes: (lineagePayload.nodes ?? []) as ArtifactLineageGraph["nodes"],
          edges: (lineagePayload.edges ?? []) as ArtifactLineageGraph["edges"],
          truncated: Boolean(lineagePayload.truncated),
          limit: Number(lineagePayload.limit ?? 0),
          depth: Number(lineagePayload.depth ?? 0),
        });
      } catch (loadError) {
        if (!cancelled && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load artifact lineage.");
          setManifestEntries([]);
          setManifestTotal(0);
          setManifestHasMore(false);
          setManifestLoadingMore(false);
          setLineage({ nodes: [], edges: [] });
        }
      }
    }
    loadVersionDetail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, selectedVersion?.id]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function loadLegacyArtifacts() {
      if (!versionedUnsupported || !primaryRun?.id) {
        setLegacyArtifacts([]);
        setLegacyLoading("");
        return;
      }
      setLegacyLoading("Loading raw run artifacts...");
      try {
        const payload = await retryTransientRequest(
          () => api.get<{ artifacts?: Artifact[] }>(`/api/runs/${primaryRun.id}/artifacts${queryString({ limit: 100 })}`, { signal: controller.signal }),
          { signal: controller.signal },
        );
        if (!cancelled) setLegacyArtifacts((payload.artifacts ?? []).slice(0, 100));
      } catch (loadError) {
        if (!cancelled && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load raw artifacts.");
        }
      } finally {
        if (!cancelled) setLegacyLoading("");
      }
    }
    loadLegacyArtifacts();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, primaryRun?.id, versionedUnsupported]);

  async function loadMoreManifest() {
    if (!selectedVersion?.id || !manifestHasMore || manifestLoadingMore) return;
    const versionId = selectedVersion.id;
    setManifestLoadingMore(true);
    try {
      const payload = await api.get<ArtifactManifestEnvelope>(`/api/artifact-versions/${encodeURIComponent(versionId)}/manifest${queryString({ limit: MANIFEST_PAGE_LIMIT, offset: manifestEntries.length })}`);
      if (selectedVersionIdRef.current !== versionId) return;
      const rows = (payload.entries ?? []) as ArtifactManifestEntry[];
      setManifestEntries((current) => [...current, ...rows]);
      setManifestTotal(Number(payload.total ?? manifestTotal));
      setManifestHasMore(Boolean(payload.has_more));
    } catch (loadError) {
      if (selectedVersionIdRef.current === versionId) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load more manifest entries.");
      }
    } finally {
      if (selectedVersionIdRef.current === versionId) setManifestLoadingMore(false);
    }
  }

  async function loadMoreCollections() {
    if (!collectionHasMore || collectionLoadingMore) return;
    setCollectionLoadingMore(true);
    try {
      const payload = await api.get<ArtifactCollectionsEnvelope>(`/api/artifact-collections${queryString({ project, q: collectionQuery, type: typeFilter, limit: COLLECTION_PAGE_LIMIT, offset: collections.length })}`);
      const rows = (payload.collections ?? []) as ArtifactCollection[];
      setCollections((current) => [...current, ...rows]);
      setCollectionTotal(Number(payload.total ?? collectionTotal));
      setCollectionHasMore(Boolean(payload.has_more));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load more artifact collections.");
    } finally {
      setCollectionLoadingMore(false);
    }
  }

  async function loadMoreVersions() {
    if (!selectedCollection?.id || !versionHasMore || versionLoadingMore) return;
    setVersionLoadingMore(true);
    try {
      const payload = await api.get<ArtifactVersionsEnvelope>(`/api/artifact-collections/${encodeURIComponent(selectedCollection.id)}/versions${queryString({ limit: VERSION_PAGE_LIMIT, offset: versions.length })}`);
      const rows = (payload.versions ?? []) as ArtifactVersion[];
      setVersions((current) => [...current, ...rows]);
      setVersionTotal(Number(payload.total ?? versionTotal));
      setVersionHasMore(Boolean(payload.has_more));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load more artifact versions.");
    } finally {
      setVersionLoadingMore(false);
    }
  }

  async function setBestAlias() {
    if (!selectedCollection || !selectedVersion || !canManageArtifacts) return;
    const reason = window.prompt("Reason for moving the best alias", "promote best artifact");
    if (reason === null) return;
    setMutationBusy("best");
    try {
      const payload = await api.put<ArtifactVersionEnvelope>(`/api/artifact-collections/${encodeURIComponent(selectedCollection.id)}/aliases/best`, { artifact_version_id: selectedVersion.id, confirm: "best", reason });
      const artifactVersion = payload.artifact_version as ArtifactVersion | undefined;
      if (artifactVersion) {
        setVersions((current) => current.map((version) => version.id === artifactVersion.id ? artifactVersion : { ...version, aliases: version.aliases.filter((alias) => alias !== "best") }));
        setCollections((current) => current.map((collection) => collection.id === selectedCollection.id ? { ...collection, best_version: artifactVersion } : collection));
      }
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Unable to set best alias.");
    } finally {
      setMutationBusy("");
    }
  }

  async function updateRetention(retentionMode: "inherit" | "keep_forever" | "days", ttlDays?: number) {
    if (!selectedVersion || !canManageArtifacts) return;
    const reason = window.prompt("Reason for updating retention", retentionMode === "days" ? `set ${ttlDays} day retention` : `set ${retentionMode} retention`);
    if (reason === null) return;
    setMutationBusy(`retention-${retentionMode}`);
    try {
      const payload = await api.patch<ArtifactVersionEnvelope>(`/api/artifact-versions/${encodeURIComponent(selectedVersion.id)}/retention`, { retention_mode: retentionMode, ttl_days: ttlDays, confirm: selectedVersion.id, reason });
      const artifactVersion = payload.artifact_version as ArtifactVersion | undefined;
      if (artifactVersion) setVersions((current) => current.map((version) => version.id === artifactVersion.id ? artifactVersion : version));
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Unable to update retention.");
    } finally {
      setMutationBusy("");
    }
  }

  async function deleteVersion() {
    if (!selectedVersion || !canManageArtifacts) return;
    if (!window.confirm(`Delete ${selectedVersion.name}:${selectedVersion.version}?`)) return;
    const reason = window.prompt("Reason for deleting this artifact version", "");
    if (reason === null) return;
    setMutationBusy("delete");
    try {
      const payload = await api.delete<ArtifactVersionEnvelope>(`/api/artifact-versions/${encodeURIComponent(selectedVersion.id)}`, { delete_aliases: true, confirm: selectedVersion.id, reason });
      const artifactVersion = payload.artifact_version as ArtifactVersion | undefined;
      if (artifactVersion) {
        const remaining = versions.filter((version) => version.id !== artifactVersion.id);
        setVersions(remaining);
        setSelectedVersionId(remaining[0]?.id ?? "");
        if (!remaining.length) {
          setManifestEntries([]);
          setManifestTotal(0);
          setManifestHasMore(false);
          setManifestLoadingMore(false);
          setLineage({ nodes: [], edges: [] });
        }
        setCollections((current) => current.map((collection) => {
          if (collection.id !== artifactVersion.collection_id) return collection;
          const latestVersion = collection.latest_version?.id === artifactVersion.id ? remaining[0] ?? null : collection.latest_version;
          const bestVersion = collection.best_version?.id === artifactVersion.id ? remaining.find((version) => version.aliases.includes("best")) ?? null : collection.best_version;
          return { ...collection, versions_count: Math.max(0, (collection.versions_count ?? remaining.length + 1) - 1), latest_version: latestVersion, best_version: bestVersion };
        }));
      }
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Unable to delete artifact version.");
    } finally {
      setMutationBusy("");
    }
  }

  const manageTitle = canManageArtifacts ? "" : "Artifact management requires owner or admin access";
  const mutationDisabled = Boolean(mutationBusy);
  const versionMoreTitle = versionHasMore ? "Load more versions" : "No more versions";
  const collectionCountLabel = collectionTotal ? `${collections.length}/${collectionTotal} collections` : collections.length ? `${collections.length} collections` : "No collections";
  const selectedAliases = selectedVersion?.aliases?.length ? selectedVersion.aliases.join(", ") : "none";
  const rawArtifacts = versionedUnsupported ? legacyArtifacts : visibleArtifacts;
  const hasRawArtifacts = rawArtifacts.length > 0 || loggedObjects.length > 0;
  const rawPanelOpen = versionedUnsupported || (!collections.length && hasRawArtifacts);

  return (
    <>
      <PageHead eyebrow="Workspace" title="Artifacts" />
      {error ? <div className="failure-card" role="alert"><strong>{error}</strong></div> : null}
      {loading ? <div className="status-strip loading" aria-live="polite">{loading}</div> : null}
      {versionedUnsupported ? <div className="status-strip" aria-live="polite">Versioned artifact catalog unavailable on this backend. Showing raw run artifacts.</div> : null}
      <div className="artifact-workspace">
        <section className="panel artifact-catalog-panel">
          <div className="panel-head">
            <h2><Package size={15} /> Collections {collectionTotal || collections.length ? <span>({collectionCountLabel})</span> : null}</h2>
            <div className="panel-controls artifact-catalog-controls">
              <label className="control search-control">
                <Search size={14} />
                <input aria-label="Search artifact collections" placeholder="Search collections" value={collectionQuery} onChange={(event) => setCollectionQuery(event.target.value)} />
              </label>
              <label className="control">
                <select aria-label="Filter artifact type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  {artifactTypeOptions.map((value) => <option key={value || "all"} value={value}>{value || "all types"}</option>)}
                </select>
              </label>
              {collectionHasMore ? <button className="copy-button" disabled={collectionLoadingMore} type="button" onClick={loadMoreCollections}><ListPlus size={13} /> More</button> : null}
            </div>
          </div>
          <div className="panel-body artifact-collection-list">
            {collections.length ? collections.map((collection) => (
              <button
                aria-pressed={collection.id === selectedCollection?.id}
                className={`artifact-collection-row ${collection.id === selectedCollection?.id ? "active" : ""}`}
                key={collection.id}
                type="button"
                onClick={() => setSelectedCollectionId(collection.id)}
              >
                <span className="artifact-type-chip">{collection.type}</span>
                <strong>{collection.name}</strong>
                <small>{collection.project} · {formatNumber(collection.versions_count ?? 0, 0)} versions · {formatBytes(collection.retained_bytes ?? 0)}</small>
              </button>
            )) : <div className="empty">{hasRawArtifacts ? "No versioned artifact collections. Raw run artifacts are shown below." : "No versioned artifact collections."}</div>}
          </div>
        </section>

        <section className="panel artifact-version-panel">
          <div className="panel-head">
            <h2><Archive size={15} /> Versions <span>{selectedCollection ? `${versions.length}/${versionTotal || versions.length}` : "none"}</span></h2>
            {selectedVersion || versionHasMore ? (
              <div className="panel-controls">
                {selectedVersion ? (
                  <>
                    <button className="copy-button" disabled={!canManageArtifacts || mutationDisabled} title={manageTitle || "Move best alias to this version"} type="button" onClick={setBestAlias}><Star size={13} /> Best</button>
                    <button className="copy-button" disabled={!canManageArtifacts || mutationDisabled} title={manageTitle || "Keep this version"} type="button" onClick={() => updateRetention("keep_forever")}><ShieldCheck size={13} /> Keep</button>
                    <button className="copy-button" disabled={!canManageArtifacts || mutationDisabled} title={manageTitle || "Set 30 day retention"} type="button" onClick={() => updateRetention("days", 30)}><CheckCircle2 size={13} /> 30d</button>
                    <button className="copy-button unavailable" disabled={!canManageArtifacts || mutationDisabled} title={manageTitle || "Soft delete this version"} type="button" onClick={deleteVersion}><Trash2 size={13} /> Delete</button>
                  </>
                ) : null}
                <button className="copy-button" disabled={!versionHasMore || versionLoadingMore} title={versionMoreTitle} type="button" onClick={loadMoreVersions}><ListPlus size={13} /> More</button>
              </div>
            ) : null}
          </div>
          <div className="panel-body artifact-version-grid">
            <div className="artifact-version-list">
              {versions.length ? versions.map((version) => (
                <button
                  aria-pressed={version.id === selectedVersion?.id}
                  className={`artifact-version-row ${version.id === selectedVersion?.id ? "active" : ""}`}
                  key={version.id}
                  type="button"
                  onClick={() => setSelectedVersionId(version.id)}
                >
                  <span>{version.version}</span>
                  <strong>{version.aliases?.join(", ") || "no aliases"}</strong>
                  <small>{version.state} · {formatBytes(version.size_bytes)} · {formatNumber(version.file_count, 0)} files</small>
                </button>
              )) : <div className="empty">No versions for this collection.</div>}
            </div>
            <div className="artifact-version-summary">
              <MetricCard label="Selected" value={selectedVersion ? `${selectedVersion.name}:${selectedVersion.version}` : "-"} tone="neutral" />
              <MetricCard label="Aliases" value={selectedAliases} tone={selectedVersion?.aliases?.includes("best") ? "good" : "neutral"} />
              <MetricCard label="State" value={selectedVersion?.state ?? "-"} tone={selectedVersion?.state === "active" ? "good" : "bad"} />
              <button className="copy-button" disabled={!selectedVersion} type="button" onClick={() => void copyText(selectedVersion?.id ?? "")}><Copy size={13} /> Copy version ID</button>
            </div>
          </div>
        </section>

        <section className="panel artifact-manifest-panel">
          <div className="panel-head">
            <h2><Box size={15} /> Manifest <span>({manifestCountLabel})</span></h2>
            <div className="panel-controls">
              <button className="copy-button" disabled={!manifestHasMore || manifestLoadingMore} type="button" onClick={loadMoreManifest}><ListPlus size={13} /> More</button>
            </div>
          </div>
          <div className="panel-body artifact-manifest-table" role="list">
            {manifestEntries.length ? manifestEntries.map((entry) => (
              <div className="artifact-manifest-row" key={entry.id} role="listitem">
                <strong>{entry.path}</strong>
                <span>{entry.kind}</span>
                <span>{formatBytes(entry.size_bytes)}</span>
                <span>{entry.sha256 ? entry.sha256.slice(0, 12) : "-"}</span>
                {entry.downloadable ? (
                  <a className="copy-button" href={`/api/artifact-entries/${encodeURIComponent(entry.id)}/download`}><Download size={13} /> Download</a>
                ) : (
                  <button className="copy-button unavailable" disabled type="button"><Download size={13} /> Unavailable</button>
                )}
              </div>
            )) : <div className="empty">No manifest entries selected.</div>}
          </div>
        </section>

        <section className="panel artifact-lineage-panel">
          <div className="panel-head"><h2><GitBranch size={15} /> Lineage <span>({lineage.nodes.length}{lineage.truncated ? `/${lineage.limit}` : ""})</span></h2></div>
          <div className="panel-body artifact-lineage-body">
            <ArtifactLineageView graph={lineage} />
          </div>
        </section>

        <details className="panel artifact-raw-panel" open={rawPanelOpen}>
          <summary className="panel-head"><h2><Package size={15} /> Raw run artifacts <span>({rawArtifacts.length})</span></h2></summary>
          <div className="panel-body">
            {legacyLoading ? <div className="status-strip loading" aria-live="polite">{legacyLoading}</div> : null}
            <RichObjectPanel objects={loggedObjects} rowsByObjectId={objectRowsById} title="Logged Objects" />
            <ArtifactBrowser artifacts={rawArtifacts} />
          </div>
        </details>

        <section className="panel artifact-totals-panel">
          <div className="panel-head"><h2><Archive size={15} /> Selected page totals</h2></div>
          <div className="panel-body insight-stack">
            <MetricCard label="Files" value={formatNumber(artifactTotals.file, 0)} tone="neutral" />
            <MetricCard label="Checkpoints" value={formatNumber(artifactTotals.checkpoint, 0)} tone="good" />
            <MetricCard label="Rollouts" value={formatNumber(artifactTotals.rollout, 0)} tone="live" />
            <MetricCard label="Inspected run" value={primaryRun?.name ?? "-"} tone="neutral" />
          </div>
        </section>
      </div>
    </>
  );
}

function ArtifactLineageView({ graph }: { graph: ArtifactLineageGraph }) {
  if (!graph.nodes.length) return <div className="empty">No lineage edges recorded.</div>;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <div className="artifact-lineage-grid">
      <div className="artifact-lineage-nodes">
        {graph.nodes.map((node) => (
          <article className={`artifact-lineage-node ${node.kind}`} key={node.id}>
            <span>{node.kind.replace("_", " ")}</span>
            <strong>{node.label}</strong>
            <small>{node.state ?? ""}</small>
          </article>
        ))}
      </div>
      <div className="artifact-lineage-edges">
        {graph.edges.length ? graph.edges.map((edge, index) => (
          <div className="artifact-lineage-edge" key={`${edge.from}-${edge.to}-${index}`}>
            <span>{byId.get(edge.from)?.label ?? edge.from}</span>
            <GitBranch size={13} />
            <small>{edge.direction ?? "edge"}</small>
            <span>{byId.get(edge.to)?.label ?? edge.to}</span>
          </div>
        )) : <div className="empty">No run input or output edges for this version.</div>}
      </div>
    </div>
  );
}
