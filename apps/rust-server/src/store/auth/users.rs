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
    let mut data = store.data.lock().await;
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
    data.insert_user(user.clone());
    data.identities
        .insert((identity.provider, identity.provider_subject), user.id);
    Ok(user)
}

pub async fn list_users(store: &Store) -> AppResult<Vec<UserRow>> {
    Ok(store.data.lock().await.users.values().cloned().collect())
}
