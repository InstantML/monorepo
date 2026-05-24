pub mod artifacts;
pub mod auth;
pub mod billing;
pub mod dashboard;
pub(crate) mod helpers;
pub mod imports;
pub mod invitations;
pub mod metrics;
pub mod orgs;
pub mod platform;
pub mod runs;
pub mod usage;

pub(super) use artifacts::{create_artifact, download_artifact, list_artifacts, upload_artifact};
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
    create_workspace_view, get_dashboard_preferences, get_workspace_view, list_workspace_views,
    update_dashboard_preferences, update_workspace_view,
};
pub(super) use imports::{import_mlflow, import_neptune, import_wandb, list_imports};
pub(super) use invitations::{
    accept_invitation, create_invitation, list_invitations, preview_invitation, resend_invitation,
    revoke_invitation,
};
pub(super) use metrics::metrics_series;
pub(super) use orgs::{
    create_api_key, create_customer_clickhouse_connection, create_org, create_user,
    customer_clickhouse_connection_status, disable_service_account, list_api_keys,
    list_org_memberships, list_orgs, list_seats, list_users, org_name_availability, reserve_seat,
    revoke_api_key, rotate_customer_clickhouse_credentials,
    validate_customer_clickhouse_connection,
};
pub(super) use platform::{
    auth_config, health, metrics as metrics_handler, not_found, openapi_json, readyz,
};
pub(super) use runs::{
    create_attributes, create_object, create_project, create_run, get_metrics, get_run,
    list_attributes, list_console_logs, list_object_rows, list_objects, list_projects, list_runs,
    log_console_logs, log_metrics, log_rank_metrics, overview, rank_metrics_summary, runs_summary,
    side_by_side, update_run,
};
pub(super) use usage::{export_data, reset_demo, usage_export, usage_summary};

#[cfg(test)]
mod tests {
    use super::helpers::{request_rate_key, require_session_scope, validate_clerk_signup_allowed};
    use super::platform::openapi_path_available_for_plane;
    use crate::domain::{ClerkAuthRequest, SessionContext};
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
            "api_keys:write",
        ] {
            assert!(require_session_scope(&demo, scope).is_err());
        }
    }

    #[test]
    fn non_demo_session_roles_keep_expected_write_permissions() {
        assert!(require_session_scope(&session("member", false), "sdk:ingest").is_ok());
        assert!(require_session_scope(&session("viewer", false), "export:read").is_ok());
        assert!(require_session_scope(&session("viewer", false), "sdk:ingest").is_err());
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
            "/runs",
            ServicePlaneRole::Data
        ));
        assert!(!openapi_path_available_for_plane(
            "/runs",
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
            "/api/runs/{run_id}/logs",
            "/api/metrics/series",
            // dashboard analytics
            "/api/overview",
            "/api/runs/summary",
            "/api/runs/side-by-side",
            "/api/runs/{run_id}/rank-metrics/summary",
            // attributes / objects
            "/api/runs/{run_id}/attributes",
            "/api/runs/{run_id}/objects",
            "/api/objects/{object_id}/rows",
            // artifacts
            "/api/runs/{run_id}/artifacts",
            "/api/runs/{run_id}/artifacts/upload",
            "/api/artifacts/{artifact_id}/download",
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
            "ProjectEnvelope",
            "RunsEnvelope",
            "InsertedEnvelope",
            "LogRankMetricsRequest",
            "RankMetricsSummaryResponse",
            "RankReducerPoint",
            "RankHeatmapPoint",
            "RankOutlierPoint",
            "RankCoveragePoint",
        ] {
            assert!(
                schemas.contains_key(expected),
                "utoipa spec missing schema {expected}"
            );
        }
    }

    #[test]
    fn clerk_signup_allowlist_only_applies_to_signup() {
        let mut config = test_config();
        config.signup_allowed_emails = vec!["founder@example.com".to_string()];
        config.signup_allowed_domains = vec!["instantml.ai".to_string()];
        let signup = ClerkAuthRequest {
            token: None,
            mode: Some("signup".to_string()),
            account_type: None,
            org_name: Some("Acme".to_string()),
            plan_tier: None,
            storage_choice: None,
            seat_emails: None,
            accept_invite_org_id: None,
            accept_invite_token: None,
        };
        assert!(validate_clerk_signup_allowed(&config, "founder@example.com", &signup).is_ok());
        assert!(validate_clerk_signup_allowed(&config, "teammate@instantml.ai", &signup).is_ok());
        assert!(validate_clerk_signup_allowed(&config, "stranger@example.org", &signup).is_err());

        let signin = ClerkAuthRequest {
            token: None,
            mode: Some("signin".to_string()),
            account_type: None,
            org_name: None,
            plan_tier: None,
            storage_choice: None,
            seat_emails: None,
            accept_invite_org_id: None,
            accept_invite_token: None,
        };
        assert!(validate_clerk_signup_allowed(&config, "stranger@example.org", &signin).is_ok());

        let invite_accept_signup = ClerkAuthRequest {
            token: None,
            mode: Some("signup".to_string()),
            account_type: None,
            org_name: Some("Acme".to_string()),
            plan_tier: None,
            storage_choice: None,
            seat_emails: None,
            accept_invite_org_id: None,
            accept_invite_token: Some("instantml_invite_test".to_string()),
        };
        assert!(validate_clerk_signup_allowed(
            &config,
            "invited@example.org",
            &invite_accept_signup
        )
        .is_ok());
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
            signup_allowed_emails: Vec::new(),
            signup_allowed_domains: Vec::new(),
            artifact_backend: crate::config::ArtifactBackend::Local,
            r2_artifacts: None,
            artifact_uploads_enabled: true,
            allowed_frontend_origins: Vec::new(),
            request_timeout: std::time::Duration::from_secs(30),
            slow_request_threshold: std::time::Duration::from_millis(1000),
            log_format: crate::config::LogFormat::Pretty,
            hosted_clickhouse: None,
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
            "/api/orgs/memberships",
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
