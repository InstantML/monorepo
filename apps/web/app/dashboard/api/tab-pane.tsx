import { Code2, Copy, KeyRound, Plus, RefreshCw, X } from "lucide-react";

import { ApiTable } from "./api-table";
import { PageHead } from "../ui/page-head";
import type { ApiRow } from "../../dashboard-types";
import type { components } from "../../../src/types/api.generated";

type ApiKeyRow = components["schemas"]["PublicApiKeyRow"];

type Props = {
  activeOrgId: string;
  adminBusy: boolean;
  adminMessage: string;
  adminMessageTone: "status" | "error";
  apiKeyName: string;
  apiKeys: ApiKeyRow[];
  apiRows: ApiRow[];
  canManageOrg: boolean;
  metricKey: string;
  newApiKey: string;
  onApiKeyNameChange: (name: string) => void;
  onCopyNewApiKey: () => void;
  onCreateApiKey: () => void;
  onLoadApiKeys: () => void;
  onRevokeApiKey: (id: string) => void;
  primaryRunId: string | null;
  project: string;
  selectedRunIds: string[];
  status: string;
};

export function ApiTabPane({
  activeOrgId,
  adminBusy,
  adminMessage,
  adminMessageTone,
  apiKeyName,
  apiKeys,
  apiRows,
  canManageOrg,
  metricKey,
  newApiKey,
  onApiKeyNameChange,
  onCopyNewApiKey,
  onCreateApiKey,
  onLoadApiKeys,
  onRevokeApiKey,
  primaryRunId,
  project,
  selectedRunIds,
  status,
}: Props) {
  const visibleApiKeys = canManageOrg ? apiKeys : [];
  const visibleNewApiKey = canManageOrg ? newApiKey : "";
  return (
    <>
      <PageHead title="API" />
      <div className="tab-grid two-col api-tab-grid">
        <section className="panel">
          <div className="panel-head">
            <h2><KeyRound size={15} /> API Keys</h2>
            <button className="ghost" disabled={adminBusy || !canManageOrg} onClick={onLoadApiKeys} type="button"><RefreshCw size={14} /> Refresh</button>
          </div>
          <div className="panel-body admin-stack">
            {canManageOrg ? (
              <>
                <div className="admin-form-row">
                  <input aria-label="API key name" onChange={(event) => onApiKeyNameChange(event.target.value)} placeholder="Dashboard SDK key" value={apiKeyName} />
                  <button className="primary-button" disabled={adminBusy || !activeOrgId} onClick={onCreateApiKey} type="button"><Plus size={14} /> Create</button>
                </div>
                {/* AP3: key-management guidance with a docs path, not just a form. */}
                <p className="admin-hint">
                  Keys are shown once at creation and sent as <code>Authorization: Bearer</code>. Name keys per machine or pipeline so revoking one doesn&apos;t break the rest — see the <a href="/docs/quickstart">quickstart</a> and <a href="/docs/api">API reference</a>.
                </p>
              </>
            ) : (
              <p className="empty">API-key management is available to workspace owners and admins.</p>
            )}
            {adminMessage ? <p className={`admin-message ${adminMessageTone}`} role={adminMessageTone === "error" ? "alert" : "status"}>{adminMessage}</p> : null}
            {visibleNewApiKey ? (
              <div className="api-key-reveal" role="status" aria-live="polite">
                <strong>Copy-once API key</strong>
                <code>{visibleNewApiKey}</code>
                <button className="secondary" onClick={onCopyNewApiKey} type="button"><Copy size={14} /> Copy</button>
              </div>
            ) : null}
            <div className="admin-list">
              {visibleApiKeys.map((key) => (
                <div className={`api-row ${key.revoked_at ? "muted" : ""}`} key={key.id}>
                  <span>{key.revoked_at ? "Revoked" : "Active"}</span>
                  <strong>{key.name}</strong>
                  <code>{key.key_prefix}</code>
                  {canManageOrg ? (
                    <button className="ghost" disabled={adminBusy || Boolean(key.revoked_at)} onClick={() => onRevokeApiKey(key.id)} type="button" aria-label={`Revoke ${key.name}`}>
                      <X size={14} />
                    </button>
                  ) : null}
                </div>
              ))}
              {canManageOrg && !visibleApiKeys.length ? <p className="empty">No API keys loaded.</p> : null}
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Code2 size={15} /> API Surface</h2></div>
          <div className="panel-body">
            <ApiTable rows={apiRows} />
            <details className="detail-section api-context-detail">
              <summary>Current query context</summary>
              <pre>{JSON.stringify({ org_id: activeOrgId || null, project: project || null, status: status || null, metric_key: metricKey, inspected_run_id: primaryRunId ?? null, selected_run_ids: selectedRunIds }, null, 2)}</pre>
            </details>
          </div>
        </section>
      </div>
    </>
  );
}
