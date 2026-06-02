use super::super::*;
use super::helpers::get_or_create_placeholder_user;
use super::sessions::create_session_for_org;
use crate::auth::generate_invite_token;
use crate::config::{EmailConfig, EmailProvider};
use crate::email::{send_org_invite, OrgInviteEmail};
use axum::http::StatusCode;

const INVITATION_TTL_DAYS: i64 = 7;
const INVITE_RESEND_COOLDOWN_MINUTES: i64 = 15;
const MAX_ORG_INVITE_SENDS_PER_DAY: usize = 200;
const MAX_FREE_ORG_INVITE_SENDS_PER_DAY: usize = 5;
const MAX_ADMIN_INVITE_SENDS_PER_HOUR: usize = 10;
const MAX_ADMIN_INVITE_SENDS_PER_DAY: usize = 50;
const MAX_RECIPIENT_ORG_INVITE_SENDS_PER_DAY: usize = 3;
const MAX_RECIPIENT_GLOBAL_INVITE_SENDS_PER_DAY: usize = 5;
const MAX_INVITE_TOKEN_ATTEMPTS_PER_HOUR: usize = 60;
const MAX_INVITE_TOKEN_CLIENT_ATTEMPTS_PER_HOUR: usize = 120;
const MAX_INVITE_TOKEN_GLOBAL_ATTEMPTS_PER_HOUR: usize = 50_000;

#[derive(Clone, Copy, Debug)]
pub enum InvitationTokenAttemptScope {
    Preview,
    Accept,
}

impl InvitationTokenAttemptScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Accept => "accept",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct InvitationSendReservation {
    invitation_id: Uuid,
    delivery_id: Uuid,
}

#[derive(Clone, Debug)]
pub struct InvitationSendOutcome {
    pub invitation: PublicInvitationRow,
    pub preview_link: Option<String>,
    pub delivery_error: Option<String>,
}

pub(super) fn normalized_invite_emails(
    raw_emails: Vec<String>,
    owner_email: &str,
) -> AppResult<Vec<String>> {
    let mut seen = BTreeSet::new();
    let mut emails = Vec::new();
    for raw in raw_emails {
        let email = validate_email(Some(&raw))?;
        if email == owner_email || !seen.insert(email.clone()) {
            continue;
        }
        emails.push(email);
    }
    Ok(emails)
}

pub(super) fn pending_invites_for_user(data: &StoreData, user_id: Uuid) -> Vec<MembershipRow> {
    data.memberships
        .values()
        .filter(|membership| membership.user_id == user_id && membership.status == "invited")
        .cloned()
        .collect()
}

pub(super) async fn activate_invited_membership(
    store: &Store,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<Option<OrganizationRow>> {
    let (mut membership, org) = {
        let data = store.data.lock().await;
        let Some(membership) = data
            .memberships
            .values()
            .find(|membership| {
                membership.org_id == org_id
                    && membership.user_id == user_id
                    && membership.status == "invited"
            })
            .cloned()
        else {
            return Ok(None);
        };
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        (membership, org)
    };
    membership.status = "active".to_string();
    store
        .persist_locked(
            "membership",
            org_id,
            &membership.id.to_string(),
            &membership,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_membership(membership);
    Ok(Some(org))
}

pub async fn create_org_invitation(
    store: &Store,
    actor_user_id: Option<Uuid>,
    org_id: Uuid,
    input: CreateInvitationRequest,
    email_config: &EmailConfig,
) -> AppResult<InvitationSendOutcome> {
    ensure_invitation_delivery_configured(email_config)?;
    ensure_billing_write_allowed(store, org_id, "invite a teammate").await?;
    let email = validate_email(input.email.as_deref())?;
    let role = validate_invitation_role(input.role.as_deref())?;
    let token = generate_invite_token()?;
    let token_hash = hash_secret(&token);
    let (invitation, org_name) = {
        let data = store.data.lock().await;
        let now = Utc::now();
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        if org.account_type == "personal" {
            return Err(AppError::with_code(
                StatusCode::BAD_REQUEST,
                "personal_workspace_invite_forbidden",
                "personal workspaces cannot invite teammates; create an organization workspace instead",
            ));
        }
        if let Some(user_id) = actor_user_id {
            require_admin_in_data(&data, user_id, org_id)?;
        }
        enforce_invitation_send_limits(&data, &org, actor_user_id, &email, now)?;
        if let Some(user_id) = data.users_by_email.get(&email).copied() {
            if data.memberships.values().any(|membership| {
                membership.org_id == org_id
                    && membership.user_id == user_id
                    && membership.status == "active"
            }) {
                return Err(AppError::with_code(
                    StatusCode::CONFLICT,
                    "invite_already_member",
                    "user is already an active member",
                ));
            }
        }
        if data.org_invitations.values().any(|invitation| {
            invitation.org_id == org_id
                && invitation.email == email
                && invitation.status == "pending"
                && invitation.expires_at > now
        }) {
            return Err(AppError::with_code(
                StatusCode::CONFLICT,
                "invite_already_pending",
                "invitation is already pending",
            ));
        }
        let seat_limit = org.seat_limit.max(0) as usize;
        if !email_has_reserved_membership(&data, org_id, &email)
            && reserved_seat_count_in_data(&data, org_id, now) >= seat_limit
        {
            return Err(AppError::with_code(
                StatusCode::CONFLICT,
                "invite_seat_limit_reached",
                "organization seat limit reached",
            ));
        }
        let invitation = OrgInvitationRow {
            id: Uuid::new_v4(),
            org_id,
            email: email.clone(),
            role: role.clone(),
            status: "pending".to_string(),
            token_hash,
            previous_token_hashes: Vec::new(),
            invited_by_user_id: actor_user_id,
            created_at: now,
            expires_at: now + ChronoDuration::days(INVITATION_TTL_DAYS),
            last_sent_at: None,
            accepted_at: None,
            accepted_by_user_id: None,
            revoked_at: None,
            revoked_by_user_id: None,
            delivery_status: "queued".to_string(),
            email_provider: None,
            provider_message_id: None,
        };
        (invitation, org.name)
    };
    let reservation =
        queue_invitation_delivery(store, invitation, email_config, Utc::now()).await?;
    send_and_record_invitation(store, reservation, token, org_name, email_config).await
}

pub async fn list_org_invitations(
    store: &Store,
    org_id: Uuid,
    limit: usize,
    offset: usize,
) -> AppResult<Vec<PublicInvitationRow>> {
    let data = store.data.lock().await;
    if !data.organizations.contains_key(&org_id) {
        return Err(AppError::not_found("organization not found"));
    }
    let now = Utc::now();
    let mut rows = data
        .org_invitations
        .values()
        .filter(|invitation| invitation.org_id == org_id)
        .map(|invitation| public_invitation_row(invitation, now))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.email.cmp(&right.email))
    });
    Ok(rows.into_iter().skip(offset).take(limit).collect())
}

pub async fn resend_org_invitation(
    store: &Store,
    actor_user_id: Option<Uuid>,
    org_id: Uuid,
    invitation_id: Uuid,
    email_config: &EmailConfig,
) -> AppResult<InvitationSendOutcome> {
    ensure_invitation_delivery_configured(email_config)?;
    ensure_billing_write_allowed(store, org_id, "resend an invitation").await?;
    let token = generate_invite_token()?;
    let token_hash = hash_secret(&token);
    let (invitation, org_name) = {
        let data = store.data.lock().await;
        if let Some(user_id) = actor_user_id {
            require_admin_in_data(&data, user_id, org_id)?;
        }
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        let now = Utc::now();
        let mut invitation = data
            .org_invitations
            .get(&invitation_id)
            .filter(|invitation| invitation.org_id == org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("invitation not found"))?;
        if invitation.status != "pending" {
            return Err(AppError::conflict("only pending invitations can be resent"));
        }
        if invitation.expires_at <= now {
            return Err(AppError::with_code(
                StatusCode::GONE,
                "invite_expired",
                "invitation expired",
            ));
        }
        if invitation.last_sent_at.is_some_and(|last_sent| {
            now.signed_duration_since(last_sent)
                < ChronoDuration::minutes(INVITE_RESEND_COOLDOWN_MINUTES)
        }) {
            return Err(AppError::with_code(
                StatusCode::TOO_MANY_REQUESTS,
                "invite_resend_rate_limited",
                "invitation was sent recently",
            ));
        }
        enforce_invitation_send_limits(&data, &org, actor_user_id, &invitation.email, now)?;
        if !invitation
            .previous_token_hashes
            .iter()
            .any(|existing| existing == &invitation.token_hash)
        {
            invitation
                .previous_token_hashes
                .push(invitation.token_hash.clone());
        }
        invitation.token_hash = token_hash;
        invitation.expires_at = now + ChronoDuration::days(INVITATION_TTL_DAYS);
        invitation.delivery_status = "queued".to_string();
        invitation.email_provider = None;
        invitation.provider_message_id = None;
        (invitation, org.name)
    };
    let reservation =
        queue_invitation_delivery(store, invitation, email_config, Utc::now()).await?;
    send_and_record_invitation(store, reservation, token, org_name, email_config).await
}

pub async fn revoke_org_invitation(
    store: &Store,
    actor_user_id: Option<Uuid>,
    org_id: Uuid,
    invitation_id: Uuid,
) -> AppResult<PublicInvitationRow> {
    let now = Utc::now();
    let mut invitation = {
        let data = store.data.lock().await;
        if let Some(user_id) = actor_user_id {
            require_admin_in_data(&data, user_id, org_id)?;
        }
        data.org_invitations
            .get(&invitation_id)
            .filter(|invitation| invitation.org_id == org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("invitation not found"))?
    };
    if invitation.status != "pending" {
        return Err(AppError::conflict(
            "only pending invitations can be revoked",
        ));
    }
    invitation.status = "revoked".to_string();
    invitation.revoked_at = Some(now);
    invitation.revoked_by_user_id = actor_user_id;
    store
        .persist_locked(
            "org_invitation",
            org_id,
            &invitation.id.to_string(),
            &invitation,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_org_invitation(invitation.clone());
    Ok(public_invitation_row(&invitation, now))
}

pub async fn preview_invitation(
    store: &Store,
    input: InvitationTokenRequest,
) -> AppResult<InvitationPreviewPayload> {
    let token = validate_invitation_token(input.token.as_deref())?;
    let token_hash = hash_secret(&token);
    let data = store.data.lock().await;
    let now = Utc::now();
    let invitation = invitation_by_token_hash(&data, &token_hash)?;
    let org = data
        .organizations
        .get(&invitation.org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let status = invitation_public_status(invitation, now);
    Ok(InvitationPreviewPayload {
        org_name: org.name,
        email_hint: mask_email_hint(&invitation.email),
        role: invitation.role.clone(),
        status,
        expires_at: invitation.expires_at,
    })
}

pub async fn preflight_invitation_for_email(
    store: &Store,
    token: &str,
    email: &str,
) -> AppResult<()> {
    let token = validate_invitation_token(Some(token))?;
    let token_hash = hash_secret(&token);
    let data = store.data.lock().await;
    let now = Utc::now();
    let invitation = invitation_by_token_hash(&data, &token_hash)?;
    if !matches!(invitation.status.as_str(), "pending" | "accepted") {
        return Err(AppError::conflict("invitation is not pending"));
    }
    if invitation.status == "pending" && invitation.expires_at <= now {
        return Err(AppError::with_code(
            StatusCode::GONE,
            "invite_expired",
            "invitation expired",
        ));
    }
    let email = validate_email(Some(email))?;
    if invitation.email != email {
        return Err(AppError::with_code(
            StatusCode::FORBIDDEN,
            "invite_email_mismatch",
            "invitation belongs to a different email address",
        ));
    }
    Ok(())
}

pub async fn accept_invitation_for_user(
    store: &Store,
    token: &str,
    user_id: Uuid,
) -> AppResult<CreatedAuthSession> {
    let token = validate_invitation_token(Some(token))?;
    let token_hash = hash_secret(&token);
    let (org_id, needs_billing_write) = {
        let mut data = store.data.lock().await;
        let now = Utc::now();
        let invitation = invitation_by_token_hash(&data, &token_hash)?;
        if invitation.status == "pending" && invitation.expires_at <= now {
            let token_hash = invitation.token_hash.clone();
            let previous_token_hashes = invitation.previous_token_hashes.clone();
            data.org_invitations_by_token_hash.remove(&token_hash);
            for previous_token_hash in previous_token_hashes {
                data.org_invitations_by_token_hash
                    .remove(&previous_token_hash);
            }
            return Err(AppError::with_code(
                StatusCode::GONE,
                "invite_expired",
                "invitation expired",
            ));
        }
        (invitation.org_id, invitation.status == "pending")
    };
    if needs_billing_write {
        ensure_billing_write_allowed(store, org_id, "accept an invitation").await?;
    }
    enum AcceptInvitationPlan {
        Expired(OrgInvitationRow),
        Accepted {
            user: UserRow,
            org: OrganizationRow,
            membership: Option<MembershipRow>,
            invitation: Option<OrgInvitationRow>,
        },
    }

    let plan: AppResult<AcceptInvitationPlan> = {
        let data = store.data.lock().await;
        let now = Utc::now();
        let invitation = invitation_by_token_hash(&data, &token_hash)?.clone();
        let user = data
            .users
            .get(&user_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("user not found"))?;
        let user_email = validate_email(Some(&user.primary_email))?;
        if invitation.email != user_email {
            return Err(AppError::with_code(
                StatusCode::FORBIDDEN,
                "invite_email_mismatch",
                "invitation belongs to a different email address",
            ));
        }
        let org = data
            .organizations
            .get(&invitation.org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        let already_accepted = match invitation.status.as_str() {
            "pending" => false,
            "accepted" if invitation.accepted_by_user_id == Some(user_id) => true,
            "accepted" => {
                return Err(AppError::conflict("invitation has already been accepted"));
            }
            "revoked" => {
                return Err(AppError::with_code(
                    StatusCode::GONE,
                    "invite_revoked",
                    "invitation was revoked",
                ));
            }
            _ => return Err(AppError::conflict("invitation is not pending")),
        };
        if !already_accepted && invitation.expires_at <= now {
            let mut expired = invitation.clone();
            expired.status = "expired".to_string();
            Ok(AcceptInvitationPlan::Expired(expired))
        } else {
            let existing_membership = data
                .memberships
                .values()
                .find(|membership| {
                    membership.org_id == invitation.org_id
                        && membership.user_id == user_id
                        && matches!(membership.status.as_str(), "active" | "invited")
                })
                .cloned();
            if already_accepted
                && existing_membership
                    .as_ref()
                    .is_none_or(|membership| membership.status != "active")
            {
                return Err(AppError::conflict("invitation has already been accepted"));
            }
            if existing_membership.is_none()
                && reserved_seat_count_in_data(&data, invitation.org_id, now)
                    > org.seat_limit.max(0) as usize
            {
                return Err(AppError::with_code(
                    StatusCode::CONFLICT,
                    "invite_seat_limit_reached",
                    "organization seat limit reached",
                ));
            }
            let membership = match existing_membership {
                Some(mut membership) if membership.status == "invited" => {
                    membership.status = "active".to_string();
                    membership.role = invitation.role.clone();
                    Some(membership)
                }
                Some(_) => None,
                None => Some(membership_row(
                    invitation.org_id,
                    user_id,
                    &invitation.role,
                    "active",
                )),
            };
            let accepted_invitation = if !already_accepted {
                let mut accepted = invitation.clone();
                accepted.status = "accepted".to_string();
                accepted.accepted_at = Some(now);
                accepted.accepted_by_user_id = Some(user_id);
                Some(accepted)
            } else {
                None
            };
            Ok(AcceptInvitationPlan::Accepted {
                user,
                org,
                membership,
                invitation: accepted_invitation,
            })
        }
    };

    match plan? {
        AcceptInvitationPlan::Expired(expired) => {
            store
                .persist_locked(
                    "org_invitation",
                    expired.org_id,
                    &expired.id.to_string(),
                    &expired,
                )
                .await?;
            let mut data = store.data.lock().await;
            data.insert_org_invitation(expired);
            Err(AppError::with_code(
                StatusCode::GONE,
                "invite_expired",
                "invitation expired",
            ))
        }
        AcceptInvitationPlan::Accepted {
            user,
            org,
            membership,
            invitation,
        } => {
            if let Some(membership) = &membership {
                store
                    .persist_locked(
                        "membership",
                        membership.org_id,
                        &membership.id.to_string(),
                        membership,
                    )
                    .await?;
            }
            if let Some(invitation) = &invitation {
                store
                    .persist_locked(
                        "org_invitation",
                        invitation.org_id,
                        &invitation.id.to_string(),
                        invitation,
                    )
                    .await?;
            }
            if membership.is_some() || invitation.is_some() {
                let mut data = store.data.lock().await;
                if let Some(membership) = membership {
                    data.insert_membership(membership);
                }
                if let Some(invitation) = invitation {
                    data.insert_org_invitation(invitation);
                }
            }
            create_session_for_org(store, user, org).await
        }
    }
}

pub async fn reserve_seat(
    store: &Store,
    user_id: Option<Uuid>,
    org_id: Uuid,
    input: ReserveSeatRequest,
) -> AppResult<SeatRow> {
    ensure_billing_write_allowed(store, org_id, "reserve a seat").await?;
    let email = validate_email(input.email.as_deref())?;
    let role = validate_membership_role(input.role.as_deref().or(Some("member")))?;
    if role == "owner" {
        return Err(AppError::validation(
            "invited seats can use admin, member, or viewer roles",
        ));
    }
    let org = {
        let data = store.data.lock().await;
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        if let Some(user_id) = user_id {
            require_admin_in_data(&data, user_id, org_id)?;
        }
        org
    };
    if org.account_type == "personal" {
        return Err(AppError::with_code(
            StatusCode::BAD_REQUEST,
            "personal_workspace_invite_forbidden",
            "personal workspaces cannot invite teammates; create an organization workspace instead",
        ));
    }
    let seat_limit = org.seat_limit as usize;
    let invited_user = get_or_create_placeholder_user(store, &email).await?;
    {
        let data = store.data.lock().await;
        if let Some(existing) = data
            .memberships
            .values()
            .find(|membership| {
                membership.org_id == org_id
                    && membership.user_id == invited_user.id
                    && matches!(membership.status.as_str(), "active" | "invited")
            })
            .cloned()
        {
            return seat_row_from_data(&data, existing);
        }
        if reserved_seat_count_in_data(&data, org_id, Utc::now()) >= seat_limit {
            return Err(AppError::conflict("organization seat limit reached"));
        }
    }
    let membership = membership_row(org_id, invited_user.id, &role, "invited");
    store
        .persist_locked(
            "membership",
            org_id,
            &membership.id.to_string(),
            &membership,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_membership(membership.clone());
    seat_row_from_data(&data, membership)
}

pub(in crate::store) fn reserved_seat_count_in_data(
    data: &StoreData,
    org_id: Uuid,
    now: DateTime<Utc>,
) -> usize {
    let memberships = data
        .memberships
        .values()
        .filter(|membership| {
            membership.org_id == org_id
                && matches!(membership.status.as_str(), "active" | "invited")
        })
        .count();
    let pending_invitations = data
        .org_invitations
        .values()
        .filter(|invitation| {
            invitation.org_id == org_id
                && invitation.status == "pending"
                && invitation.expires_at > now
                && !email_has_reserved_membership(data, org_id, &invitation.email)
        })
        .count();
    memberships + pending_invitations
}

pub async fn list_seats(store: &Store, org_id: Uuid) -> AppResult<Vec<SeatRow>> {
    let data = store.data.lock().await;
    if !data.organizations.contains_key(&org_id) {
        return Err(AppError::not_found("organization not found"));
    }
    let mut seats = data
        .memberships
        .values()
        .filter(|membership| membership.org_id == org_id)
        .cloned()
        .map(|membership| seat_row_from_data(&data, membership))
        .collect::<AppResult<Vec<_>>>()?;
    seats.sort_by(|left, right| {
        left.membership
            .created_at
            .cmp(&right.membership.created_at)
            .then_with(|| left.user.primary_email.cmp(&right.user.primary_email))
    });
    Ok(seats)
}

fn seat_row_from_data(data: &StoreData, membership: MembershipRow) -> AppResult<SeatRow> {
    let user = data
        .users
        .get(&membership.user_id)
        .ok_or_else(|| AppError::not_found("seat user not found"))?;
    Ok(SeatRow {
        membership,
        user: SeatUserRow {
            id: user.id,
            primary_email: user.primary_email.clone(),
            display_name: user.display_name.clone(),
            avatar_url: user.avatar_url.clone(),
        },
    })
}

async fn send_and_record_invitation(
    store: &Store,
    reservation: InvitationSendReservation,
    token: String,
    org_name: String,
    email_config: &EmailConfig,
) -> AppResult<InvitationSendOutcome> {
    let invitation = {
        let data = store.data.lock().await;
        data.org_invitations
            .get(&reservation.invitation_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("invitation not found"))?
    };
    let email = OrgInviteEmail {
        to: invitation.email.clone(),
        org_name,
        role: invitation.role.clone(),
        token,
        expires_at: invitation.expires_at.to_rfc3339(),
    };
    let sent = send_org_invite(email_config, email).await;
    let now = Utc::now();
    let mut updated = {
        let data = store.data.lock().await;
        data.org_invitations
            .get(&reservation.invitation_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("invitation not found"))?
    };
    let (provider, status, message_id, preview_link, delivery_error) = match sent {
        Ok(result) => {
            updated.delivery_status = "sent".to_string();
            updated.email_provider = Some(result.provider.clone());
            updated.provider_message_id = result.provider_message_id.clone();
            updated.previous_token_hashes.clear();
            (
                result.provider,
                "sent".to_string(),
                result.provider_message_id,
                result.preview_link,
                None,
            )
        }
        Err(error) => {
            let safe_error = error.code().unwrap_or("email_delivery_failed").to_string();
            updated.delivery_status = "send_failed".to_string();
            updated.email_provider = Some(email_config.provider.as_str().to_string());
            (
                email_config.provider.as_str().to_string(),
                "failed".to_string(),
                None,
                None,
                Some(safe_error),
            )
        }
    };
    let mut delivery = {
        let data = store.data.lock().await;
        data.email_deliveries
            .get(&reservation.delivery_id)
            .cloned()
            .ok_or_else(|| AppError::internal("email delivery attempt is inconsistent"))?
    };
    delivery.provider = provider;
    delivery.status = status;
    delivery.provider_message_id = message_id;
    delivery.error_code = delivery_error.clone();
    store
        .persist_locked(
            "org_invitation",
            updated.org_id,
            &updated.id.to_string(),
            &updated,
        )
        .await?;
    store
        .persist_locked(
            "email_delivery",
            delivery.org_id,
            &delivery.id.to_string(),
            &delivery,
        )
        .await?;
    let mut data = store.data.lock().await;
    data.insert_org_invitation(updated.clone());
    data.insert_email_delivery(delivery);
    Ok(InvitationSendOutcome {
        invitation: public_invitation_row(&updated, now),
        preview_link,
        delivery_error: delivery_error.map(|_| "email delivery failed".to_string()),
    })
}

async fn queue_invitation_delivery(
    store: &Store,
    mut invitation: OrgInvitationRow,
    email_config: &EmailConfig,
    attempted_at: DateTime<Utc>,
) -> AppResult<InvitationSendReservation> {
    invitation.delivery_status = "queued".to_string();
    invitation.last_sent_at = Some(attempted_at);
    invitation.email_provider = Some(email_config.provider.as_str().to_string());
    let delivery = EmailDeliveryRow {
        id: Uuid::new_v4(),
        org_id: invitation.org_id,
        invitation_id: invitation.id,
        recipient_email: invitation.email.clone(),
        provider: email_config.provider.as_str().to_string(),
        status: "queued".to_string(),
        provider_message_id: None,
        error_code: None,
        created_at: attempted_at,
    };
    store
        .persist_locked(
            "org_invitation",
            invitation.org_id,
            &invitation.id.to_string(),
            &invitation,
        )
        .await?;
    store
        .persist_locked(
            "email_delivery",
            delivery.org_id,
            &delivery.id.to_string(),
            &delivery,
        )
        .await?;
    let invitation_id = invitation.id;
    let delivery_id = delivery.id;
    let mut data = store.data.lock().await;
    data.insert_org_invitation(invitation);
    data.insert_email_delivery(delivery);
    Ok(InvitationSendReservation {
        invitation_id,
        delivery_id,
    })
}

fn validate_invitation_role(value: Option<&str>) -> AppResult<String> {
    let role = validate_membership_role(value.or(Some("member")))?;
    if role == "owner" {
        return Err(AppError::validation(
            "invited seats can use admin, member, or viewer roles",
        ));
    }
    Ok(role)
}

fn ensure_invitation_delivery_configured(email_config: &EmailConfig) -> AppResult<()> {
    if matches!(email_config.provider, EmailProvider::Disabled) {
        return Err(AppError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "email_delivery_unavailable",
            "email delivery is not configured",
        ));
    }
    Ok(())
}

fn validate_invitation_token(value: Option<&str>) -> AppResult<String> {
    let token = validate_name(value, "token")?;
    if !token.starts_with("instantml_invite_") {
        return Err(AppError::with_code(
            StatusCode::NOT_FOUND,
            "invite_not_found",
            "invitation not found",
        ));
    }
    Ok(token)
}

fn invitation_by_token_hash<'a>(
    data: &'a StoreData,
    token_hash: &[u8],
) -> AppResult<&'a OrgInvitationRow> {
    if let Some(invitation_id) = data.org_invitations_by_token_hash.get(token_hash).copied() {
        return data
            .org_invitations
            .get(&invitation_id)
            .ok_or_else(|| AppError::internal("invitation token index is inconsistent"));
    }
    if let Some(invitation) = data
        .org_invitations
        .values()
        .find(|invitation| invitation_token_hash_matches(invitation, token_hash))
    {
        return match invitation.status.as_str() {
            "accepted" => Ok(invitation),
            "expired" => Err(AppError::with_code(
                StatusCode::GONE,
                "invite_expired",
                "invitation expired",
            )),
            "pending" if invitation.expires_at <= Utc::now() => Err(AppError::with_code(
                StatusCode::GONE,
                "invite_expired",
                "invitation expired",
            )),
            "revoked" => Err(AppError::with_code(
                StatusCode::GONE,
                "invite_revoked",
                "invitation was revoked",
            )),
            _ => Err(AppError::with_code(
                StatusCode::NOT_FOUND,
                "invite_not_found",
                "invitation not found",
            )),
        };
    }
    Err(AppError::with_code(
        StatusCode::NOT_FOUND,
        "invite_not_found",
        "invitation not found",
    ))
}

fn invitation_token_hash_matches(invitation: &OrgInvitationRow, token_hash: &[u8]) -> bool {
    invitation.token_hash == token_hash
        || invitation
            .previous_token_hashes
            .iter()
            .any(|previous| previous == token_hash)
}

fn public_invitation_row(invitation: &OrgInvitationRow, now: DateTime<Utc>) -> PublicInvitationRow {
    PublicInvitationRow {
        id: invitation.id,
        org_id: invitation.org_id,
        email: invitation.email.clone(),
        role: invitation.role.clone(),
        status: invitation_public_status(invitation, now),
        created_at: invitation.created_at,
        expires_at: invitation.expires_at,
        last_sent_at: invitation.last_sent_at,
        accepted_at: invitation.accepted_at,
        revoked_at: invitation.revoked_at,
        delivery_status: invitation.delivery_status.clone(),
    }
}

fn mask_email_hint(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "***".to_string();
    };
    let first = local.chars().next().unwrap_or('*');
    format!("{first}***@{domain}")
}

fn invitation_public_status(invitation: &OrgInvitationRow, now: DateTime<Utc>) -> String {
    if invitation.status == "pending" && invitation.expires_at <= now {
        "expired".to_string()
    } else {
        invitation.status.clone()
    }
}

fn email_has_reserved_membership(data: &StoreData, org_id: Uuid, email: &str) -> bool {
    let Some(user_id) = data.users_by_email.get(email).copied() else {
        return false;
    };
    data.memberships.values().any(|membership| {
        membership.org_id == org_id
            && membership.user_id == user_id
            && matches!(membership.status.as_str(), "active" | "invited")
    })
}

fn enforce_invitation_send_limits(
    data: &StoreData,
    org: &OrganizationRow,
    actor_user_id: Option<Uuid>,
    email: &str,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let since_day = now - ChronoDuration::days(1);
    let since_hour = now - ChronoDuration::hours(1);
    let org_count = data
        .email_deliveries
        .values()
        .filter(|delivery| delivery.org_id == org.id && delivery.created_at >= since_day)
        .count();
    let org_daily_limit =
        (org.seat_limit.max(0) as usize * 3).clamp(5, MAX_ORG_INVITE_SENDS_PER_DAY);
    if org_count >= org_daily_limit {
        return Err(AppError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "invite_rate_limited",
            "organization invitation rate limit reached",
        ));
    }
    if org.plan_tier == "free" && org_count >= MAX_FREE_ORG_INVITE_SENDS_PER_DAY {
        return Err(AppError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "invite_rate_limited",
            "free organizations can send fewer invitations per day",
        ));
    }
    if let Some(actor_user_id) = actor_user_id {
        let admin_day_count = data
            .email_deliveries
            .values()
            .filter(|delivery| {
                delivery.created_at >= since_day
                    && data
                        .org_invitations
                        .get(&delivery.invitation_id)
                        .is_some_and(|invitation| {
                            invitation.invited_by_user_id == Some(actor_user_id)
                        })
            })
            .count();
        if admin_day_count >= MAX_ADMIN_INVITE_SENDS_PER_DAY {
            return Err(AppError::with_code(
                StatusCode::TOO_MANY_REQUESTS,
                "invite_rate_limited",
                "admin invitation rate limit reached",
            ));
        }
        let admin_hour_count = data
            .email_deliveries
            .values()
            .filter(|delivery| {
                delivery.created_at >= since_hour
                    && data
                        .org_invitations
                        .get(&delivery.invitation_id)
                        .is_some_and(|invitation| {
                            invitation.invited_by_user_id == Some(actor_user_id)
                        })
            })
            .count();
        if admin_hour_count >= MAX_ADMIN_INVITE_SENDS_PER_HOUR {
            return Err(AppError::with_code(
                StatusCode::TOO_MANY_REQUESTS,
                "invite_rate_limited",
                "admin invitation rate limit reached",
            ));
        }
    }
    let recipient_org_count = data
        .email_deliveries
        .values()
        .filter(|delivery| {
            delivery.org_id == org.id
                && delivery.recipient_email == email
                && delivery.created_at >= since_day
        })
        .count();
    if recipient_org_count >= MAX_RECIPIENT_ORG_INVITE_SENDS_PER_DAY {
        return Err(AppError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "invite_rate_limited",
            "recipient invitation rate limit reached",
        ));
    }
    let recipient_global_count = data
        .email_deliveries
        .values()
        .filter(|delivery| delivery.recipient_email == email && delivery.created_at >= since_day)
        .count();
    if recipient_global_count >= MAX_RECIPIENT_GLOBAL_INVITE_SENDS_PER_DAY {
        return Err(AppError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "invite_rate_limited",
            "recipient invitation rate limit reached",
        ));
    }
    Ok(())
}

pub async fn record_invitation_token_attempt(
    store: &Store,
    token: &str,
    scope: InvitationTokenAttemptScope,
    client_key: Option<&str>,
) -> AppResult<()> {
    let token = validate_invitation_token(Some(token))?;
    let now = Utc::now();
    let mut data = store.data.lock().await;
    record_invitation_token_attempt_in_data(&mut data, &token, scope, client_key, now)
}

fn record_invitation_token_attempt_in_data(
    data: &mut StoreData,
    token: &str,
    scope: InvitationTokenAttemptScope,
    client_key: Option<&str>,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let since = now - ChronoDuration::hours(1);
    data.invitation_token_global_attempts
        .retain(|attempted_at| *attempted_at >= since);
    if data.invitation_token_global_attempts.len() >= MAX_INVITE_TOKEN_GLOBAL_ATTEMPTS_PER_HOUR {
        return Err(AppError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "invite_rate_limited",
            "too many invitation attempts",
        ));
    }
    data.invitation_token_attempts.retain(|_, attempts| {
        attempts.retain(|attempted_at| *attempted_at >= since);
        !attempts.is_empty()
    });
    data.invitation_token_client_attempts.retain(|_, attempts| {
        attempts.retain(|attempted_at| *attempted_at >= since);
        !attempts.is_empty()
    });
    let client_key = client_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(client_key) = &client_key {
        let client_attempts = data
            .invitation_token_client_attempts
            .entry(client_key.clone())
            .or_default();
        client_attempts.retain(|attempted_at| *attempted_at >= since);
        if client_attempts.len() >= MAX_INVITE_TOKEN_CLIENT_ATTEMPTS_PER_HOUR {
            return Err(AppError::with_code(
                StatusCode::TOO_MANY_REQUESTS,
                "invite_rate_limited",
                "too many invitation attempts",
            ));
        }
    }
    let token_hash = hash_secret(&format!("{}:{token}", scope.as_str()));
    let attempts = data
        .invitation_token_attempts
        .entry(token_hash)
        .or_default();
    attempts.retain(|attempted_at| *attempted_at >= since);
    if attempts.len() >= MAX_INVITE_TOKEN_ATTEMPTS_PER_HOUR {
        return Err(AppError::with_code(
            StatusCode::TOO_MANY_REQUESTS,
            "invite_rate_limited",
            "too many invitation attempts",
        ));
    }
    attempts.push(now);
    data.invitation_token_global_attempts.push(now);
    if let Some(client_key) = client_key {
        data.invitation_token_client_attempts
            .entry(client_key)
            .or_default()
            .push(now);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SessionContext;

    #[test]
    fn reserved_seat_count_includes_pending_unexpired_invitations_once() {
        let org_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let now = Utc::now();
        let mut data = StoreData::default();
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id,
            role: "owner".to_string(),
            status: "active".to_string(),
            created_at: now,
        });
        data.insert_org_invitation(invitation_row(
            org_id,
            "pending@example.com",
            "pending",
            now + ChronoDuration::days(1),
        ));
        data.insert_org_invitation(invitation_row(
            org_id,
            "expired@example.com",
            "pending",
            now - ChronoDuration::seconds(1),
        ));
        data.insert_org_invitation(invitation_row(
            org_id,
            "accepted@example.com",
            "accepted",
            now + ChronoDuration::days(1),
        ));

        assert_eq!(reserved_seat_count_in_data(&data, org_id, now), 2);
    }

    #[test]
    fn reserved_seat_count_tracks_invite_accept_without_double_counting() {
        let org_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();
        let invited_user_id = Uuid::new_v4();
        let now = Utc::now();
        let mut data = StoreData::default();
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id: owner_id,
            role: "owner".to_string(),
            status: "active".to_string(),
            created_at: now,
        });
        assert_eq!(reserved_seat_count_in_data(&data, org_id, now), 1);

        let mut invitation = invitation_row(
            org_id,
            "new-user@example.com",
            "pending",
            now + ChronoDuration::days(1),
        );
        data.insert_org_invitation(invitation.clone());
        assert_eq!(reserved_seat_count_in_data(&data, org_id, now), 2);

        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id: invited_user_id,
            role: "member".to_string(),
            status: "active".to_string(),
            created_at: now,
        });
        invitation.status = "accepted".to_string();
        invitation.accepted_at = Some(now);
        invitation.accepted_by_user_id = Some(invited_user_id);
        data.insert_org_invitation(invitation);

        assert_eq!(reserved_seat_count_in_data(&data, org_id, now), 2);
    }

    #[tokio::test]
    async fn reserve_seat_rejects_personal_workspace_even_with_legacy_capacity() {
        let owner_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        let mut org = org_row(org_id, "Personal Legacy", owner_id);
        org.account_type = "personal".to_string();
        org.seat_limit = 2;
        let now = Utc::now();
        let mut data = StoreData::default();
        data.insert_org(org);
        data.insert_user(UserRow {
            id: owner_id,
            primary_email: "owner@example.com".to_string(),
            display_name: Some("Owner".to_string()),
            avatar_url: None,
            created_at: now,
            last_seen_at: None,
        });
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id: owner_id,
            role: "owner".to_string(),
            status: "active".to_string(),
            created_at: now,
        });
        let store = store_with_data(data);

        let error = reserve_seat(
            &store,
            Some(owner_id),
            org_id,
            ReserveSeatRequest {
                email: Some("teammate@example.com".to_string()),
                role: Some("member".to_string()),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.code(), Some("personal_workspace_invite_forbidden"));
    }

    #[test]
    fn reserved_seat_count_does_not_double_count_token_invite_for_legacy_reserved_seat() {
        let org_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();
        let invited_user_id = Uuid::new_v4();
        let now = Utc::now();
        let mut data = StoreData::default();
        data.insert_user(UserRow {
            id: owner_id,
            primary_email: "owner@example.com".to_string(),
            display_name: None,
            avatar_url: None,
            created_at: now,
            last_seen_at: Some(now),
        });
        data.insert_user(UserRow {
            id: invited_user_id,
            primary_email: "legacy@example.com".to_string(),
            display_name: None,
            avatar_url: None,
            created_at: now,
            last_seen_at: Some(now),
        });
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id: owner_id,
            role: "owner".to_string(),
            status: "active".to_string(),
            created_at: now,
        });
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id: invited_user_id,
            role: "member".to_string(),
            status: "invited".to_string(),
            created_at: now,
        });
        data.insert_org_invitation(invitation_row(
            org_id,
            "legacy@example.com",
            "pending",
            now + ChronoDuration::days(1),
        ));

        assert_eq!(reserved_seat_count_in_data(&data, org_id, now), 2);
    }

    #[test]
    fn public_invitation_status_marks_expired_pending_rows() {
        let now = Utc::now();
        let invitation = invitation_row(
            Uuid::new_v4(),
            "teammate@example.com",
            "pending",
            now - ChronoDuration::seconds(1),
        );

        let public = public_invitation_row(&invitation, now);

        assert_eq!(public.status, "expired");
        assert_eq!(public.email, "teammate@example.com");
    }

    #[test]
    fn invitation_role_rejects_owner() {
        assert_eq!(validate_invitation_role(Some("viewer")).unwrap(), "viewer");
        assert!(validate_invitation_role(Some("owner")).is_err());
    }

    #[test]
    fn invitation_token_index_keeps_previous_hashes_valid_for_failed_resends() {
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        let mut invitation = invitation_row(
            org_id,
            "teammate@example.com",
            "pending",
            Utc::now() + ChronoDuration::days(1),
        );
        let old_hash = vec![1, 2, 3];
        let new_hash = vec![4, 5, 6];
        invitation.token_hash = old_hash.clone();
        data.insert_org_invitation(invitation.clone());

        invitation.previous_token_hashes.push(old_hash.clone());
        invitation.token_hash = new_hash.clone();
        data.insert_org_invitation(invitation.clone());

        assert_eq!(
            invitation_by_token_hash(&data, &old_hash).unwrap().id,
            invitation.id
        );
        assert_eq!(
            invitation_by_token_hash(&data, &new_hash).unwrap().id,
            invitation.id
        );
    }

    #[test]
    fn invitation_token_index_drops_previous_hashes_after_successful_resend() {
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        let mut invitation = invitation_row(
            org_id,
            "teammate@example.com",
            "pending",
            Utc::now() + ChronoDuration::days(1),
        );
        let old_hash = vec![1, 2, 3];
        let new_hash = vec![4, 5, 6];
        invitation.token_hash = old_hash.clone();
        data.insert_org_invitation(invitation.clone());

        invitation.previous_token_hashes.push(old_hash.clone());
        invitation.token_hash = new_hash.clone();
        data.insert_org_invitation(invitation.clone());
        assert!(invitation_by_token_hash(&data, &old_hash).is_ok());

        invitation.previous_token_hashes.clear();
        data.insert_org_invitation(invitation.clone());

        assert!(invitation_by_token_hash(&data, &old_hash).is_err());
        assert_eq!(
            invitation_by_token_hash(&data, &new_hash).unwrap().id,
            invitation.id
        );
    }

    #[test]
    fn invitation_token_index_omits_accepted_rows_but_allows_retry_lookup() {
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        let mut invitation = invitation_row(
            org_id,
            "teammate@example.com",
            "pending",
            Utc::now() + ChronoDuration::days(1),
        );
        let token_hash = vec![7, 8, 9];
        invitation.token_hash = token_hash.clone();
        data.insert_org_invitation(invitation.clone());
        assert!(invitation_by_token_hash(&data, &token_hash).is_ok());

        invitation.status = "accepted".to_string();
        invitation.accepted_at = Some(Utc::now());
        invitation.accepted_by_user_id = Some(Uuid::new_v4());
        data.insert_org_invitation(invitation);

        assert!(!data.org_invitations_by_token_hash.contains_key(&token_hash));
        assert_eq!(
            invitation_by_token_hash(&data, &token_hash).unwrap().status,
            "accepted"
        );
    }

    #[test]
    fn invitation_token_index_omits_expired_pending_rows() {
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        let mut invitation = invitation_row(
            org_id,
            "teammate@example.com",
            "pending",
            Utc::now() - ChronoDuration::seconds(1),
        );
        let token_hash = vec![10, 11, 12];
        invitation.token_hash = token_hash.clone();
        data.insert_org_invitation(invitation);

        assert!(!data.org_invitations_by_token_hash.contains_key(&token_hash));
        let error = invitation_by_token_hash(&data, &token_hash).unwrap_err();
        assert_eq!(error.code(), Some("invite_expired"));
    }

    #[tokio::test]
    async fn accept_expired_indexed_invitation_returns_expired_before_billing_gate() {
        let token = "instantml_invite_test_token_abcdefghijklmnopqrstuvwxyz";
        let token_hash = hash_secret(token);
        let org_id = Uuid::new_v4();
        let mut data = StoreData::default();
        let mut invitation = invitation_row(
            org_id,
            "teammate@example.com",
            "pending",
            Utc::now() + ChronoDuration::days(1),
        );
        invitation.token_hash = token_hash.clone();
        data.insert_org_invitation(invitation.clone());

        invitation.expires_at = Utc::now() - ChronoDuration::seconds(1);
        data.org_invitations.insert(invitation.id, invitation);
        assert!(data.org_invitations_by_token_hash.contains_key(&token_hash));

        let store = store_with_data(data);
        let error = accept_invitation_for_user(&store, token, Uuid::new_v4())
            .await
            .unwrap_err();

        assert_eq!(error.code(), Some("invite_expired"));
        assert!(!store
            .data
            .lock()
            .await
            .org_invitations_by_token_hash
            .contains_key(&token_hash));
    }

    #[test]
    fn invitation_send_limits_count_delivery_attempts() {
        let now = Utc::now();
        let org_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let mut org = org_row(org_id, "InstantML Org", actor_id);
        org.seat_limit = 10;
        let mut data = StoreData::default();
        let invitation = invitation_row(
            org_id,
            "recipient@example.com",
            "pending",
            now + ChronoDuration::days(1),
        );
        let invitation_id = invitation.id;
        data.insert_org_invitation(OrgInvitationRow {
            invited_by_user_id: Some(actor_id),
            ..invitation
        });
        for _ in 0..MAX_RECIPIENT_ORG_INVITE_SENDS_PER_DAY {
            data.insert_email_delivery(email_delivery_row(
                org_id,
                invitation_id,
                "recipient@example.com",
                now,
            ));
        }

        let error = enforce_invitation_send_limits(
            &data,
            &org,
            Some(actor_id),
            "recipient@example.com",
            now,
        )
        .unwrap_err();

        assert_eq!(error.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(error.code(), Some("invite_rate_limited"));
    }

    #[test]
    fn preview_token_attempts_do_not_lock_accept_scope() {
        let mut data = StoreData::default();
        let now = Utc::now();
        let token = "instantml_invite_test";
        for _ in 0..MAX_INVITE_TOKEN_ATTEMPTS_PER_HOUR {
            record_invitation_token_attempt_in_data(
                &mut data,
                token,
                InvitationTokenAttemptScope::Preview,
                Some("ip:test"),
                now,
            )
            .unwrap();
        }

        assert!(record_invitation_token_attempt_in_data(
            &mut data,
            token,
            InvitationTokenAttemptScope::Preview,
            Some("ip:test"),
            now,
        )
        .is_err());
        assert!(record_invitation_token_attempt_in_data(
            &mut data,
            token,
            InvitationTokenAttemptScope::Accept,
            Some("ip:test"),
            now,
        )
        .is_ok());
    }

    #[test]
    fn rejected_per_token_attempts_do_not_burn_global_budget() {
        let mut data = StoreData::default();
        let now = Utc::now();
        let token = "instantml_invite_test";
        for _ in 0..MAX_INVITE_TOKEN_ATTEMPTS_PER_HOUR {
            record_invitation_token_attempt_in_data(
                &mut data,
                token,
                InvitationTokenAttemptScope::Preview,
                Some("ip:test"),
                now,
            )
            .unwrap();
        }

        for _ in 0..25 {
            assert!(record_invitation_token_attempt_in_data(
                &mut data,
                token,
                InvitationTokenAttemptScope::Preview,
                Some("ip:test"),
                now,
            )
            .is_err());
        }

        assert_eq!(
            data.invitation_token_global_attempts.len(),
            MAX_INVITE_TOKEN_ATTEMPTS_PER_HOUR
        );
    }

    #[test]
    fn public_preview_masks_email_address() {
        assert_eq!(mask_email_hint("teammate@example.com"), "t***@example.com");
        assert_eq!(mask_email_hint("bad-email"), "***");
    }

    #[test]
    fn accepted_invite_membership_scopes_run_reads_to_org() {
        let now = Utc::now();
        let org_id = Uuid::new_v4();
        let other_org_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let other_run_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let mut data = StoreData::default();
        data.insert_org(org_row(org_id, "InstantML Org", user_id));
        data.insert_org(org_row(other_org_id, "Other Org", Uuid::new_v4()));
        data.insert_user(UserRow {
            id: user_id,
            primary_email: "teammate@example.com".to_string(),
            display_name: None,
            avatar_url: None,
            created_at: now,
            last_seen_at: Some(now),
        });
        data.insert_membership(MembershipRow {
            id: Uuid::new_v4(),
            org_id,
            user_id,
            role: "viewer".to_string(),
            status: "active".to_string(),
            created_at: now,
        });
        data.insert_run(run_row(run_id, org_id, project_id, "visible"));
        data.insert_run(run_row(
            other_run_id,
            other_org_id,
            Uuid::new_v4(),
            "hidden",
        ));

        let session = UserSessionRow {
            id: Uuid::new_v4(),
            user_id,
            org_id,
            metadata: json!({}),
            created_at: now,
            last_seen_at: Some(now),
            expires_at: now + ChronoDuration::days(1),
            revoked_at: None,
        };
        let payload = session_payload_from_data(&data, session).unwrap();
        let ctx = RequestContext {
            org_id: payload.organization.id,
            auth: None,
            session: Some(SessionContext {
                session_id: payload.session.id,
                user_id: payload.user.id,
                role: payload.membership.role,
                demo_read_only: false,
            }),
        };

        assert!(fetch_run_in_data(&data, &ctx, run_id).is_ok());
        assert!(fetch_run_in_data(&data, &ctx, other_run_id).is_err());
    }

    fn invitation_row(
        org_id: Uuid,
        email: &str,
        status: &str,
        expires_at: DateTime<Utc>,
    ) -> OrgInvitationRow {
        OrgInvitationRow {
            id: Uuid::new_v4(),
            org_id,
            email: email.to_string(),
            role: "member".to_string(),
            status: status.to_string(),
            token_hash: vec![email.len() as u8],
            previous_token_hashes: Vec::new(),
            invited_by_user_id: None,
            created_at: Utc::now(),
            expires_at,
            last_sent_at: None,
            accepted_at: None,
            accepted_by_user_id: None,
            revoked_at: None,
            revoked_by_user_id: None,
            delivery_status: "sent".to_string(),
            email_provider: Some("log".to_string()),
            provider_message_id: None,
        }
    }

    fn store_with_data(data: StoreData) -> Store {
        let metric_store = crate::metric_store::connect_url(
            "http://default:password@127.0.0.1:8123/default",
            "TEST_CLICKHOUSE_URL",
        )
        .unwrap();
        Store {
            metric_store,
            control_store: None,
            control_db: None,
            hosted_clickhouse: None,
            byoc_clickhouse: crate::config::ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "local-dev".to_string(),
                allow_private_endpoints: false,
                credential_store: crate::config::ByocCredentialStoreConfig::Disabled,
            },
            tenant_metric_stores: Arc::new(Mutex::new(HashMap::new())),
            customer_tenant_endpoints: Arc::new(Mutex::new(HashMap::new())),
            tenant_loaded: Arc::new(Mutex::new(BTreeSet::new())),
            shared_cell_metric_store: None,
            inflight_idempotency: Arc::new(Mutex::new(BTreeSet::new())),
            artifact_upload_capacity_lock: Arc::new(Mutex::new(())),
            data: Arc::new(Mutex::new(data)),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    fn org_row(id: Uuid, name: &str, owner_id: Uuid) -> OrganizationRow {
        OrganizationRow {
            id,
            slug: slugify(name),
            name: name.to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: 2,
            created_by_user_id: Some(owner_id),
            created_at: Utc::now(),
            tenant_routing_tier: "shared".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    fn run_row(id: Uuid, org_id: Uuid, project_id: Uuid, name: &str) -> RunRow {
        RunRow {
            id,
            org_id,
            project_id,
            project: "default".to_string(),
            name: name.to_string(),
            status: "finished".to_string(),
            config: json!({}),
            tags: Vec::new(),
            metadata: json!({}),
            created_at: Utc::now(),
            started_at: Utc::now(),
            finished_at: Some(Utc::now()),
            parent_run_id: None,
            forked_from_step: None,
            forked_from_artifact_id: None,
        }
    }

    fn email_delivery_row(
        org_id: Uuid,
        invitation_id: Uuid,
        recipient_email: &str,
        created_at: DateTime<Utc>,
    ) -> EmailDeliveryRow {
        EmailDeliveryRow {
            id: Uuid::new_v4(),
            org_id,
            invitation_id,
            recipient_email: recipient_email.to_string(),
            provider: "log".to_string(),
            status: "sent".to_string(),
            provider_message_id: None,
            error_code: None,
            created_at,
        }
    }
}
