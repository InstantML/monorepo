use axum::http::StatusCode;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::warn;

use crate::{
    config::{EmailConfig, EmailProvider},
    errors::{AppError, AppResult},
};

#[derive(Clone, Debug)]
pub struct OrgInviteEmail {
    pub to: String,
    pub org_name: String,
    pub role: String,
    pub token: String,
    pub expires_at: String,
}

#[derive(Clone, Debug)]
pub struct EmailSendResult {
    pub provider: String,
    pub provider_message_id: Option<String>,
    pub preview_link: Option<String>,
}

pub async fn send_org_invite(
    config: &EmailConfig,
    input: OrgInviteEmail,
) -> AppResult<EmailSendResult> {
    let accept_url = format!(
        "{}/invite#t={}",
        config.frontend_base_url.trim_end_matches('/'),
        input.token
    );
    match config.provider {
        EmailProvider::Disabled => Err(AppError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "email_delivery_unavailable",
            "email delivery is not configured",
        )),
        EmailProvider::Log => {
            tracing::info!(
                provider = "log",
                recipient = %mask_email(&input.to),
                org = %input.org_name,
                "organization invitation email prepared"
            );
            Ok(EmailSendResult {
                provider: EmailProvider::Log.as_str().to_string(),
                provider_message_id: None,
                preview_link: Some(accept_url),
            })
        }
        EmailProvider::Resend => send_resend_email(config, &input, &accept_url).await,
    }
}

async fn send_resend_email(
    config: &EmailConfig,
    input: &OrgInviteEmail,
    accept_url: &str,
) -> AppResult<EmailSendResult> {
    let Some(api_key) = &config.resend_api_key else {
        return Err(AppError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "email_delivery_unavailable",
            "email delivery is not configured",
        ));
    };
    let subject = format!("You're invited to {}", input.org_name);
    let text = format!(
        "You have been invited to join {org_name} on InstantML as {role}.\n\nAccept the invite: {accept_url}\n\nThis invite expires at {expires_at}.",
        org_name = input.org_name,
        role = input.role,
        expires_at = input.expires_at,
    );
    let html = format!(
        "<p>You have been invited to join <strong>{org}</strong> on InstantML as <strong>{role}</strong>.</p><p><a href=\"{url}\">Accept the invite</a></p><p>This invite expires at {expires}.</p>",
        org = escape_html(&input.org_name),
        role = escape_html(&input.role),
        url = escape_html(accept_url),
        expires = escape_html(&input.expires_at),
    );
    let mut payload = json!({
        "from": config.from.clone(),
        "to": [input.to.clone()],
        "subject": subject,
        "text": text,
        "html": html,
        "tags": [
            { "name": "category", "value": "org_invite" }
        ]
    });
    if let Some(reply_to) = &config.reply_to {
        payload["reply_to"] = json!(reply_to);
    }
    let response = Client::new()
        .post("https://api.resend.com/emails")
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            AppError::with_code(
                StatusCode::SERVICE_UNAVAILABLE,
                "email_delivery_unavailable",
                format!("failed to send invitation email: {error}"),
            )
        })?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        warn!(status = %status, "Resend invitation delivery failed");
        return Err(AppError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "email_delivery_unavailable",
            "failed to send invitation email",
        ));
    }
    Ok(EmailSendResult {
        provider: EmailProvider::Resend.as_str().to_string(),
        provider_message_id: body.get("id").and_then(Value::as_str).map(str::to_string),
        preview_link: None,
    })
}

fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "***".to_string();
    };
    let first = local.chars().next().unwrap_or('*');
    format!("{first}***@{domain}")
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
