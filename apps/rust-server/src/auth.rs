use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};

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
}
