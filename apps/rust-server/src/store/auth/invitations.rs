use super::super::*;
use super::helpers::get_or_create_placeholder_user;

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
    data: &mut StoreData,
    user_id: Uuid,
    org_id: Uuid,
) -> AppResult<Option<OrganizationRow>> {
    let Some(mut membership) = data
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
    membership.status = "active".to_string();
    store
        .persist_locked(
            "membership",
            org_id,
            &membership.id.to_string(),
            &membership,
        )
        .await?;
    data.insert_membership(membership);
    Ok(Some(org))
}

pub async fn reserve_seat(
    store: &Store,
    user_id: Option<Uuid>,
    org_id: Uuid,
    input: ReserveSeatRequest,
) -> AppResult<SeatRow> {
    let email = validate_email(input.email.as_deref())?;
    let role = validate_membership_role(input.role.as_deref().or(Some("member")))?;
    if role == "owner" {
        return Err(AppError::validation(
            "invited seats can use admin, member, or viewer roles",
        ));
    }
    let mut data = store.data.lock().await;
    let seat_limit = data
        .organizations
        .get(&org_id)
        .ok_or_else(|| AppError::not_found("organization not found"))?
        .seat_limit as usize;
    if let Some(user_id) = user_id {
        require_admin_in_data(&data, user_id, org_id)?;
    }
    let invited_user = get_or_create_placeholder_user(store, &mut data, &email).await?;
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
    let active_or_invited = data
        .memberships
        .values()
        .filter(|membership| {
            membership.org_id == org_id
                && matches!(membership.status.as_str(), "active" | "invited")
        })
        .count();
    if active_or_invited >= seat_limit {
        return Err(AppError::conflict("organization seat limit reached"));
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
    data.insert_membership(membership.clone());
    seat_row_from_data(&data, membership)
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
