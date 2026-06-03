use super::super::*;

pub async fn create_user(store: &Store, input: CreateUserRequest) -> AppResult<UserRow> {
    let email = validate_email(input.email.or(input.primary_email).as_deref())?;
    let provider = validate_name(
        Some(input.provider.as_deref().unwrap_or("local")),
        "provider",
    )?;
    let provider_subject = validate_name(
        Some(input.provider_subject.as_deref().unwrap_or(&email)),
        "provider_subject",
    )?;
    if let Some(control_db) = store.control_db() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: email.clone(),
            display_name: input.display_name,
            avatar_url: input.avatar_url,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let identity = crate::control_repo::NewIdentity {
            provider: provider.clone(),
            provider_subject: provider_subject.clone(),
        };
        // Atomic find-or-create: a brand-new user and its identity commit in a
        // single transaction, so a crash can't leave a user without a resolvable
        // identity. An existing identity/email match returns that user instead.
        let created = control_db
            .create_user_with_identity(&user, &identity)
            .await?;
        // Mirror into the read projection. The returned id equals the one we
        // minted only on a fresh insert (a random UUID can't match an existing
        // row), which is exactly when the identity was linked — so the in-memory
        // identity map stays consistent with Postgres and with legacy behavior.
        let is_new = created.id == user.id;
        let mut data = store.data.lock().await;
        data.insert_user(created.clone());
        if is_new {
            data.identities
                .insert((provider, provider_subject), created.id);
        }
        return Ok(created);
    }
    {
        let data = store.data.lock().await;
        if let Some(user_id) = data
            .identities
            .get(&(provider.clone(), provider_subject.clone()))
            .copied()
            .or_else(|| data.users_by_email.get(&email).copied())
        {
            return data
                .users
                .get(&user_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("user not found"));
        }
    }
    let user = UserRow {
        id: Uuid::new_v4(),
        primary_email: email.clone(),
        display_name: input.display_name,
        avatar_url: input.avatar_url,
        created_at: Utc::now(),
        last_seen_at: None,
    };
    let identity = IdentityRecord {
        user_id: user.id,
        provider,
        provider_subject,
    };
    store
        .persist_locked("user", LOCAL_ORG_ID, &user.id.to_string(), &user)
        .await?;
    store
        .persist_locked("identity", LOCAL_ORG_ID, &user.id.to_string(), &identity)
        .await?;
    let mut data = store.data.lock().await;
    data.insert_user(user.clone());
    data.identities
        .insert((identity.provider, identity.provider_subject), user.id);
    Ok(user)
}

pub async fn list_users(store: &Store) -> AppResult<Vec<UserRow>> {
    Ok(store.data.lock().await.users.values().cloned().collect())
}
