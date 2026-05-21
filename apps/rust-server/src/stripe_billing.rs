use axum::http::StatusCode;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Method;
use serde_json::Value;
use sha2::Sha256;

use crate::{
    config::BillingConfig,
    domain::{PLAN_PREMIUM, PLAN_PRO},
    errors::{AppError, AppResult},
};

type HmacSha256 = Hmac<Sha256>;

const STRIPE_API_BASE: &str = "https://api.stripe.com";
const PRO_LOOKUP_KEY: &str = "instantml_pro_monthly";
const PREMIUM_LOOKUP_KEY: &str = "instantml_premium_monthly";
const EXTRA_SEAT_LOOKUP_KEY: &str = "instantml_extra_seat_monthly";
const STORAGE_LOOKUP_KEY: &str = "instantml_storage_overage_gib_month";

#[derive(Clone, Debug)]
pub struct StripeCheckoutSession {
    pub id: String,
    pub url: Option<String>,
    pub customer_id: Option<String>,
    pub subscription_id: Option<String>,
    pub payment_status: Option<String>,
    pub status: Option<String>,
    pub metadata: Value,
}

#[derive(Clone, Debug)]
pub struct StripePortalSession {
    pub url: String,
}

#[derive(Clone, Debug)]
pub struct StripeSubscription {
    pub id: String,
    pub customer_id: Option<String>,
    pub status: Option<String>,
    pub current_period_start: Option<i64>,
    pub current_period_end: Option<i64>,
    pub cancel_at_period_end: bool,
    pub metadata: Value,
    pub items: Vec<StripeSubscriptionItem>,
    pub raw: Value,
}

#[derive(Clone, Debug)]
pub struct StripeSubscriptionItem {
    pub id: String,
    pub price_id: Option<String>,
    pub lookup_key: Option<String>,
    pub usage_type: Option<String>,
    pub quantity: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct SubscriptionCheckoutParams {
    pub customer_id: Option<String>,
    pub customer_email: Option<String>,
    pub org_id: String,
    pub user_id: String,
    pub intent_id: String,
    pub action: String,
    pub target_plan_tier: String,
    pub success_url: String,
    pub cancel_url: String,
}

pub async fn create_subscription_checkout(
    config: &BillingConfig,
    params: SubscriptionCheckoutParams,
) -> AppResult<StripeCheckoutSession> {
    let price_id = ensure_plan_price_id(config, &params.target_plan_tier).await?;
    let storage_price_id = ensure_storage_overage_price_id(config).await?;
    let mut form = vec![
        ("mode".to_string(), "subscription".to_string()),
        ("client_reference_id".to_string(), params.intent_id.clone()),
        ("success_url".to_string(), params.success_url),
        ("cancel_url".to_string(), params.cancel_url),
        ("line_items[0][price]".to_string(), price_id),
        ("line_items[0][quantity]".to_string(), "1".to_string()),
        ("line_items[1][price]".to_string(), storage_price_id),
        ("metadata[org_id]".to_string(), params.org_id.clone()),
        ("metadata[user_id]".to_string(), params.user_id.clone()),
        ("metadata[intent_id]".to_string(), params.intent_id.clone()),
        ("metadata[action]".to_string(), params.action.clone()),
        (
            "metadata[target_plan_tier]".to_string(),
            params.target_plan_tier.clone(),
        ),
        (
            "subscription_data[metadata][org_id]".to_string(),
            params.org_id,
        ),
        (
            "subscription_data[metadata][user_id]".to_string(),
            params.user_id,
        ),
        (
            "subscription_data[metadata][intent_id]".to_string(),
            params.intent_id,
        ),
        (
            "subscription_data[metadata][action]".to_string(),
            params.action,
        ),
        (
            "subscription_data[metadata][target_plan_tier]".to_string(),
            params.target_plan_tier,
        ),
    ];
    if let Some(customer_id) = params.customer_id {
        form.push(("customer".to_string(), customer_id));
    } else if let Some(email) = params.customer_email {
        form.push(("customer_email".to_string(), email));
    }
    let value = post_form(config, "/v1/checkout/sessions", form).await?;
    checkout_from_value(value)
}

pub async fn retrieve_checkout_session(
    config: &BillingConfig,
    session_id: &str,
) -> AppResult<StripeCheckoutSession> {
    let value = get_json(
        config,
        &format!("/v1/checkout/sessions/{session_id}"),
        vec![
            ("expand[]".to_string(), "subscription".to_string()),
            ("expand[]".to_string(), "customer".to_string()),
        ],
    )
    .await?;
    checkout_from_value(value)
}

pub async fn create_portal_session(
    config: &BillingConfig,
    customer_id: &str,
    return_url: &str,
) -> AppResult<StripePortalSession> {
    let value = post_form(
        config,
        "/v1/billing_portal/sessions",
        vec![
            ("customer".to_string(), customer_id.to_string()),
            ("return_url".to_string(), return_url.to_string()),
        ],
    )
    .await?;
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("Stripe portal session did not include url"))?;
    Ok(StripePortalSession {
        url: url.to_string(),
    })
}

pub async fn retrieve_subscription(
    config: &BillingConfig,
    subscription_id: &str,
) -> AppResult<StripeSubscription> {
    let value = get_json(
        config,
        &format!("/v1/subscriptions/{subscription_id}"),
        vec![("expand[]".to_string(), "items.data.price".to_string())],
    )
    .await?;
    subscription_from_value(value)
}

pub async fn update_subscription_plan(
    config: &BillingConfig,
    subscription_id: &str,
    target_plan_tier: &str,
    org_id: &str,
    user_id: &str,
) -> AppResult<StripeSubscription> {
    let subscription = retrieve_subscription(config, subscription_id).await?;
    let plan_item = subscription
        .items
        .iter()
        .find(|item| is_plan_price(config, item))
        .or_else(|| {
            subscription.items.iter().find(|item| {
                item.usage_type
                    .as_deref()
                    .is_none_or(|usage_type| usage_type != "metered")
            })
        })
        .ok_or_else(|| AppError::validation("Stripe subscription has no editable plan item"))?;
    let price_id = ensure_plan_price_id(config, target_plan_tier).await?;
    let storage_price_id = ensure_storage_overage_price_id(config).await?;
    let mut form = vec![
        ("items[0][id]".to_string(), plan_item.id.clone()),
        ("items[0][price]".to_string(), price_id),
        ("items[0][quantity]".to_string(), "1".to_string()),
        (
            "proration_behavior".to_string(),
            "always_invoice".to_string(),
        ),
        (
            "payment_behavior".to_string(),
            "allow_incomplete".to_string(),
        ),
        ("metadata[org_id]".to_string(), org_id.to_string()),
        ("metadata[user_id]".to_string(), user_id.to_string()),
        (
            "metadata[target_plan_tier]".to_string(),
            target_plan_tier.to_string(),
        ),
    ];
    if !subscription.items.iter().any(|item| {
        item.price_id.as_deref() == Some(storage_price_id.as_str())
            || item.lookup_key.as_deref() == Some(STORAGE_LOOKUP_KEY)
    }) {
        form.push(("items[1][price]".to_string(), storage_price_id));
    }
    let value = post_form(
        config,
        &format!("/v1/subscriptions/{subscription_id}"),
        form,
    )
    .await?;
    subscription_from_value(value)
}

pub async fn update_subscription_extra_seats(
    config: &BillingConfig,
    subscription_id: &str,
    extra_seats: i32,
) -> AppResult<StripeSubscription> {
    if extra_seats < 0 {
        return Err(AppError::validation("extra seats cannot be negative"));
    }
    let subscription = retrieve_subscription(config, subscription_id).await?;
    let extra_price_id = ensure_extra_seat_price_id(config).await?;
    let existing_extra_item = subscription
        .items
        .iter()
        .find(|item| item.price_id.as_deref() == Some(extra_price_id.as_str()))
        .or_else(|| {
            subscription
                .items
                .iter()
                .find(|item| item.lookup_key.as_deref() == Some(EXTRA_SEAT_LOOKUP_KEY))
        });
    let mut form = vec![
        (
            "proration_behavior".to_string(),
            "always_invoice".to_string(),
        ),
        (
            "payment_behavior".to_string(),
            "allow_incomplete".to_string(),
        ),
        (
            "metadata[paid_extra_seats]".to_string(),
            extra_seats.to_string(),
        ),
    ];
    if let Some(item) = existing_extra_item {
        form.push(("items[0][id]".to_string(), item.id.clone()));
        if extra_seats == 0 {
            form.push(("items[0][deleted]".to_string(), "true".to_string()));
        } else {
            form.push(("items[0][price]".to_string(), extra_price_id));
            form.push(("items[0][quantity]".to_string(), extra_seats.to_string()));
        }
    } else if extra_seats > 0 {
        form.push(("items[0][price]".to_string(), extra_price_id));
        form.push(("items[0][quantity]".to_string(), extra_seats.to_string()));
    }
    let value = post_form(
        config,
        &format!("/v1/subscriptions/{subscription_id}"),
        form,
    )
    .await?;
    subscription_from_value(value)
}

pub async fn cancel_subscription(
    config: &BillingConfig,
    subscription_id: &str,
    at_period_end: bool,
) -> AppResult<StripeSubscription> {
    let value = if at_period_end {
        post_form(
            config,
            &format!("/v1/subscriptions/{subscription_id}"),
            vec![("cancel_at_period_end".to_string(), "true".to_string())],
        )
        .await?
    } else {
        request_form(
            config,
            Method::DELETE,
            &format!("/v1/subscriptions/{subscription_id}"),
            vec![
                ("invoice_now".to_string(), "true".to_string()),
                ("prorate".to_string(), "true".to_string()),
            ],
        )
        .await?
    };
    subscription_from_value(value)
}

pub async fn record_storage_meter_event(
    config: &BillingConfig,
    customer_id: &str,
    org_id: &str,
    value: i64,
    identifier: &str,
    timestamp: i64,
) -> AppResult<String> {
    let response = post_form(
        config,
        "/v1/billing/meter_events",
        vec![
            (
                "event_name".to_string(),
                config.storage_meter_event_name.clone(),
            ),
            ("identifier".to_string(), identifier.to_string()),
            ("timestamp".to_string(), timestamp.to_string()),
            (
                "payload[stripe_customer_id]".to_string(),
                customer_id.to_string(),
            ),
            ("payload[value]".to_string(), value.to_string()),
            ("payload[org_id]".to_string(), org_id.to_string()),
        ],
    )
    .await?;
    response
        .get("identifier")
        .and_then(Value::as_str)
        .or_else(|| response.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| AppError::internal("Stripe meter event did not include an identifier"))
}

pub async fn ensure_plan_price_id(config: &BillingConfig, plan_tier: &str) -> AppResult<String> {
    match plan_tier {
        "pro" => {
            if let Some(id) = &config.pro_price_id {
                return Ok(id.clone());
            }
            ensure_lookup_price(
                config,
                PRO_LOOKUP_KEY,
                PLAN_PRO.label,
                PLAN_PRO.monthly_base_usd * 100,
                false,
            )
            .await
        }
        "premium" => {
            if let Some(id) = &config.premium_price_id {
                return Ok(id.clone());
            }
            ensure_lookup_price(
                config,
                PREMIUM_LOOKUP_KEY,
                PLAN_PREMIUM.label,
                PLAN_PREMIUM.monthly_base_usd * 100,
                false,
            )
            .await
        }
        _ => Err(AppError::validation(
            "paid plan_tier must be pro or premium",
        )),
    }
}

pub async fn ensure_extra_seat_price_id(config: &BillingConfig) -> AppResult<String> {
    if let Some(id) = &config.extra_seat_price_id {
        return Ok(id.clone());
    }
    ensure_lookup_price(
        config,
        EXTRA_SEAT_LOOKUP_KEY,
        "InstantML extra writer seat",
        config.extra_seat_monthly_usd * 100,
        false,
    )
    .await
}

pub async fn ensure_storage_overage_price_id(config: &BillingConfig) -> AppResult<String> {
    if let Some(id) = &config.storage_overage_price_id {
        return Ok(id.clone());
    }
    ensure_lookup_price(
        config,
        STORAGE_LOOKUP_KEY,
        "InstantML retained storage overage GiB-month",
        config.storage_overage_cents_per_gib_month,
        true,
    )
    .await
}

async fn ensure_lookup_price(
    config: &BillingConfig,
    lookup_key: &str,
    product_name: &str,
    unit_amount_cents: i64,
    metered: bool,
) -> AppResult<String> {
    let existing = get_json(
        config,
        "/v1/prices",
        vec![
            ("active".to_string(), "true".to_string()),
            ("lookup_keys[]".to_string(), lookup_key.to_string()),
            ("limit".to_string(), "1".to_string()),
        ],
    )
    .await?;
    if let Some(id) = existing
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
    {
        return Ok(id.to_string());
    }
    let mut form = vec![
        ("currency".to_string(), "usd".to_string()),
        ("unit_amount".to_string(), unit_amount_cents.to_string()),
        ("recurring[interval]".to_string(), "month".to_string()),
        ("product_data[name]".to_string(), product_name.to_string()),
        ("lookup_key".to_string(), lookup_key.to_string()),
    ];
    if metered {
        let meter_id = ensure_storage_meter_id(config).await?;
        form.push(("recurring[meter]".to_string(), meter_id));
        form.push(("recurring[usage_type]".to_string(), "metered".to_string()));
    }
    let created = post_form(config, "/v1/prices", form).await?;
    created
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::internal("Stripe price creation did not include id"))
}

async fn ensure_storage_meter_id(config: &BillingConfig) -> AppResult<String> {
    if let Some(id) = &config.storage_meter_id {
        return Ok(id.clone());
    }
    let meters = get_json(
        config,
        "/v1/billing/meters",
        vec![("limit".to_string(), "100".to_string())],
    )
    .await?;
    if let Some(id) = meters
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("event_name").and_then(Value::as_str)
                    == Some(config.storage_meter_event_name.as_str())
                    && item.get("status").and_then(Value::as_str) == Some("active")
            })
        })
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
    {
        return Ok(id.to_string());
    }
    let created = post_form(
        config,
        "/v1/billing/meters",
        vec![
            (
                "display_name".to_string(),
                "InstantML retained storage overage GiB-month".to_string(),
            ),
            (
                "event_name".to_string(),
                config.storage_meter_event_name.clone(),
            ),
            (
                "default_aggregation[formula]".to_string(),
                "sum".to_string(),
            ),
            (
                "value_settings[event_payload_key]".to_string(),
                "value".to_string(),
            ),
            ("customer_mapping[type]".to_string(), "by_id".to_string()),
            (
                "customer_mapping[event_payload_key]".to_string(),
                "stripe_customer_id".to_string(),
            ),
        ],
    )
    .await?;
    created
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::internal("Stripe meter creation did not include id"))
}

pub fn verify_webhook_signature(
    payload: &[u8],
    signature_header: &str,
    secret: &str,
    tolerance_seconds: i64,
) -> AppResult<()> {
    let mut timestamp = None;
    let mut signatures = Vec::new();
    for item in signature_header.split(',') {
        let Some((key, value)) = item.split_once('=') else {
            continue;
        };
        match key {
            "t" => timestamp = value.parse::<i64>().ok(),
            "v1" => signatures.push(value),
            _ => {}
        }
    }
    let timestamp = timestamp.ok_or_else(|| AppError::unauthorized("missing Stripe timestamp"))?;
    if (Utc::now().timestamp() - timestamp).abs() > tolerance_seconds {
        return Err(AppError::unauthorized("Stripe webhook timestamp is stale"));
    }
    let signed_payload = format!("{timestamp}.{}", String::from_utf8_lossy(payload));
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| AppError::internal("invalid Stripe webhook secret"))?;
    mac.update(signed_payload.as_bytes());
    let expected = mac.finalize().into_bytes();
    let matched = signatures.into_iter().any(|candidate| {
        hex::decode(candidate)
            .ok()
            .is_some_and(|actual| constant_time_eq(&actual, expected.as_slice()))
    });
    if matched {
        Ok(())
    } else {
        Err(AppError::unauthorized("invalid Stripe webhook signature"))
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn checkout_from_value(value: Value) -> AppResult<StripeCheckoutSession> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("Stripe Checkout Session did not include id"))?;
    let customer_id = stripe_id_field(&value, "customer");
    let subscription_id = stripe_id_field(&value, "subscription");
    Ok(StripeCheckoutSession {
        id: id.to_string(),
        url: value.get("url").and_then(Value::as_str).map(str::to_string),
        customer_id,
        subscription_id,
        payment_status: value
            .get("payment_status")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string),
        metadata: value.get("metadata").cloned().unwrap_or(Value::Null),
    })
}

fn subscription_from_value(value: Value) -> AppResult<StripeSubscription> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::internal("Stripe Subscription did not include id"))?;
    let items = value
        .pointer("/items/data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?;
                    let price = item.get("price");
                    Some(StripeSubscriptionItem {
                        id: id.to_string(),
                        price_id: price
                            .and_then(|price| price.get("id"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        lookup_key: price
                            .and_then(|price| price.get("lookup_key"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        usage_type: price
                            .and_then(|price| price.pointer("/recurring/usage_type"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        quantity: item.get("quantity").and_then(Value::as_i64),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(StripeSubscription {
        id: id.to_string(),
        customer_id: stripe_id_field(&value, "customer"),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string),
        current_period_start: value.get("current_period_start").and_then(Value::as_i64),
        current_period_end: value.get("current_period_end").and_then(Value::as_i64),
        cancel_at_period_end: value
            .get("cancel_at_period_end")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        metadata: value.get("metadata").cloned().unwrap_or(Value::Null),
        items,
        raw: value,
    })
}

fn is_plan_price(config: &BillingConfig, item: &StripeSubscriptionItem) -> bool {
    item.lookup_key
        .as_deref()
        .is_some_and(|lookup_key| lookup_key == PRO_LOOKUP_KEY || lookup_key == PREMIUM_LOOKUP_KEY)
        || item.price_id.as_deref().is_some_and(|price_id| {
            config.pro_price_id.as_deref() == Some(price_id)
                || config.premium_price_id.as_deref() == Some(price_id)
        })
}

fn stripe_id_field(value: &Value, field: &str) -> Option<String> {
    match value.get(field) {
        Some(Value::String(id)) => Some(id.clone()),
        Some(Value::Object(object)) => object.get("id").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

async fn post_form(
    config: &BillingConfig,
    path: &str,
    form: Vec<(String, String)>,
) -> AppResult<Value> {
    request_form(config, Method::POST, path, form).await
}

async fn request_form(
    config: &BillingConfig,
    method: Method,
    path: &str,
    form: Vec<(String, String)>,
) -> AppResult<Value> {
    let secret = stripe_secret(config)?;
    let response = reqwest::Client::new()
        .request(method, format!("{STRIPE_API_BASE}{path}"))
        .bearer_auth(secret)
        .header("Stripe-Version", &config.stripe_api_version)
        .form(&form)
        .send()
        .await
        .map_err(|error| stripe_unavailable(format!("Stripe request failed: {error}")))?;
    parse_stripe_response(response).await
}

async fn get_json(
    config: &BillingConfig,
    path: &str,
    query: Vec<(String, String)>,
) -> AppResult<Value> {
    let secret = stripe_secret(config)?;
    let response = reqwest::Client::new()
        .get(format!("{STRIPE_API_BASE}{path}"))
        .bearer_auth(secret)
        .header("Stripe-Version", &config.stripe_api_version)
        .query(&query)
        .send()
        .await
        .map_err(|error| stripe_unavailable(format!("Stripe request failed: {error}")))?;
    parse_stripe_response(response).await
}

async fn parse_stripe_response(response: reqwest::Response) -> AppResult<Value> {
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| stripe_unavailable("Stripe returned invalid JSON"))?;
    if status.is_success() {
        return Ok(value);
    }
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("Stripe request failed");
    Err(AppError::with_code(
        StatusCode::BAD_GATEWAY,
        "stripe_error",
        message,
    ))
}

fn stripe_secret(config: &BillingConfig) -> AppResult<&str> {
    if !config.enabled {
        return Err(stripe_unavailable("billing is not enabled"));
    }
    config
        .stripe_secret_key
        .as_deref()
        .ok_or_else(|| stripe_unavailable("STRIPE_SECRET_KEY is not configured"))
}

fn stripe_unavailable(message: impl Into<String>) -> AppError {
    AppError::with_code(
        StatusCode::SERVICE_UNAVAILABLE,
        "billing_unavailable",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmac::{Hmac, Mac};

    #[test]
    fn verifies_valid_webhook_signature() {
        let secret = "whsec_test";
        let payload = br#"{"id":"evt_123"}"#;
        let timestamp = Utc::now().timestamp();
        let signed_payload = format!("{timestamp}.{}", String::from_utf8_lossy(payload));
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(signed_payload.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        let header = format!("t={timestamp},v1={signature}");
        assert!(verify_webhook_signature(payload, &header, secret, 300).is_ok());
    }

    #[test]
    fn rejects_invalid_webhook_signature() {
        let secret = "whsec_test";
        let timestamp = Utc::now().timestamp();
        let header = format!("t={timestamp},v1=deadbeef");
        assert!(verify_webhook_signature(br#"{}"#, &header, secret, 300).is_err());
    }
}
