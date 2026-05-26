import { Code2, Copy, KeyRound, Plus, RefreshCw, X } from "lucide-react";

import { ApiTable } from "./api-table";
import { PageHead } from "../ui/page-head";
import type { ApiRow } from "../../dashboard-types";
import type { components } from "../../../src/types/api.generated";

type ApiKeyRow = components["schemas"]["PublicApiKeyRow"];

type Props = {
  activeOrgId: string;
  adminBusy: boolean;
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
  const activeKeyCount = apiKeys.filter((key) => !key.revoked_at).length;
  return (
    <>
      <PageHead eyebrow={canManageOrg ? "Admin" : "Workspace"} title="API" emphasis="keys" lede={`${activeKeyCount} active · documented REST routes`} />
      <div className="tab-grid two-col">
        <section className="panel">
          <div className="panel-head">
            <h2><KeyRound size={15} /> API Keys</h2>
            <button className="ghost" disabled={adminBusy || !canManageOrg} onClick={onLoadApiKeys} type="button"><RefreshCw size={14} /> Refresh</button>
          </div>
          <div className="panel-body admin-stack">
            {canManageOrg ? (
              <>
                <div className="admin-form-row">
                  <input aria-label="API key name" onChange={(event) => onApiKeyNameChange(event.target.value)} value={apiKeyName} />
                  <button className="primary-button" disabled={adminBusy || !activeOrgId} onClick={onCreateApiKey} type="button"><Plus size={14} /> Create</button>
                </div>
                {newApiKey ? (
                  <div className="api-key-reveal" role="status" aria-live="polite">
                    <strong>Copy-once API key</strong>
                    <code>{newApiKey}</code>
                    <button className="secondary" onClick={onCopyNewApiKey} type="button"><Copy size={14} /> Copy</button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="empty">API key management is available to workspace admins.</p>
            )}
            {canManageOrg ? (
              <div className="admin-list">
                {apiKeys.map((key) => (
                  <div className={`api-row ${key.revoked_at ? "muted" : ""}`} key={key.id}>
                    <span>{key.revoked_at ? "Revoked" : "Active"}</span>
                    <strong>{key.name}</strong>
                    <code>{key.key_prefix}</code>
                    <button className="ghost" disabled={adminBusy || Boolean(key.revoked_at)} onClick={() => onRevokeApiKey(key.id)} type="button" aria-label={`Revoke ${key.name}`}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {!apiKeys.length ? <p className="empty">No API keys loaded.</p> : null}
              </div>
            ) : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Code2 size={15} /> API Surface</h2></div>
          <div className="panel-body">
            <ApiTable rows={apiRows} />
            <pre>{JSON.stringify({ org_id: activeOrgId || null, project: project || null, status: status || null, metric_key: metricKey, inspected_run_id: primaryRunId ?? null, selected_run_ids: selectedRunIds }, null, 2)}</pre>
          </div>
        </section>
      </div>
    </>
  );
}
