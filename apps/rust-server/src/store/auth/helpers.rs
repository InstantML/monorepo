use super::super::*;

pub(super) const SHARED_DEMO_EMAIL: &str = "hello@instantml.ai";
pub(super) const SHARED_DEMO_EMAIL_ALIASES: &[&str] = &[SHARED_DEMO_EMAIL, "hello@instantml.com"];
pub(super) const SHARED_DEMO_NAME: &str = "InstantML Demo";
pub(super) const SHARED_DEMO_ACCOUNT_TYPE: &str = "business";

pub(super) struct NormalizedDevGoogleAuth {
    pub(super) email: String,
    pub(super) display_name: Option<String>,
    pub(super) account_type: String,
    pub(super) mode: Option<String>,
    pub(super) org_name: Option<String>,
    pub(super) plan_tier: Option<String>,
    pub(super) storage_choice: Option<String>,
    pub(super) seat_emails: Vec<String>,
    pub(super) accept_invite_org_id: Option<Uuid>,
    pub(super) accept_invite_token: Option<String>,
}

pub(super) struct VerifiedProviderSessionInput {
    pub(super) provider: String,
    pub(super) provider_subject: String,
    pub(super) email: String,
    pub(super) display_name: Option<String>,
    pub(super) avatar_url: Option<String>,
    pub(super) account_type: String,
    pub(super) mode: Option<String>,
    pub(super) org_name: Option<String>,
    pub(super) plan_tier: Option<String>,
    pub(super) storage_choice: Option<String>,
    pub(super) seat_emails: Vec<String>,
    pub(super) accept_invite_org_id: Option<Uuid>,
    pub(super) accept_invite_token: Option<String>,
    pub(super) strict_email_linking: bool,
    /// When `true`, signin mode requires the user to already have an org (or a
    /// pending invite). When `false` (the new default for verified-identity
    /// providers like Clerk/dev-google), a signin request for a brand-new user
    /// transparently falls through to the auto-derive signup path. This removes
    /// the historic "organization is required for signup" round-trip that
    /// stranded first-time Clerk users on the signin card.
    pub(super) strict_signin: bool,
    /// Clerk display name used to auto-derive a workspace name when org_name is absent.
    pub(super) auto_derive_display_name: Option<String>,
    /// Clerk email used to auto-derive a workspace name from the handle when display_name is absent.
    pub(super) auto_derive_email: String,
}

pub(super) fn user_has_non_bootstrap_identity(data: &StoreData, user_id: Uuid) -> bool {
    data.identities
        .iter()
        .any(|((provider, _), candidate)| *candidate == user_id && provider != "bootstrap")
}

pub(super) fn existing_org_for_auth(
    data: &StoreData,
    user_id: Uuid,
    org_name: Option<&str>,
    account_type: &str,
) -> Option<OrganizationRow> {
    data.memberships
        .values()
        .filter(|membership| membership.user_id == user_id && membership.status == "active")
        .filter_map(|membership| data.organizations.get(&membership.org_id))
        .find(|org| {
            org_name
                .map(|name| org.name == name && org.account_type == account_type)
                .unwrap_or(true)
        })
        .cloned()
        .or_else(|| {
            org_name.and_then(|name| {
                data.organizations
                    .values()
                    .find(|org| {
                        org.created_by_user_id == Some(user_id)
                            && org.name == name
                            && org.account_type == account_type
                    })
                    .cloned()
            })
        })
}

pub(super) fn validate_auth_mode(value: Option<&str>, signup_hint: bool) -> AppResult<String> {
    let mode = validate_optional_name(value, "mode")?
        .unwrap_or_else(|| if signup_hint { "signup" } else { "signin" }.to_string())
        .to_ascii_lowercase();
    if matches!(mode.as_str(), "signin" | "signup") {
        Ok(mode)
    } else {
        Err(AppError::validation("mode must be one of: signin, signup"))
    }
}

pub(super) async fn get_or_create_placeholder_user(
    store: &Store,
    email: &str,
) -> AppResult<UserRow> {
    {
        let data = store.data.lock().await;
        if let Some(id) = data.users_by_email.get(email).copied() {
            return data
                .users
                .get(&id)
                .cloned()
                .ok_or_else(|| AppError::internal("user email index is inconsistent"));
        }
    }
    let user = UserRow {
        id: Uuid::new_v4(),
        primary_email: email.to_string(),
        display_name: None,
        avatar_url: None,
        created_at: Utc::now(),
        last_seen_at: None,
    };
    store
        .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_user(user.clone());
    Ok(user)
}

pub(super) fn normalize_dev_google_auth(
    input: DevGoogleAuthRequest,
) -> AppResult<NormalizedDevGoogleAuth> {
    let email = validate_email(input.email.as_deref())?;
    if is_shared_demo_email(&email) {
        return Ok(NormalizedDevGoogleAuth {
            email: SHARED_DEMO_EMAIL.to_string(),
            display_name: Some(SHARED_DEMO_NAME.to_string()),
            account_type: SHARED_DEMO_ACCOUNT_TYPE.to_string(),
            mode: Some("signup".to_string()),
            org_name: Some(SHARED_DEMO_NAME.to_string()),
            plan_tier: Some("premium".to_string()),
            storage_choice: Some(STORAGE_CHOICE_HOSTED.to_string()),
            seat_emails: Vec::new(),
            accept_invite_org_id: None,
            accept_invite_token: None,
        });
    }
    Ok(NormalizedDevGoogleAuth {
        email,
        display_name: validate_optional_name(input.display_name.as_deref(), "display_name")?,
        account_type: validate_account_type(input.account_type.as_deref())?,
        mode: input.mode,
        org_name: input
            .org_name
            .as_deref()
            .map(|name| validate_name(Some(name), "organization"))
            .transpose()?,
        plan_tier: input.plan_tier,
        storage_choice: input.storage_choice,
        seat_emails: input.seat_emails.unwrap_or_default(),
        accept_invite_org_id: input.accept_invite_org_id,
        accept_invite_token: input.accept_invite_token,
    })
}

pub(super) fn is_shared_demo_email(email: &str) -> bool {
    SHARED_DEMO_EMAIL_ALIASES
        .iter()
        .any(|candidate| email.eq_ignore_ascii_case(candidate))
}

/// Derive a workspace slug from a Clerk display name or email handle.
/// Preference order: display_name → email handle.
pub fn derive_workspace_slug(display_name: Option<&str>, email: &str) -> String {
    let source = display_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            email
                .split_once('@')
                .map(|(handle, _)| handle)
                .unwrap_or(email)
        });
    let slug = slugify(source);
    if slug.is_empty() || slug == "workspace" {
        // Fallback: use email handle directly.
        let handle = email.split_once('@').map(|(h, _)| h).unwrap_or(email);
        slugify(handle)
    } else {
        slug
    }
}

/// Convert a slug such as "tony-xin" to a human-readable name "Tony Xin".
pub fn slug_to_name(slug: &str) -> String {
    slug.split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
