pub mod admin;
pub mod artifacts;
pub mod auth;
pub mod billing;
pub mod dashboard;
pub(crate) mod helpers;
pub mod imports;
pub mod insights;
pub mod invitations;
pub mod metrics;
pub mod orgs;
pub mod platform;
pub mod reports;
pub mod runs;
pub mod usage;

pub(super) use admin::{admin_data_cells, admin_overview};
pub(super) use artifacts::{
    abort_artifact_upload, artifact_version_lineage, complete_artifact_upload, create_artifact,
    create_artifact_input_edge, delete_artifact_alias, delete_artifact_version, download_artifact,
    download_artifact_entry, get_artifact_collection, get_artifact_version,
    initiate_artifact_upload, list_artifact_collection_versions, list_artifact_collections,
    list_artifact_manifest, list_artifacts, renew_artifact_upload, resolve_artifact_version,
    run_artifact_edges, set_artifact_alias, update_artifact_retention, upload_artifact,
};
pub(super) use auth::{
    auth_clerk, auth_dev_google, auth_logout, auth_session, auth_switch_organization,
    device_code_confirm, device_code_poll, device_code_start,
};
pub(super) use billing::{
    billing_add_seat, billing_cancel, billing_change_plan, billing_checkout, billing_checkout_sync,
    billing_portal, billing_report_storage_overage, billing_report_usage_overage, billing_status,
    billing_webhook,
};
pub(super) use dashboard::{
    create_workspace_view, delete_workspace_view, export_workspace_view, get_dashboard_preferences,
    get_workspace_view, import_workspace_view, list_workspace_views, update_dashboard_preferences,
    update_workspace_view, workspace_view_data,
};
pub(super) use imports::{
    append_import_chunk, cancel_import_job, commit_import_job, create_import_job, get_import_job,
    import_mlflow, import_neptune, import_wandb, list_imports,
};
pub(super) use insights::system_usage_insights;
pub(super) use invitations::{
    accept_invitation, create_invitation, list_invitations, preview_invitation, resend_invitation,
    revoke_invitation,
};
pub(super) use metrics::metrics_series;
pub(super) use orgs::{
    create_api_key, create_current_user_org, create_customer_clickhouse_connection, create_org,
    create_user, customer_clickhouse_connection_status, disable_service_account, list_api_keys,
    list_org_memberships, list_orgs, list_seats, list_users, org_name_availability, reserve_seat,
    revoke_api_key, rotate_customer_clickhouse_credentials,
    validate_customer_clickhouse_connection,
};
pub(super) use platform::{
    auth_config, health, metrics as metrics_handler, not_found, openapi_json, readyz,
};
pub(super) use reports::{
    create_report, delete_report, export_report_markdown, get_report, get_report_by_share_token,
    list_org_panels, list_reports, rotate_report_share_token, update_report,
};
pub(super) use runs::{
    create_attributes, create_object, create_project, create_run, fork_run, get_metrics, get_run,
    get_run_lineage, list_attributes, list_console_logs, list_object_rows, list_objects,
    list_projects, list_runs, log_console_logs, log_metrics, log_rank_metrics, overview,
    rank_metrics_summary, runs_summary, side_by_side, stop_ack, stop_run, stop_runs, stop_signal,
    update_run,
};
pub(super) use usage::{export_data, reset_demo, usage_export, usage_summary};

#[cfg(test)]
mod tests {
    use super::helpers::{request_rate_key, require_session_scope};
    use super::platform::openapi_path_available_for_plane;
    use crate::domain::SessionContext;
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::Value;
    use uuid::Uuid;

    fn session(role: &str, demo_read_only: bool) -> SessionContext {
        SessionContext {
            session_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            role: role.to_string(),
            demo_read_only,
        }
    }

    #[test]
    fn demo_browser_sessions_are_read_only() {
        let demo = session("owner", true);
        assert!(require_session_scope(&demo, "export:read").is_ok());
        for scope in [
            "sdk:ingest",
            "artifacts:write",
            "imports:write",
            "usage:read",
            "runs:control",
            "api_keys:write",
        ] {
            assert!(require_session_scope(&demo, scope).is_err());
        }
    }

    #[test]
    fn non_demo_session_roles_keep_expected_write_permissions() {
        assert!(require_session_scope(&session("member", false), "sdk:ingest").is_ok());
        assert!(require_session_scope(&session("member", false), "runs:control").is_ok());
        assert!(require_session_scope(&session("viewer", false), "export:read").is_ok());
        assert!(require_session_scope(&session("viewer", false), "sdk:ingest").is_err());
        assert!(require_session_scope(&session("viewer", false), "runs:control").is_err());
        assert!(require_session_scope(&session("member", false), "api_keys:write").is_err());
        assert!(require_session_scope(&session("owner", false), "api_keys:write").is_ok());
    }

    #[test]
    fn invite_rate_key_keeps_peer_and_splits_forwarded_clients() {
        let peer = "198.51.100.24:443".parse().expect("peer addr");
        let mut headers = HeaderMap::new();

        assert_eq!(request_rate_key(&headers, peer), "ip:198.51.100.24");

        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.9, 10.0.0.2"),
        );
        assert_eq!(
            request_rate_key(&headers, peer),
            "ip:198.51.100.24;client:203.0.113.9"
        );
    }

    #[test]
    fn openapi_paths_follow_service_plane_roles() {
        use crate::config::ServicePlaneRole;

        assert!(openapi_path_available_for_plane(
            "/api/auth/config",
            ServicePlaneRole::Control
        ));
        assert!(openapi_path_available_for_plane(
            "/api/auth/config",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/api/orgs/{org_id}/api-keys",
            ServicePlaneRole::Control
        ));
        assert!(!openapi_path_available_for_plane(
            "/api/orgs/{org_id}/api-keys",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/api/billing/status",
            ServicePlaneRole::Control
        ));
        assert!(!openapi_path_available_for_plane(
            "/api/billing/status",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/api/admin/overview",
            ServicePlaneRole::Control
        ));
        assert!(!openapi_path_available_for_plane(
            "/api/admin/overview",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/api/admin/data-cells",
            ServicePlaneRole::Control
        ));
        assert!(!openapi_path_available_for_plane(
            "/api/admin/data-cells",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/runs",
            ServicePlaneRole::Data
        ));
        assert!(!openapi_path_available_for_plane(
            "/runs",
            ServicePlaneRole::Control
        ));
        assert!(openapi_path_available_for_plane(
            "/api/reports",
            ServicePlaneRole::Data
        ));
        assert!(!openapi_path_available_for_plane(
            "/api/reports",
            ServicePlaneRole::Control
        ));
        assert!(openapi_path_available_for_plane(
            "/api/storage/clickhouse-connections/current",
            ServicePlaneRole::Data
        ));
        assert!(openapi_path_available_for_plane(
            "/api/storage/clickhouse-connections/rotate-credentials",
            ServicePlaneRole::Data
        ));
        assert!(!openapi_path_available_for_plane(
            "/api/storage/clickhouse-connections/current",
            ServicePlaneRole::Control
        ));
    }

    #[test]
    fn utoipa_apidoc_emits_annotated_paths_and_schemas() {
        use utoipa::OpenApi as _;
        let spec = crate::http::openapi::ApiDoc::openapi();
        let value = serde_json::to_value(&spec).expect("serialize spec");
        let paths = value
            .get("paths")
            .and_then(Value::as_object)
            .expect("paths");
        // Every router-registered path (minus /healthz alias, /metrics
        // Prometheus text, and /openapi.json self-reference) must be present
        // in the utoipa-generated spec. Update this list when you add or
        // remove routes.
        for expected in [
            // platform
            "/health",
            "/readyz",
            // auth
            "/api/auth/config",
            "/api/auth/dev/google",
            "/api/auth/clerk",
            "/api/auth/session",
            "/api/auth/logout",
            "/api/auth/switch-organization",
            "/api/auth/device-code/start",
            "/api/auth/device-code/poll",
            "/api/auth/device-code/confirm",
            "/api/invitations/preview",
            "/api/invitations/accept",
            "/api/admin/overview",
            "/api/admin/data-cells",
            // billing
            "/api/billing/status",
            "/api/billing/checkout",
            "/api/billing/checkout/sync",
            "/api/billing/portal",
            "/api/billing/change-plan",
            "/api/billing/add-seat",
            "/api/billing/cancel",
            "/api/billing/webhook",
            // dashboard
            "/api/dashboard/preferences",
            "/api/workspace-views",
            "/api/workspace-views/{view_id}",
            // users / orgs
            "/api/users",
            "/api/orgs",
            "/api/orgs/current-user",
            "/api/orgs/memberships",
            "/api/orgs/name-availability",
            "/api/orgs/{org_id}/seats",
            "/api/orgs/{org_id}/invitations",
            "/api/orgs/{org_id}/invitations/{invitation_id}/resend",
            "/api/orgs/{org_id}/invitations/{invitation_id}/revoke",
            "/api/orgs/{org_id}/api-keys",
            "/api/orgs/{org_id}/api-keys/{api_key_id}/revoke",
            "/api/orgs/{org_id}/service-accounts/{service_account_id}/disable",
            // runs core
            "/projects",
            "/runs",
            "/runs/{run_id}",
            "/runs/{run_id}/metrics",
            "/runs/{run_id}/rank-metrics",
            "/api/runs/{run_id}/forks",
            "/api/runs/{run_id}/lineage",
            "/api/runs/{run_id}/logs",
            "/api/runs/stop",
            "/api/runs/{run_id}/stop",
            "/api/runs/{run_id}/stop-signal",
            "/api/runs/{run_id}/stop-ack",
            "/api/metrics/series",
            // dashboard analytics
            "/api/overview",
            "/api/runs/summary",
            "/api/runs/side-by-side",
            "/api/insights/system-usage",
            "/api/runs/{run_id}/rank-metrics/summary",
            // attributes / objects
            "/api/runs/{run_id}/attributes",
            "/api/runs/{run_id}/objects",
            "/api/objects/{object_id}/rows",
            // artifacts
            "/api/runs/{run_id}/artifacts",
            "/api/runs/{run_id}/artifacts/upload",
            "/api/artifacts/{artifact_id}/download",
            "/api/artifact-collections",
            "/api/artifact-collections/{collection_id}",
            "/api/artifact-collections/{collection_id}/versions",
            "/api/artifact-collections/{collection_id}/aliases/{alias}",
            "/api/artifact-versions/resolve",
            "/api/artifact-versions/{version_id}",
            "/api/artifact-versions/{version_id}/manifest",
            "/api/artifact-versions/{version_id}/lineage",
            "/api/artifact-versions/{version_id}/retention",
            "/api/artifact-entries/{entry_id}/download",
            "/api/runs/{run_id}/artifact-uploads",
            "/api/artifact-uploads/{upload_session_id}/renew",
            "/api/artifact-uploads/{upload_session_id}/complete",
            "/api/artifact-uploads/{upload_session_id}/abort",
            "/api/runs/{run_id}/artifact-inputs",
            "/api/runs/{run_id}/artifact-edges",
            // export / usage / imports
            "/api/export",
            "/api/usage",
            "/api/usage/export",
            "/api/storage/clickhouse-connections/current",
            "/api/storage/clickhouse-connections/validate",
            "/api/storage/clickhouse-connections",
            "/api/storage/clickhouse-connections/rotate-credentials",
            "/api/imports",
            "/api/imports/neptune",
            "/api/imports/wandb",
            "/api/imports/mlflow",
            // reports
            "/api/reports",
            "/api/reports/panels",
            "/api/reports/{report_id}",
            "/api/reports/{report_id}/share",
            "/api/reports/{report_id}/markdown",
            "/api/reports/share/{share_token}",
        ] {
            assert!(
                paths.contains_key(expected),
                "utoipa spec missing path {expected}"
            );
        }
        let schemas = value
            .pointer("/components/schemas")
            .and_then(Value::as_object)
            .expect("components.schemas");
        for expected in [
            "RunRow",
            "ProjectRow",
            "SeatRow",
            "PublicInvitationRow",
            "InvitationEnvelope",
            "PublicApiKeyRow",
            "WorkspaceViewSummary",
            "AuthSessionPayload",
            "ClickHouseConnectionStatusEnvelope",
            "ClickHouseConnectionValidationEnvelope",
            "AdminOverviewResponse",
            "ProjectEnvelope",
            "RunSummaryEnvelope",
            "RunSummariesEnvelope",
            "SystemUsageInsightsEnvelope",
            "RunsEnvelope",
            "InsertedEnvelope",
            "LogRankMetricsRequest",
            "RankMetricsSummaryResponse",
            "RankReducerPoint",
            "RankHeatmapPoint",
            "RankOutlierPoint",
            "RankCoveragePoint",
            "ReportRow",
            "ReportSummary",
            "ReportEnvelope",
            "ReportSummariesEnvelope",
            "CreateReportRequest",
            "UpdateReportRequest",
            "InitiateArtifactUploadRequest",
            "CompleteArtifactUploadRequest",
            "ArtifactCollectionRow",
            "ArtifactVersionRow",
            "ArtifactManifestEntryRow",
            "ArtifactAliasRow",
            "ArtifactEdgeRow",
        ] {
            assert!(
                schemas.contains_key(expected),
                "utoipa spec missing schema {expected}"
            );
        }
    }

    fn test_config() -> crate::config::AppConfig {
        crate::config::AppConfig {
            clickhouse_url: "http://default:@127.0.0.1:8123/instantml".to_string(),
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            service_plane: crate::config::ServicePlaneRole::Combined,
            max_body_bytes: 1_000_000,
            max_upload_body_bytes: 50_000_000,
            artifact_root: ".instantml/rust-artifacts".into(),
            bootstrap_token: String::new(),
            auth_mode: crate::config::AuthMode::Local,
            dev_auth_enabled: true,
            managed_clerk_enabled: false,
            clerk_secret_key: None,
            clerk_api_base: "https://api.clerk.com".to_string(),
            clerk_jwt_issuer: None,
            clerk_session_max_token_age: std::time::Duration::from_secs(600),
            artifact_backend: crate::config::ArtifactBackend::Local,
            r2_artifacts: None,
            artifact_uploads_enabled: true,
            allowed_frontend_origins: Vec::new(),
            request_timeout: std::time::Duration::from_secs(30),
            slow_request_threshold: std::time::Duration::from_millis(1000),
            log_format: crate::config::LogFormat::Pretty,
            hosted_clickhouse: None,
            cell_routing: crate::config::CellRoutingConfig {
                environment: "test".to_string(),
                placement_data_cell_id: None,
                heartbeat_data_cell_id: None,
            },
            control_database_url: None,
            byoc_clickhouse: crate::config::ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "local-dev".to_string(),
                allow_private_endpoints: false,
                credential_store: crate::config::ByocCredentialStoreConfig::Disabled,
            },
            billing: crate::config::BillingConfig::disabled(Some("http://localhost:3000")),
            email: crate::config::EmailConfig {
                provider: crate::config::EmailProvider::Log,
                from: "InstantML <invites@instantml.ai>".to_string(),
                reply_to: None,
                frontend_base_url: "http://localhost:3000".to_string(),
                resend_api_key: None,
            },
            frontend_base_url: Some("http://localhost:3000".to_string()),
        }
    }

    #[test]
    fn org_switcher_endpoints_live_on_control_plane() {
        use crate::config::ServicePlaneRole;

        for path in [
            "/api/auth/switch-organization",
            "/api/orgs/current-user",
            "/api/orgs/memberships",
            "/api/admin/overview",
            "/api/admin/data-cells",
            "/api/invitations/preview",
            "/api/invitations/accept",
            "/api/orgs/{org_id}/invitations",
        ] {
            assert!(
                openapi_path_available_for_plane(path, ServicePlaneRole::Control),
                "{path} should be available on control plane"
            );
            assert!(
                openapi_path_available_for_plane(path, ServicePlaneRole::Combined),
                "{path} should be available on combined plane"
            );
            assert!(
                !openapi_path_available_for_plane(path, ServicePlaneRole::Data),
                "{path} should not be available on data plane"
            );
        }
    }

    #[test]
    fn device_code_endpoints_on_control_plane() {
        use crate::config::ServicePlaneRole;

        for path in [
            "/api/auth/device-code/start",
            "/api/auth/device-code/poll",
            "/api/auth/device-code/confirm",
        ] {
            assert!(
                openapi_path_available_for_plane(path, ServicePlaneRole::Control),
                "{path} should be available on control plane"
            );
            assert!(
                openapi_path_available_for_plane(path, ServicePlaneRole::Combined),
                "{path} should be available on combined plane"
            );
            assert!(
                !openapi_path_available_for_plane(path, ServicePlaneRole::Data),
                "{path} should not be available on data plane"
            );
        }
    }

    #[test]
    fn frontend_base_url_fallback_chain() {
        let config = test_config();
        let url = config
            .frontend_base_url
            .as_deref()
            .or_else(|| config.allowed_frontend_origins.first().map(String::as_str))
            .unwrap_or("http://localhost:3000");
        assert_eq!(url, "http://localhost:3000");
    }

    #[test]
    fn frontend_base_url_falls_back_to_allowed_origins() {
        let mut config = test_config();
        config.frontend_base_url = None;
        config.allowed_frontend_origins = vec!["https://app.example.com".to_string()];
        let url = config
            .frontend_base_url
            .as_deref()
            .or_else(|| config.allowed_frontend_origins.first().map(String::as_str))
            .unwrap_or("http://localhost:3000");
        assert_eq!(url, "https://app.example.com");
    }

    #[test]
    fn frontend_base_url_falls_back_to_localhost_when_nothing_set() {
        let mut config = test_config();
        config.frontend_base_url = None;
        config.allowed_frontend_origins = vec![];
        let url = config
            .frontend_base_url
            .as_deref()
            .or_else(|| config.allowed_frontend_origins.first().map(String::as_str))
            .unwrap_or("http://localhost:3000");
        assert_eq!(url, "http://localhost:3000");
    }
}
