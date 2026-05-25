use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde_json::json;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{domain::PlanTier, store};

use super::{handlers::helpers, AppState};

const UNAUTH_RATE_LIMIT_RPS: u32 = 25;
const UNAUTH_RATE_LIMIT_BURST: u32 = 100;
const MAX_BUCKETS_BEFORE_PRUNE: usize = 20_000;
const BUCKET_IDLE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
pub struct RateLimiter {
    buckets: Arc<Mutex<HashMap<String, BucketState>>>,
    instance_id: Arc<str>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: Arc::new(Mutex::new(HashMap::new())),
            instance_id: instance_id().into(),
        }
    }

    fn instance_id(&self) -> &str {
        &self.instance_id
    }

    async fn check(&self, key: String, limit: RateLimitSpec, now: Instant) -> RateLimitDecision {
        let mut buckets = self.buckets.lock().await;
        if buckets.len() > MAX_BUCKETS_BEFORE_PRUNE {
            buckets.retain(|_, bucket| {
                now.saturating_duration_since(bucket.last_refill) <= BUCKET_IDLE_TTL
            });
        }
        let bucket = buckets.entry(key).or_insert_with(|| BucketState {
            tokens: limit.burst as f64,
            last_refill: now,
        });
        bucket.refill(limit, now);
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            return RateLimitDecision {
                allowed: true,
                limit,
                remaining: bucket.tokens.floor() as u32,
                retry_after: Duration::ZERO,
            };
        }
        let retry_after = if limit.rps == 0 {
            Duration::from_secs(60)
        } else {
            let needed = 1.0 - bucket.tokens;
            Duration::from_secs_f64((needed / limit.rps as f64).max(0.001))
        };
        RateLimitDecision {
            allowed: false,
            limit,
            remaining: 0,
            retry_after,
        }
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestClass {
    General,
    Ingest,
}

impl RequestClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Ingest => "ingest",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteLimitPolicy {
    class: RequestClass,
    metered: bool,
    monthly_enforced: bool,
}

#[derive(Clone, Copy)]
struct RateLimitSpec {
    rps: u32,
    burst: u32,
}

#[derive(Clone, Copy)]
struct RateLimitDecision {
    allowed: bool,
    limit: RateLimitSpec,
    remaining: u32,
    retry_after: Duration,
}

struct BucketState {
    tokens: f64,
    last_refill: Instant,
}

impl BucketState {
    fn refill(&mut self, limit: RateLimitSpec, now: Instant) {
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.tokens = (self.tokens + elapsed * limit.rps as f64).min(limit.burst as f64);
        self.last_refill = now;
    }
}

pub async fn data_plane_rate_limit(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(policy) = classify_route(request.method(), request.uri().path()) else {
        return next.run(request).await;
    };

    let now = Instant::now();
    let unauth_key = format!("unauth:{}", unauthenticated_rate_key(request.headers()));
    let unauth_decision = state
        .rate_limiter
        .check(
            unauth_key,
            RateLimitSpec {
                rps: UNAUTH_RATE_LIMIT_RPS,
                burst: UNAUTH_RATE_LIMIT_BURST,
            },
            now,
        )
        .await;
    if !unauth_decision.allowed {
        return rate_limited_response("unauthenticated", unauth_decision);
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

    let plan = match store::plan_for_org(&state.store, ctx.org_id).await {
        Ok(plan) => plan,
        Err(error) => return error.into_response(),
    };
    let org_decision = state
        .rate_limiter
        .check(
            org_rate_key(ctx.org_id, policy.class),
            plan_limit(plan, policy.class),
            now,
        )
        .await;
    if !org_decision.allowed {
        return rate_limited_response(policy.class.as_str(), org_decision);
    }

    if policy.metered && policy.monthly_enforced {
        match store::api_request_monthly_quota(&state.store, ctx.org_id).await {
            Ok(monthly) if !monthly.allowed => {
                return monthly_rate_limited_response(policy.class.as_str(), monthly);
            }
            Ok(_) => {}
            Err(error) => return error.into_response(),
        }
    }

    let mut response = next.run(request).await;
    add_rate_limit_headers(response.headers_mut(), org_decision, "second");
    if policy.metered && !response.status().is_server_error() {
        if let Err(error) = store::record_api_request_usage(
            &state.store,
            ctx.org_id,
            policy.class.as_str(),
            state.rate_limiter.instance_id(),
        )
        .await
        {
            tracing::warn!(
                error = %error.message(),
                org_id = %ctx.org_id,
                class = policy.class.as_str(),
                "api request usage rollup persist failed"
            );
        }
    }
    response
}

fn classify_route(method: &Method, path: &str) -> Option<RouteLimitPolicy> {
    if method == Method::OPTIONS {
        return None;
    }
    let class = if is_ingest_route(method, path) {
        RequestClass::Ingest
    } else {
        RequestClass::General
    };
    Some(RouteLimitPolicy {
        class,
        metered: true,
        monthly_enforced: !is_monthly_quota_exempt_route(method, path),
    })
}

fn is_ingest_route(method: &Method, path: &str) -> bool {
    matches!(
        (method.as_str(), path),
        ("POST", "/projects")
            | ("POST", "/runs")
            | ("POST", "/api/demo/reset")
            | ("POST", "/api/imports/neptune")
            | ("POST", "/api/imports/wandb")
            | ("POST", "/api/imports/mlflow")
            | ("POST", "/api/storage/clickhouse-connections")
            | ("POST", "/api/storage/clickhouse-connections/validate")
            | (
                "POST",
                "/api/storage/clickhouse-connections/rotate-credentials"
            )
    ) || (*method == Method::PATCH && path.starts_with("/runs/"))
        || (*method == Method::POST && path.starts_with("/api/runs/") && path.ends_with("/forks"))
        || (*method == Method::POST
            && (path.ends_with("/metrics")
                || path.ends_with("/rank-metrics")
                || path.ends_with("/logs")
                || path.ends_with("/attributes")
                || path.ends_with("/objects")
                || path.ends_with("/artifacts")
                || path.ends_with("/artifacts/upload")))
}

fn is_monthly_quota_exempt_route(method: &Method, path: &str) -> bool {
    *method == Method::GET && matches!(path, "/api/usage" | "/api/usage/export")
}

fn plan_limit(plan: PlanTier, class: RequestClass) -> RateLimitSpec {
    match class {
        RequestClass::General => RateLimitSpec {
            rps: plan.rate_limit_rps,
            burst: plan.rate_limit_burst,
        },
        RequestClass::Ingest => RateLimitSpec {
            rps: plan.ingest_rate_limit_rps,
            burst: (plan.ingest_rate_limit_rps.saturating_mul(5)).min(plan.rate_limit_burst),
        },
    }
}

fn org_rate_key(org_id: Uuid, class: RequestClass) -> String {
    format!("org:{org_id}:{}", class.as_str())
}

fn unauthenticated_rate_key(headers: &HeaderMap) -> String {
    for name in ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] {
        if let Some(raw) = helpers::header_text(headers, name) {
            if let Some(candidate) = raw.split(',').next().map(str::trim) {
                if !candidate.is_empty() {
                    return format!("ip:{candidate}");
                }
            }
        }
    }
    if let Some(raw) = helpers::header_text(headers, "authorization") {
        return format!("auth:{}", stable_fingerprint(raw));
    }
    if let Some(raw) = helpers::session_cookie(headers) {
        return format!("session:{}", stable_fingerprint(raw));
    }
    "unknown".to_string()
}

fn stable_fingerprint(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn rate_limited_response(class: &str, decision: RateLimitDecision) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": format!("rate limit exceeded for {class} API"),
            "code": "rate_limit_exceeded"
        })),
    )
        .into_response();
    add_rate_limit_headers(response.headers_mut(), decision, "second");
    response
}

fn monthly_rate_limited_response(class: &str, quota: store::ApiRequestMonthlyQuota) -> Response {
    let retry_after = monthly_retry_after_secs(quota.reset_at);
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": format!("monthly API request limit exceeded for {class} API"),
            "code": "api_request_monthly_limit_exceeded",
            "usage": quota.current_requests,
            "projected_usage": quota.projected_requests,
            "limit": quota.limit,
            "plan_tier": quota.plan_tier,
            "overage_mode": quota.overage_mode.as_str(),
            "period_start": quota.period_start,
            "reset_at": quota.reset_at
        })),
    )
        .into_response();
    add_monthly_rate_limit_headers(response.headers_mut(), &quota, retry_after);
    response
}

fn add_rate_limit_headers(headers: &mut HeaderMap, decision: RateLimitDecision, scope: &str) {
    insert_header(headers, "x-instantml-ratelimit-scope", scope.to_string());
    insert_header(headers, "ratelimit-limit", decision.limit.rps.to_string());
    insert_header(
        headers,
        "ratelimit-remaining",
        decision.remaining.to_string(),
    );
    insert_header(
        headers,
        "ratelimit-reset",
        retry_after_secs(decision.retry_after).to_string(),
    );
    if !decision.allowed {
        insert_header(
            headers,
            header::RETRY_AFTER.as_str(),
            retry_after_secs(decision.retry_after).to_string(),
        );
    }
}

fn add_monthly_rate_limit_headers(
    headers: &mut HeaderMap,
    quota: &store::ApiRequestMonthlyQuota,
    retry_after: u64,
) {
    insert_header(
        headers,
        "x-instantml-ratelimit-scope",
        "monthly".to_string(),
    );
    insert_header(headers, "ratelimit-limit", quota.limit.to_string());
    insert_header(
        headers,
        "ratelimit-remaining",
        quota.remaining_after_request.to_string(),
    );
    insert_header(headers, "ratelimit-reset", retry_after.to_string());
    insert_header(
        headers,
        header::RETRY_AFTER.as_str(),
        retry_after.to_string(),
    );
    insert_header(
        headers,
        "x-instantml-monthly-ratelimit-limit",
        quota.limit.to_string(),
    );
    insert_header(
        headers,
        "x-instantml-monthly-ratelimit-remaining",
        quota.remaining_after_request.to_string(),
    );
    insert_header(
        headers,
        "x-instantml-monthly-ratelimit-reset",
        retry_after.to_string(),
    );
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: String) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(&value),
    ) {
        headers.insert(name, value);
    }
}

fn retry_after_secs(duration: Duration) -> u64 {
    duration
        .as_secs()
        .max(u64::from(duration.subsec_nanos() > 0))
}

fn monthly_retry_after_secs(reset_at: chrono::DateTime<Utc>) -> u64 {
    (reset_at - Utc::now()).num_seconds().max(1) as u64
}

fn instance_id() -> String {
    std::env::var("INSTANTML_INSTANCE_ID")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| format!("process-{}", Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{PLAN_FREE, PLAN_PREMIUM, PLAN_PRO};

    #[test]
    fn route_classification_covers_legacy_sdk_and_dashboard_paths() {
        assert_eq!(
            classify_route(&Method::POST, "/runs/run-1/metrics")
                .expect("policy")
                .class,
            RequestClass::Ingest
        );
        assert_eq!(
            classify_route(&Method::POST, "/api/imports/wandb")
                .expect("policy")
                .class,
            RequestClass::Ingest
        );
        assert_eq!(
            classify_route(&Method::POST, "/api/runs/run-1/forks")
                .expect("policy")
                .class,
            RequestClass::Ingest
        );
        assert_eq!(
            classify_route(&Method::GET, "/api/usage")
                .expect("policy")
                .class,
            RequestClass::General
        );
        assert!(classify_route(&Method::OPTIONS, "/api/usage").is_none());
    }

    #[tokio::test]
    async fn token_bucket_observes_burst_and_refill() {
        let limiter = RateLimiter::new();
        let limit = RateLimitSpec { rps: 2, burst: 2 };
        let now = Instant::now();

        assert!(limiter.check("k".to_string(), limit, now).await.allowed);
        assert!(limiter.check("k".to_string(), limit, now).await.allowed);
        let rejected = limiter.check("k".to_string(), limit, now).await;
        assert!(!rejected.allowed);
        assert!(retry_after_secs(rejected.retry_after) >= 1);

        let accepted = limiter
            .check("k".to_string(), limit, now + Duration::from_millis(500))
            .await;
        assert!(accepted.allowed);
    }

    #[tokio::test]
    async fn token_bucket_prunes_idle_keys_after_threshold() {
        let limiter = RateLimiter::new();
        let limit = RateLimitSpec { rps: 1, burst: 1 };
        let now = Instant::now();
        {
            let mut buckets = limiter.buckets.lock().await;
            for index in 0..=MAX_BUCKETS_BEFORE_PRUNE {
                buckets.insert(
                    format!("old-{index}"),
                    BucketState {
                        tokens: 0.0,
                        last_refill: now - BUCKET_IDLE_TTL - Duration::from_secs(1),
                    },
                );
            }
        }

        assert!(limiter.check("fresh".to_string(), limit, now).await.allowed);

        let buckets = limiter.buckets.lock().await;
        assert_eq!(buckets.len(), 1);
        assert!(buckets.contains_key("fresh"));
    }

    #[tokio::test]
    async fn rate_limited_response_has_retry_headers_and_code() {
        let response = rate_limited_response(
            "ingest",
            RateLimitDecision {
                allowed: false,
                limit: RateLimitSpec { rps: 2, burst: 10 },
                remaining: 0,
                retry_after: Duration::from_millis(250),
            },
        );
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["ratelimit-limit"], "2");
        assert_eq!(response.headers()["ratelimit-remaining"], "0");
        assert_eq!(response.headers()["ratelimit-reset"], "1");
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        assert_eq!(response.headers()["x-instantml-ratelimit-scope"], "second");

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "rate_limit_exceeded");
        assert_eq!(payload["error"], "rate limit exceeded for ingest API");
    }

    #[tokio::test]
    async fn monthly_rate_limited_response_has_monthly_reset_headers_and_code() {
        let reset_at = Utc::now() + chrono::Duration::seconds(30);
        let response = monthly_rate_limited_response(
            "general",
            store::ApiRequestMonthlyQuota {
                allowed: false,
                current_requests: 500_000,
                projected_requests: 500_001,
                limit: 500_000,
                remaining_after_request: 0,
                period_start: reset_at - chrono::Duration::days(30),
                reset_at,
                overage_mode: store::ApiRequestOverageMode::Blocked,
                plan_tier: "free".to_string(),
            },
        );
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["x-instantml-ratelimit-scope"], "monthly");
        assert_eq!(response.headers()["ratelimit-limit"], "500000");
        assert_eq!(
            response.headers()["x-instantml-monthly-ratelimit-remaining"],
            "0"
        );
        assert!(response.headers().contains_key(header::RETRY_AFTER));

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["code"], "api_request_monthly_limit_exceeded");
        assert_eq!(payload["overage_mode"], "blocked");
        assert_eq!(payload["limit"], 500_000);
    }

    #[test]
    fn plan_request_limits_match_pricing_model() {
        assert_eq!(PLAN_FREE.api_requests, 500_000);
        assert_eq!(PLAN_PRO.api_requests, 25_000_000);
        assert_eq!(PLAN_PRO.api_request_overage_cents_per_million, Some(200));
        assert_eq!(PLAN_PREMIUM.api_requests, 150_000_000);
        assert_eq!(
            PLAN_PREMIUM.api_request_overage_cents_per_million,
            Some(100)
        );
        assert_eq!(plan_limit(PLAN_FREE, RequestClass::Ingest).rps, 2);
        assert_eq!(plan_limit(PLAN_PRO, RequestClass::General).rps, 50);
    }

    #[test]
    fn pre_auth_bucket_key_uses_proxy_ip_before_auth_fallback() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.10, 10.0.0.1"),
        );
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer instantml_test"),
        );

        assert_eq!(unauthenticated_rate_key(&headers), "ip:203.0.113.10");
    }

    #[test]
    fn pre_auth_bucket_key_separates_local_authenticated_clients() {
        let mut first = HeaderMap::new();
        first.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer one"),
        );
        let mut second = HeaderMap::new();
        second.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer two"),
        );

        assert_ne!(
            unauthenticated_rate_key(&first),
            unauthenticated_rate_key(&second)
        );
        assert!(unauthenticated_rate_key(&first).starts_with("auth:"));
    }
}
