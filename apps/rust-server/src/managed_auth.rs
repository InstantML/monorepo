use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
        return Err(AppError::unauthorized(
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
