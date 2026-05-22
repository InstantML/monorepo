use std::collections::HashMap;
use std::sync::Arc;

use axum::{extract::State, http::HeaderMap, Json};
use serde_json::Value;

use crate::{errors::AppResult, store};

use super::super::AppState;
use super::helpers::{context, require_scope};

#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct MetricsSeriesRequest {
    pub key: String,
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub start_step: Option<f64>,
    #[serde(default)]
    pub end_step: Option<f64>,
    /// Optional M4 downsampling bucket count.
    ///
    /// When present and the series has more than `4 * buckets` points, the
    /// response uses M4 aggregation (Jugel et al., 2014) instead of a naive
    /// prefix limit. The rendered line through the resulting points is
    /// pixel-identical to the chart through all raw points. Value must be
    /// between 1 and 4096 inclusive. Ignored when `start_step` or `end_step`
    /// is set (zoomed views use the raw path). When absent the existing
    /// prefix-limited behaviour is unchanged.
    #[serde(default)]
    pub buckets: Option<u32>,
}

#[utoipa::path(
    post,
    path = "/api/metrics/series",
    tag = "runs",
    request_body = MetricsSeriesRequest,
    security(("bearerApiKey" = []), ("browserSession" = [])),
    responses(
        (status = 200, description = "Per-run metric series keyed by run_id", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn metrics_series(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<MetricsSeriesRequest>,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, true).await?;
    require_scope(&ctx, "export:read", &state)?;
    let mut query = HashMap::new();
    query.insert("key".to_string(), body.key);
    query.insert("run_ids".to_string(), body.run_ids.join(","));
    if let Some(limit) = body.limit {
        query.insert("limit".to_string(), limit.to_string());
    }
    if let Some(start) = body.start_step {
        query.insert("start_step".to_string(), start.to_string());
    }
    if let Some(end) = body.end_step {
        query.insert("end_step".to_string(), end.to_string());
    }
    if let Some(b) = body.buckets {
        query.insert("buckets".to_string(), b.to_string());
    }
    Ok(Json(
        store::metrics_series_batched(&state.store, &ctx, &query).await?,
    ))
}
