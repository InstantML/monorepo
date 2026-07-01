use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use url::Url;

use crate::{errors::AppResult, AppError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedAuthPrincipal {
    pub provider: String,
    pub provider_subject: String,
    pub email: String,
    pub email_verified: bool,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

pub trait ManagedAuthVerifier {
    fn verify_bearer(&self, token: &str) -> AppResult<ManagedAuthPrincipal>;
}

#[derive(Clone, Debug, Default)]
pub struct DisabledManagedAuth;

impl ManagedAuthVerifier for DisabledManagedAuth {
    fn verify_bearer(&self, _token: &str) -> AppResult<ManagedAuthPrincipal> {
        Err(AppError::unauthorized("managed auth is not configured"))
    }
}

#[derive(Clone, Debug, Deserialize)]
struct ClerkSessionClaims {
    iss: String,
    sub: String,
    sid: String,
    exp: u64,
    iat: u64,
    #[serde(default)]
    nbf: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ClerkUser {
    id: String,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    image_url: Option<String>,
    #[serde(default)]
    primary_email_address_id: Option<String>,
    #[serde(default)]
    email_addresses: Vec<ClerkEmailAddress>,
}

#[derive(Debug, Deserialize)]
struct ClerkEmailAddress {
    id: String,
    email_address: String,
    #[serde(default)]
    verification: Option<ClerkEmailVerification>,
}

#[derive(Debug, Deserialize)]
struct ClerkEmailVerification {
    #[serde(default)]
    status: Option<String>,
}

pub async fn verify_clerk_session_token(
    secret_key: &str,
    api_base: &str,
    expected_issuer: Option<&str>,
    token: &str,
    max_token_age: Duration,
) -> AppResult<ManagedAuthPrincipal> {
    let unsafe_claims = decode_unverified_claims(token)?;
    validate_clerk_claims_shape(&unsafe_claims, expected_issuer)?;
    let header =
        decode_header(token).map_err(|_| AppError::unauthorized("invalid Clerk session token"))?;
    if header.alg != Algorithm::RS256 {
        return Err(AppError::unauthorized("invalid Clerk session token"));
    }
    let kid = header
        .kid
        .ok_or_else(|| AppError::unauthorized("invalid Clerk session token"))?;
    let jwks = fetch_clerk_jwks(secret_key, api_base).await?;
    let jwk = jwks
        .keys
        .iter()
        .find(|candidate| candidate.common.key_id.as_deref() == Some(kid.as_str()))
        .ok_or_else(|| AppError::unauthorized("invalid Clerk session token"))?;
    let key = DecodingKey::from_jwk(jwk)
        .map_err(|_| AppError::unauthorized("invalid Clerk session token"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = 60;
    validation.validate_aud = false;
    if let Some(issuer) = expected_issuer {
        validation.set_issuer(&[issuer]);
    }
    let token = decode::<ClerkSessionClaims>(token, &key, &validation)
        .map_err(|_| AppError::unauthorized("invalid Clerk session token"))?;
    validate_clerk_session_claims(
        &token.claims,
        expected_issuer,
        max_token_age,
        now_epoch_seconds()?,
    )?;
    let user = fetch_clerk_user(secret_key, api_base, &token.claims.sub).await?;
    clerk_user_to_principal(&token.claims, user)
}

async fn fetch_clerk_jwks(secret_key: &str, api_base: &str) -> AppResult<JwkSet> {
    let response = reqwest::Client::new()
        .get(format!("{}/v1/jwks", api_base.trim_end_matches('/')))
        .bearer_auth(secret_key)
        .send()
        .await
        .map_err(|err| AppError::unauthorized(format!("Clerk token verification failed: {err}")))?;
    if !response.status().is_success() {
        return Err(AppError::unauthorized("Clerk token verification failed"));
    }
    response
        .json::<JwkSet>()
        .await
        .map_err(|err| AppError::unauthorized(format!("Clerk token verification failed: {err}")))
}

async fn fetch_clerk_user(secret_key: &str, api_base: &str, user_id: &str) -> AppResult<ClerkUser> {
    let response = reqwest::Client::new()
        .get(format!(
            "{}/v1/users/{}",
            api_base.trim_end_matches('/'),
            user_id
        ))
        .bearer_auth(secret_key)
        .send()
        .await
        .map_err(|err| AppError::unauthorized(format!("Clerk user lookup failed: {err}")))?;
    if !response.status().is_success() {
        return Err(AppError::unauthorized("Clerk user lookup failed"));
    }
    response
        .json::<ClerkUser>()
        .await
        .map_err(|err| AppError::unauthorized(format!("Clerk user lookup failed: {err}")))
}

fn decode_unverified_claims(token: &str) -> AppResult<ClerkSessionClaims> {
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| AppError::unauthorized("invalid Clerk session token"))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload.as_bytes())
        .map_err(|_| AppError::unauthorized("invalid Clerk session token"))?;
    serde_json::from_slice::<ClerkSessionClaims>(&bytes)
        .map_err(|_| AppError::unauthorized("invalid Clerk session token"))
}

fn validate_clerk_claims_shape(
    claims: &ClerkSessionClaims,
    expected_issuer: Option<&str>,
) -> AppResult<()> {
    let issuer =
        Url::parse(&claims.iss).map_err(|_| AppError::unauthorized("invalid Clerk issuer"))?;
    if issuer.scheme() != "https" {
        return Err(AppError::unauthorized("invalid Clerk issuer"));
    }
    if let Some(expected) = expected_issuer {
        if claims.iss != expected {
            return Err(AppError::unauthorized("invalid Clerk issuer"));
        }
    } else {
        let host = issuer.host_str().unwrap_or_default();
        if host != "clerk.com"
            && !host.ends_with(".clerk.com")
            && !host.ends_with(".clerk.accounts.dev")
            && !host.ends_with(".clerk.dev")
        {
            return Err(AppError::unauthorized("invalid Clerk issuer"));
        }
    }
    if claims.sub.trim().is_empty() || claims.sid.trim().is_empty() {
        return Err(AppError::unauthorized("invalid Clerk session token"));
    }
    Ok(())
}

fn validate_clerk_session_claims(
    claims: &ClerkSessionClaims,
    expected_issuer: Option<&str>,
    max_token_age: Duration,
    now: u64,
) -> AppResult<()> {
    validate_clerk_claims_shape(claims, expected_issuer)?;
    if claims.exp + 60 < now {
        return Err(AppError::unauthorized("expired Clerk session token"));
    }
    if let Some(nbf) = claims.nbf {
        if nbf > now + 60 {
            return Err(AppError::unauthorized("invalid Clerk session token"));
        }
    }
    if claims.iat > now + 60 || now.saturating_sub(claims.iat) > max_token_age.as_secs() + 60 {
        return Err(AppError::unauthorized("stale Clerk session token"));
    }
    Ok(())
}

fn clerk_user_to_principal(
    claims: &ClerkSessionClaims,
    user: ClerkUser,
) -> AppResult<ManagedAuthPrincipal> {
    if user.id != claims.sub {
        return Err(AppError::unauthorized("Clerk user mismatch"));
    }
    let email = primary_verified_email(&user)?;
    Ok(ManagedAuthPrincipal {
        provider: "clerk".to_string(),
        provider_subject: user.id.clone(),
        email,
        email_verified: true,
        display_name: display_name(&user),
        avatar_url: user.image_url.filter(|value| !value.trim().is_empty()),
    })
}

fn primary_verified_email(user: &ClerkUser) -> AppResult<String> {
    let primary = user
        .primary_email_address_id
        .as_deref()
        .and_then(|id| user.email_addresses.iter().find(|email| email.id == id))
        .or_else(|| user.email_addresses.first())
        .ok_or_else(|| AppError::unauthorized("Clerk account has no email address"))?;
    let verified = primary
        .verification
        .as_ref()
        .and_then(|verification| verification.status.as_deref())
        .map(|status| status == "verified")
        .unwrap_or(false);
    if !verified {
        return Err(AppError::with_code(
            StatusCode::UNAUTHORIZED,
            "clerk_email_unverified",
            "Clerk primary email address is not verified",
        ));
    }
    let email = primary.email_address.trim().to_ascii_lowercase();
    if email.is_empty() {
        return Err(AppError::unauthorized("Clerk account has no email address"));
    }
    Ok(email)
}

fn display_name(user: &ClerkUser) -> Option<String> {
    let name = [
        user.first_name.as_deref().unwrap_or_default().trim(),
        user.last_name.as_deref().unwrap_or_default().trim(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    (!name.is_empty()).then_some(name)
}

fn now_epoch_seconds() -> AppResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AppError::internal("system clock is before unix epoch"))
}

/// A verified Clerk OAuth access token: the authenticated user's Clerk id
/// (`subject`) and the scopes the consent granted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClerkOauthPrincipal {
    pub subject: String,
    pub scopes: Vec<String>,
    pub client_id: Option<String>,
}

// Response shape confirmed from Clerk's official SDK
// (clerk/clerk-sdk-python `VerifyOAuthAccessToken`): the active token returns
// `object=clerk_idp_oauth_access_token` with `subject`, `scopes`, `revoked`,
// `expired`, etc.; an inactive/expired token returns `{ "active": false }`.
#[derive(Debug, Deserialize)]
struct ClerkOauthVerifyResponse {
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    revoked: bool,
    #[serde(default)]
    expired: bool,
    // Unix seconds; used to bound the verification cache to the token's own
    // lifetime. Nullable in Clerk's schema.
    #[serde(default)]
    expiration: Option<f64>,
    // The active-token variant omits `active`, so absent means active; the
    // inactive variant sends `active: false`.
    #[serde(default = "default_active")]
    active: bool,
}

fn default_active() -> bool {
    true
}

impl ClerkOauthVerifyResponse {
    fn into_principal(self) -> AppResult<ClerkOauthPrincipal> {
        if !self.active || self.revoked || self.expired {
            return Err(AppError::unauthorized("OAuth access token is not active"));
        }
        let subject = self
            .subject
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::unauthorized("OAuth token has no subject"))?;
        Ok(ClerkOauthPrincipal {
            subject,
            scopes: self.scopes.unwrap_or_default(),
            client_id: self.client_id,
        })
    }
}

/// Longest a verification result is trusted from cache. Bounds how long a
/// revoked token could still be accepted, so keep it short.
const OAUTH_VERIFY_CACHE_TTL_SECS: u64 = 60;

struct CachedVerification {
    principal: ClerkOauthPrincipal,
    expires_at: u64,
}

/// Process-local cache of verified OAuth tokens, keyed by the token's hash so
/// raw tokens are not held in memory. Keeps the Clerk Backend API off the
/// per-request hot path.
fn oauth_verify_cache() -> &'static Mutex<HashMap<Vec<u8>, CachedVerification>> {
    static CACHE: OnceLock<Mutex<HashMap<Vec<u8>, CachedVerification>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_lookup(
    cache: &HashMap<Vec<u8>, CachedVerification>,
    key: &[u8],
    now: u64,
) -> Option<ClerkOauthPrincipal> {
    cache
        .get(key)
        .filter(|entry| entry.expires_at > now)
        .map(|entry| entry.principal.clone())
}

fn cache_store(
    cache: &mut HashMap<Vec<u8>, CachedVerification>,
    key: Vec<u8>,
    principal: ClerkOauthPrincipal,
    expires_at: u64,
    now: u64,
) {
    // Drop expired entries opportunistically so the map stays bounded to the
    // set of currently valid tokens.
    cache.retain(|_, entry| entry.expires_at > now);
    cache.insert(
        key,
        CachedVerification {
            principal,
            expires_at,
        },
    );
}

/// Verify a Clerk OAuth access token via the Clerk Backend API and return the
/// authenticated user's Clerk id and granted scopes.
///
/// Authenticates with the Clerk **secret key** — the same credential
/// `verify_clerk_session_token` uses — so no separate OAuth client secret is
/// required. Endpoint and response shape match Clerk's Backend API (base
/// `https://api.clerk.com/v1`), verified against the official SDK. Rejects
/// revoked, expired, and inactive tokens. Successful verifications are cached
/// (keyed by token hash) for up to `OAUTH_VERIFY_CACHE_TTL_SECS`, never past the
/// token's own expiry, to keep Clerk off the per-request hot path.
pub async fn verify_clerk_oauth_token(
    secret_key: &str,
    api_base: &str,
    token: &str,
) -> AppResult<ClerkOauthPrincipal> {
    let cache_key = crate::auth::hash_secret(token);
    let now = now_epoch_seconds()?;
    {
        let cache = oauth_verify_cache()
            .lock()
            .map_err(|_| AppError::internal("oauth verification cache poisoned"))?;
        if let Some(principal) = cache_lookup(&cache, &cache_key, now) {
            return Ok(principal);
        }
    }

    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/oauth_applications/access_tokens/verify",
            api_base.trim_end_matches('/')
        ))
        .bearer_auth(secret_key)
        .json(&serde_json::json!({ "access_token": token }))
        .send()
        .await
        .map_err(|err| {
            AppError::unauthorized(format!("Clerk OAuth token verification failed: {err}"))
        })?;
    if !response.status().is_success() {
        return Err(AppError::unauthorized("invalid OAuth access token"));
    }
    let body = response
        .json::<ClerkOauthVerifyResponse>()
        .await
        .map_err(|err| {
            AppError::unauthorized(format!("Clerk OAuth token verification failed: {err}"))
        })?;
    let token_expiry = body.expiration;
    let principal = body.into_principal()?;

    let ceiling = now.saturating_add(OAUTH_VERIFY_CACHE_TTL_SECS);
    let expires_at = token_expiry
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value as u64).min(ceiling))
        .unwrap_or(ceiling);
    if expires_at > now {
        let mut cache = oauth_verify_cache()
            .lock()
            .map_err(|_| AppError::internal("oauth verification cache poisoned"))?;
        cache_store(&mut cache, cache_key, principal.clone(), expires_at, now);
    }
    Ok(principal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn claims() -> ClerkSessionClaims {
        ClerkSessionClaims {
            iss: "https://instantml.clerk.accounts.dev".to_string(),
            sub: "user_123".to_string(),
            sid: "sess_123".to_string(),
            exp: 1_700_000_600,
            iat: 1_700_000_000,
            nbf: Some(1_699_999_990),
        }
    }

    fn user(status: &str) -> ClerkUser {
        ClerkUser {
            id: "user_123".to_string(),
            first_name: Some("Ada".to_string()),
            last_name: Some("Lovelace".to_string()),
            image_url: Some("https://img.clerk.com/avatar.png".to_string()),
            primary_email_address_id: Some("idn_1".to_string()),
            email_addresses: vec![ClerkEmailAddress {
                id: "idn_1".to_string(),
                email_address: "ADA@example.com".to_string(),
                verification: Some(ClerkEmailVerification {
                    status: Some(status.to_string()),
                }),
            }],
        }
    }

    #[test]
    fn clerk_claims_reject_stale_or_insecure_sessions() {
        let mut claim_set = claims();
        validate_clerk_session_claims(&claim_set, None, Duration::from_secs(900), 1_700_000_100)
            .unwrap();

        claim_set.iat = 1_699_998_000;
        assert!(validate_clerk_session_claims(
            &claim_set,
            None,
            Duration::from_secs(900),
            1_700_000_100
        )
        .is_err());

        claim_set = claims();
        claim_set.iss = "http://instantml.clerk.accounts.dev".to_string();
        assert!(validate_clerk_session_claims(
            &claim_set,
            None,
            Duration::from_secs(900),
            1_700_000_100
        )
        .is_err());

        claim_set.iss = "https://attacker.example.com".to_string();
        assert!(validate_clerk_session_claims(
            &claim_set,
            None,
            Duration::from_secs(900),
            1_700_000_100
        )
        .is_err());

        claim_set = claims();
        assert!(validate_clerk_session_claims(
            &claim_set,
            Some("https://other.clerk.accounts.dev"),
            Duration::from_secs(900),
            1_700_000_100
        )
        .is_err());
    }

    #[test]
    fn clerk_user_profile_requires_verified_primary_email() {
        let claims = claims();
        let principal = clerk_user_to_principal(&claims, user("verified")).unwrap();
        assert_eq!(principal.provider, "clerk");
        assert_eq!(principal.provider_subject, "user_123");
        assert_eq!(principal.email, "ada@example.com");
        assert_eq!(principal.display_name.as_deref(), Some("Ada Lovelace"));

        assert!(clerk_user_to_principal(&claims, user("unverified")).is_err());
    }

    #[test]
    fn oauth_verify_response_extracts_active_token_and_rejects_the_rest() {
        // Active token (Clerk's clerk_idp_oauth_access_token shape).
        let body: ClerkOauthVerifyResponse = serde_json::from_str(
            r#"{"object":"clerk_idp_oauth_access_token","id":"oat_1","client_id":"c_1",
                "subject":"user_42","scopes":["export:read"],"revoked":false,"expired":false}"#,
        )
        .unwrap();
        let principal = body.into_principal().unwrap();
        assert_eq!(principal.subject, "user_42");
        assert_eq!(principal.scopes, vec!["export:read".to_string()]);
        assert_eq!(principal.client_id.as_deref(), Some("c_1"));

        // Inactive variant: { "active": false } -> rejected.
        let inactive: ClerkOauthVerifyResponse =
            serde_json::from_str(r#"{"active":false}"#).unwrap();
        assert!(inactive.into_principal().is_err());

        // Revoked and expired active-shape tokens -> rejected.
        let revoked: ClerkOauthVerifyResponse =
            serde_json::from_str(r#"{"subject":"user_42","revoked":true}"#).unwrap();
        assert!(revoked.into_principal().is_err());
        let expired: ClerkOauthVerifyResponse =
            serde_json::from_str(r#"{"subject":"user_42","expired":true}"#).unwrap();
        assert!(expired.into_principal().is_err());

        // No subject -> rejected.
        let empty: ClerkOauthVerifyResponse = serde_json::from_str(r#"{"scopes":[]}"#).unwrap();
        assert!(empty.into_principal().is_err());
    }

    #[test]
    fn oauth_verify_cache_expires_and_purges() {
        let mut cache = HashMap::new();
        let principal = ClerkOauthPrincipal {
            subject: "user_1".to_string(),
            scopes: Vec::new(),
            client_id: None,
        };
        cache_store(&mut cache, b"tok".to_vec(), principal.clone(), 100, 40);

        // Hit before expiry; miss at/after the expiry second.
        assert_eq!(cache_lookup(&cache, b"tok", 99).unwrap().subject, "user_1");
        assert!(cache_lookup(&cache, b"tok", 100).is_none());
        assert!(cache_lookup(&cache, b"tok", 200).is_none());

        // A later store purges the now-expired entry so the map stays bounded.
        cache_store(&mut cache, b"tok2".to_vec(), principal, 300, 150);
        assert!(!cache.contains_key(b"tok".as_slice()));
        assert!(cache.contains_key(b"tok2".as_slice()));
    }

    #[tokio::test]
    async fn clerk_oauth_verifier_posts_token_to_backend_api() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            let header_end = loop {
                let read = stream.read(&mut buffer).unwrap();
                assert_ne!(read, 0, "client closed before sending request");
                request.extend_from_slice(&buffer[..read]);
                if let Some(position) = request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    break position + 4;
                }
            };
            let header_text = String::from_utf8_lossy(&request[..header_end]);
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length: ")
                        .or_else(|| line.strip_prefix("Content-Length: "))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let read = stream.read(&mut buffer).unwrap();
                assert_ne!(read, 0, "client closed before sending request body");
                request.extend_from_slice(&buffer[..read]);
            }
            let request_text = String::from_utf8_lossy(&request);
            let request_lower = request_text.to_lowercase();
            assert!(request_text
                .starts_with("POST /v1/oauth_applications/access_tokens/verify HTTP/1.1"));
            assert!(request_lower.contains("authorization: bearer sk_test"));
            assert!(request_text.contains(r#""access_token":"oauth_token_123""#));

            let body =
                r#"{"subject":"user_123","scopes":["profile","email"],"client_id":"client_123"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let principal =
            verify_clerk_oauth_token("sk_test", &format!("http://{addr}"), "oauth_token_123")
                .await
                .unwrap();

        assert_eq!(principal.subject, "user_123");
        assert_eq!(principal.scopes, vec!["profile", "email"]);
        assert_eq!(principal.client_id.as_deref(), Some("client_123"));
        server.join().unwrap();
    }
}
