use std::sync::Arc;

use axum::{body::Bytes, extract::State, http::HeaderMap, Json};
use serde_json::{json, Value};

use crate::{
    domain::{
        BillingCancelRequest, BillingCheckoutRequest, BillingCheckoutSyncRequest,
        BillingPlanChangeRequest, BillingPortalRequest, BillingSeatChangeRequest,
    },
    errors::{AppError, AppResult},
    store,
};

use super::super::AppState;
use super::helpers::{context, header_text, read_json, read_json_value, validate_mutation_origin};

#[utoipa::path(
    get,
    path = "/api/billing/status",
    tag = "billing",
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Billing account projection and plan catalog", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Authentication required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn billing_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let ctx = context(&state, &headers, false).await?;
    Ok(Json(store::billing_status(&state.store, &ctx).await?))
}

#[utoipa::path(
    post,
    path = "/api/billing/checkout",
    tag = "billing",
    request_body = crate::domain::BillingCheckoutRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Stripe Checkout Session URL", body = crate::http::openapi::JsonObjectResponse),
        (status = 402, description = "Payment required", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn billing_checkout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    let ctx = context(&state, &headers, false).await?;
    let input = read_json::<BillingCheckoutRequest>(&headers, bytes, state.config.max_body_bytes)?;
    let checkout =
        store::create_billing_checkout(&state.store, &state.config.billing, &ctx, input).await?;
    Ok(Json(json!({ "checkout": checkout })))
}

#[utoipa::path(
    post,
    path = "/api/billing/checkout/sync",
    tag = "billing",
    request_body = crate::domain::BillingCheckoutSyncRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Updated billing projection", body = crate::http::openapi::JsonObjectResponse),
    ),
)]
pub async fn billing_checkout_sync(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    let ctx = context(&state, &headers, false).await?;
    let input =
        read_json::<BillingCheckoutSyncRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::sync_checkout_session(&state.store, &state.config.billing, &ctx, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/billing/portal",
    tag = "billing",
    request_body = crate::domain::BillingPortalRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Stripe Customer Portal URL", body = crate::http::openapi::JsonObjectResponse),
    ),
)]
pub async fn billing_portal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    let ctx = context(&state, &headers, false).await?;
    let input = read_json::<BillingPortalRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::create_billing_portal(&state.store, &state.config.billing, &ctx, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/billing/change-plan",
    tag = "billing",
    request_body = crate::domain::BillingPlanChangeRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Plan change result or Checkout URL", body = crate::http::openapi::JsonObjectResponse),
    ),
)]
pub async fn billing_change_plan(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    let ctx = context(&state, &headers, false).await?;
    let input =
        read_json::<BillingPlanChangeRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::change_billing_plan(&state.store, &state.config.billing, &ctx, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/billing/add-seat",
    tag = "billing",
    request_body = crate::domain::BillingSeatChangeRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Seat reservation or billing result", body = crate::http::openapi::JsonObjectResponse),
    ),
)]
pub async fn billing_add_seat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    let ctx = context(&state, &headers, false).await?;
    let input =
        read_json::<BillingSeatChangeRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::add_billing_seat(&state.store, &state.config.billing, &ctx, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/billing/cancel",
    tag = "billing",
    request_body = crate::domain::BillingCancelRequest,
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Cancellation request result", body = crate::http::openapi::JsonObjectResponse),
    ),
)]
pub async fn billing_cancel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    let ctx = context(&state, &headers, false).await?;
    let input = read_json::<BillingCancelRequest>(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::cancel_billing(&state.store, &state.config.billing, &ctx, input).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/billing/storage-overage/report",
    tag = "billing",
    security(("browserSession" = [])),
    responses(
        (status = 200, description = "Storage overage meter-event report", body = crate::http::openapi::JsonObjectResponse),
    ),
)]
pub async fn billing_report_storage_overage(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    validate_mutation_origin(&state, &headers)?;
    let ctx = context(&state, &headers, false).await?;
    Ok(Json(
        store::report_storage_overage(&state.store, &state.config.billing, &ctx).await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/billing/webhook",
    tag = "billing",
    request_body = serde_json::Value,
    security(),
    responses(
        (status = 200, description = "Webhook processing result", body = crate::http::openapi::JsonObjectResponse),
        (status = 401, description = "Invalid Stripe signature", body = crate::http::openapi::ErrorResponse),
    ),
)]
pub async fn billing_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> AppResult<Json<Value>> {
    let secret = state
        .config
        .billing
        .stripe_webhook_secret
        .as_deref()
        .ok_or_else(|| {
            AppError::with_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "billing_unavailable",
                "STRIPE_WEBHOOK_SECRET is not configured",
            )
        })?;
    let signature = header_text(&headers, "stripe-signature")
        .ok_or_else(|| AppError::unauthorized("missing Stripe-Signature"))?;
    crate::stripe_billing::verify_webhook_signature(&bytes, signature, secret, 300)?;
    let event = read_json_value(&headers, bytes, state.config.max_body_bytes)?;
    Ok(Json(
        store::process_stripe_webhook(&state.store, event).await?,
    ))
}
