use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

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

pub fn hash_secret(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

pub fn hash_idempotency(run_id: Uuid, body: &Value) -> Vec<u8> {
    let wrapped = serde_json::json!({ "run_id": run_id, "body": body });
    Sha256::digest(canonical_json(&wrapped).as_bytes()).to_vec()
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let body = items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{body}]")
        }
        Value::Object(map) => {
            let body = map
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("string key serializes"),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        _ => serde_json::to_string(value).expect("JSON value serializes"),
    }
}
