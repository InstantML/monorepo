use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::Method,
    middleware::Next,
    response::{IntoResponse, Response},
};

use super::{handlers::helpers, AppState};

pub async fn data_plane_writer_lease(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    if !requires_data_plane_write_guard(request.method(), request.uri().path()) {
        return next.run(request).await;
    }

    if state.config.auth_mode.requires_api_key()
        && helpers::header_text(request.headers(), "authorization").is_none()
        && helpers::session_cookie(request.headers()).is_none()
    {
        return next.run(request).await;
    }

    let ctx = match helpers::context(&state, request.headers(), false).await {
        Ok(ctx) => ctx,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = state
        .store
        .ensure_org_routed_to_current_data_cell(ctx.org_id, state.config.service_plane)
        .await
    {
        return error.into_response();
    }

    let lease_required = match state
        .store
        .ensure_data_cell_writer_lease_for_mutation(state.config.service_plane)
        .await
    {
        Ok(lease_required) => lease_required,
        Err(error) => return error.into_response(),
    };
    if !lease_required {
        return next.run(request).await;
    }

    let store = state.store.clone();
    let service_plane = state.config.service_plane;
    let org_id = ctx.org_id;
    let renew_interval = store.data_cell_writer_lease_renew_interval();
    let response = next.run(request);
    tokio::pin!(response);

    // Phase 1A is a write-admission fence. Renewing while the handler runs
    // keeps a stale writer from continuing, but it cannot roll back ClickHouse
    // side effects that were already committed before a later renewal failure.
    loop {
        tokio::select! {
            response = &mut response => return response,
            _ = tokio::time::sleep(renew_interval) => {
                if let Err(error) = store.ensure_org_routed_to_current_data_cell(org_id, service_plane).await {
                    tracing::warn!(
                        workflow = "data_cell_writer_lease",
                        operation = "request_route_cell_verify",
                        outcome = "failure",
                        status = error.status().as_u16(),
                        code = error.safe_code(),
                        error_kind = error.safe_code(),
                        retryable = error.retryable(),
                        safe_summary = error.safe_summary(),
                        "data-plane mutation lost route-cell admission while the request was running"
                    );
                    return error.into_response();
                }
                if let Err(error) = store.ensure_data_cell_writer_lease_for_mutation(service_plane).await {
                    tracing::warn!(
                        workflow = "data_cell_writer_lease",
                        operation = "request_renew",
                        outcome = "failure",
                        status = error.status().as_u16(),
                        code = error.safe_code(),
                        error_kind = error.safe_code(),
                        retryable = error.retryable(),
                        safe_summary = error.safe_summary(),
                        "data-plane mutation lost its writer lease while the request was running"
                    );
                    return error.into_response();
                }
            }
        }
    }
}

pub(crate) fn requires_data_plane_write_guard(method: &Method, path: &str) -> bool {
    match *method {
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE => {
            !is_data_plane_write_guard_exempt(method, path)
        }
        _ => false,
    }
}

fn is_data_plane_write_guard_exempt(method: &Method, path: &str) -> bool {
    if *method != Method::POST {
        return false;
    }
    if path.starts_with("/api/embed/sessions/") && path.ends_with("/runs/data") {
        return true;
    }
    matches!(
        path,
        // Read-style POST endpoints that accept large/filter payloads.
        "/api/metrics/series"
            | "/api/workspace-view-data"
            // BYOC setup writes customer-owned storage configuration and is
            // intentionally outside the managed-cell writer lease.
            | "/api/storage/clickhouse-connections/validate"
            | "/api/storage/clickhouse-connections"
            | "/api/storage/clickhouse-connections/rotate-credentials"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_guard_applies_to_data_mutation_routes() {
        assert!(requires_data_plane_write_guard(&Method::POST, "/runs"));
        assert!(requires_data_plane_write_guard(
            &Method::POST,
            "/runs/00000000-0000-0000-0000-000000000001/metrics"
        ));
        assert!(requires_data_plane_write_guard(
            &Method::PATCH,
            "/runs/00000000-0000-0000-0000-000000000001"
        ));
        // Client-run-id creation and the Idempotency-Key-carrying object /
        // artifact-upload routes must all be fenced by the writer lease.
        assert!(requires_data_plane_write_guard(
            &Method::POST,
            "/api/runs/00000000-0000-0000-0000-000000000001/objects"
        ));
        assert!(requires_data_plane_write_guard(
            &Method::POST,
            "/api/runs/00000000-0000-0000-0000-000000000001/artifacts/upload"
        ));
        assert!(requires_data_plane_write_guard(
            &Method::POST,
            "/api/artifact-uploads/00000000-0000-0000-0000-000000000001/complete"
        ));
        assert!(requires_data_plane_write_guard(
            &Method::DELETE,
            "/api/reports/00000000-0000-0000-0000-000000000001"
        ));
    }

    #[test]
    fn write_guard_fails_safe_for_new_mutating_data_routes() {
        assert!(requires_data_plane_write_guard(
            &Method::POST,
            "/api/future-data-mutation"
        ));
        assert!(requires_data_plane_write_guard(
            &Method::PUT,
            "/api/future-data-mutation"
        ));
        assert!(requires_data_plane_write_guard(
            &Method::PATCH,
            "/api/future-data-mutation"
        ));
        assert!(requires_data_plane_write_guard(
            &Method::DELETE,
            "/api/future-data-mutation"
        ));
    }

    #[test]
    fn write_guard_skips_reads_and_read_style_posts() {
        assert!(!requires_data_plane_write_guard(&Method::GET, "/runs"));
        assert!(!requires_data_plane_write_guard(
            &Method::HEAD,
            "/api/overview"
        ));
        assert!(!requires_data_plane_write_guard(
            &Method::OPTIONS,
            "/api/runs/00000000-0000-0000-0000-000000000001/logs"
        ));
        assert!(!requires_data_plane_write_guard(
            &Method::POST,
            "/api/metrics/series"
        ));
        assert!(!requires_data_plane_write_guard(
            &Method::POST,
            "/api/workspace-view-data"
        ));
        assert!(!requires_data_plane_write_guard(
            &Method::POST,
            "/api/embed/sessions/018faabb-0000-7000-9000-000000000001/runs/data"
        ));
        assert!(!requires_data_plane_write_guard(
            &Method::POST,
            "/api/storage/clickhouse-connections/validate"
        ));
        assert!(!requires_data_plane_write_guard(
            &Method::POST,
            "/api/storage/clickhouse-connections"
        ));
        assert!(!requires_data_plane_write_guard(
            &Method::POST,
            "/api/storage/clickhouse-connections/rotate-credentials"
        ));
    }
}
