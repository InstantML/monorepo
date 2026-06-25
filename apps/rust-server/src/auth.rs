use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};

pub const EMBED_TOKEN_PREFIX: &str = "instantml_embed_";
const EMBED_TOKEN_DOMAIN: &[u8] = b"embed_session:v1";

pub fn generate_api_key() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    format!("instantml_{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn generate_session_token() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    format!("instantml_session_{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn generate_embed_token() -> AppResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| AppError::internal(format!("failed to generate embed token: {error}")))?;
    Ok(format!(
        "{}{}",
        EMBED_TOKEN_PREFIX,
        URL_SAFE_NO_PAD.encode(bytes)
    ))
}

pub fn generate_invite_token() -> AppResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| AppError::internal(format!("failed to generate invite token: {error}")))?;
    Ok(format!(
        "instantml_invite_{}",
        URL_SAFE_NO_PAD.encode(bytes)
    ))
}

pub fn hash_secret(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

pub fn hash_embed_token(token: &str, hmac_secret: Option<&str>) -> Vec<u8> {
    if let Some(secret) = hmac_secret.filter(|value| !value.is_empty()) {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .expect("HMAC accepts keys of any size");
        mac.update(EMBED_TOKEN_DOMAIN);
        mac.update(b":");
        mac.update(token.as_bytes());
        return mac.finalize().into_bytes().to_vec();
    }
    let mut hasher = Sha256::new();
    hasher.update(EMBED_TOKEN_DOMAIN);
    hasher.update(b":");
    hasher.update(token.as_bytes());
    hasher.finalize().to_vec()
}

pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

pub fn hash_idempotency(run_id: Uuid, body: &Value) -> AppResult<Vec<u8>> {
    let wrapped = serde_json::json!({ "run_id": run_id, "body": body });
    Ok(Sha256::digest(canonical_json(&wrapped)?.as_bytes()).to_vec())
}

pub fn canonical_json(value: &Value) -> AppResult<String> {
    match value {
        Value::Array(items) => {
            let body = items
                .iter()
                .map(canonical_json)
                .collect::<AppResult<Vec<_>>>()?
                .join(",");
            Ok(format!("[{body}]"))
        }
        Value::Object(map) => {
            let body = map
                .iter()
                .map(|(key, value)| {
                    let key = serde_json::to_string(key)
                        .map_err(|_| AppError::internal("JSON key serialization failed"))?;
                    Ok(format!("{key}:{}", canonical_json(value)?))
                })
                .collect::<AppResult<Vec<_>>>()?
                .join(",");
            Ok(format!("{{{body}}}"))
        }
        _ => serde_json::to_string(value)
            .map_err(|_| AppError::internal("JSON value serialization failed")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_object_keys_for_hashing() {
        let left = json!({ "b": [2, 1], "a": { "z": true, "m": null } });
        let right = json!({ "a": { "m": null, "z": true }, "b": [2, 1] });

        assert_eq!(
            canonical_json(&left).unwrap(),
            canonical_json(&right).unwrap()
        );
        assert_eq!(
            hash_idempotency(Uuid::from_u128(7), &left).unwrap(),
            hash_idempotency(Uuid::from_u128(7), &right).unwrap()
        );
    }

    #[test]
    fn embed_tokens_use_dedicated_prefix_entropy_and_hash_domain() {
        let token = generate_embed_token().unwrap();
        assert!(token.starts_with(EMBED_TOKEN_PREFIX));
        assert_eq!(token.len(), EMBED_TOKEN_PREFIX.len() + 43);
        assert_ne!(hash_embed_token(&token, None), hash_secret(&token));
        assert_eq!(
            hash_embed_token(&token, Some("secret")),
            hash_embed_token(&token, Some("secret"))
        );
        assert_ne!(
            hash_embed_token(&token, Some("secret")),
            hash_embed_token(&token, Some("other"))
        );
        assert!(constant_time_eq(
            &hash_embed_token(&token, None),
            &hash_embed_token(&token, None)
        ));
    }
}
