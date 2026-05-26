use super::*;
use axum::http::StatusCode;

pub async fn ensure_billing_write_allowed(
    store: &Store,
    org_id: Uuid,
    action: &str,
) -> AppResult<()> {
    let data = store.data.lock().await;
    let Some(account) = data.billing_accounts.get(&org_id) else {
        return Ok(());
    };
    if matches!(
        account.access_state.as_str(),
        BILLING_CHECKOUT_PENDING | BILLING_READ_ONLY_PAYMENT_REQUIRED | BILLING_CANCELED
    ) {
        return Err(AppError::with_code(
            StatusCode::PAYMENT_REQUIRED,
            "payment_required",
            format!(
                "payment is required before this workspace can {action}; current billing state is {}",
                account.access_state
            ),
        ));
    }
    Ok(())
}

pub async fn billing_status(store: &Store, ctx: &RequestContext) -> AppResult<Value> {
    let session = ctx
        .session
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("browser session required"))?;
    require_org_admin(store, session.user_id, ctx.org_id).await?;
    let data = store.data.lock().await;
    let org = data
        .organizations
        .get(&ctx.org_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("organization not found"))?;
    let billing = data
        .billing_accounts
        .get(&ctx.org_id)
        .cloned()
        .unwrap_or_else(|| default_billing_account(&org));
    Ok(json!({
        "billing": billing,
        "plans": {
            "free": PLAN_FREE,
            "pro": PLAN_PRO,
            "premium": PLAN_PREMIUM
        },
        "actions": {
            "checkout": true,
            "portal": billing.stripe_customer_id.is_some(),
            "change_plan": true,
            "add_seat": true,
            "cancel": billing.stripe_subscription_id.is_some()
        }
    }))
}

pub async fn create_billing_checkout(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
    input: BillingCheckoutRequest,
) -> AppResult<BillingCheckoutInfo> {
    let session = ctx
        .session
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("browser session required"))?;
    require_org_admin(store, session.user_id, ctx.org_id).await?;
    let target_plan_tier = validate_plan_tier(input.plan_tier.as_deref())?;
    if target_plan_tier == "free" {
        return Err(AppError::validation("checkout requires a paid plan"));
    }
    create_checkout_for_org(
        store,
        config,
        ctx.org_id,
        session.user_id,
        &target_plan_tier,
        "upgrade",
        normalize_checkout_seats(input.seat_emails)?,
    )
    .await
}

pub async fn create_checkout_for_org(
    store: &Store,
    config: &crate::config::BillingConfig,
    org_id: Uuid,
    user_id: Uuid,
    target_plan_tier: &str,
    action: &str,
    pending_seat_emails: Vec<String>,
) -> AppResult<BillingCheckoutInfo> {
    if !config.enabled {
        return Err(AppError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "billing_unavailable",
            "billing is not enabled",
        ));
    }
    let (org, user, account) = {
        let data = store.data.lock().await;
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        let user = data
            .users
            .get(&user_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("user not found"))?;
        let account = data
            .billing_accounts
            .get(&org_id)
            .cloned()
            .unwrap_or_else(|| default_billing_account(&org));
        (org, user, account)
    };
    let intent_id = Uuid::new_v4();
    let mut intent = BillingCheckoutIntent {
        schema_version: 1,
        id: intent_id,
        org_id,
        user_id,
        action: action.to_string(),
        target_plan_tier: target_plan_tier.to_string(),
        pending_seat_emails,
        stripe_checkout_session_id: None,
        stripe_customer_id: account.stripe_customer_id.clone(),
        stripe_subscription_id: account.stripe_subscription_id.clone(),
        status: "pending".to_string(),
        url: None,
        created_at: Utc::now(),
        expires_at: None,
    };
    intent.status = "checkout_initializing".to_string();
    persist_billing_checkout_intent(store, &intent).await?;
    let blocks_until_checkout = matches!(action, "paid_signup" | "new_org");
    if blocks_until_checkout {
        persist_billing_account(
            store,
            pending_checkout_account(
                &org,
                &account,
                target_plan_tier,
                &intent,
                "Complete Stripe Checkout to unlock this workspace.",
            ),
        )
        .await?;
    }

    let session = match crate::stripe_billing::create_subscription_checkout(
        config,
        crate::stripe_billing::SubscriptionCheckoutParams {
            customer_id: account.stripe_customer_id.clone(),
            customer_email: Some(user.primary_email),
            org_id: org_id.to_string(),
            user_id: user_id.to_string(),
            intent_id: intent.id.to_string(),
            action: action.to_string(),
            target_plan_tier: target_plan_tier.to_string(),
            success_url: config.success_url.clone(),
            cancel_url: config.cancel_url.clone(),
        },
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            intent.status = "checkout_failed".to_string();
            let _ = persist_billing_checkout_intent(store, &intent).await;
            if blocks_until_checkout {
                let _ = persist_billing_account(
                    store,
                    pending_checkout_account(
                        &org,
                        &account,
                        target_plan_tier,
                        &intent,
                        "Stripe Checkout could not be created. Retry checkout from billing.",
                    ),
                )
                .await;
            }
            return Err(error);
        }
    };
    intent.stripe_checkout_session_id = Some(session.id.clone());
    intent.stripe_customer_id = session
        .customer_id
        .clone()
        .or_else(|| account.stripe_customer_id.clone());
    intent.stripe_subscription_id = session.subscription_id.clone();
    intent.url = session.url.clone();
    intent.status = "checkout_created".to_string();
    persist_billing_checkout_intent(store, &intent).await?;
    if blocks_until_checkout {
        persist_billing_account(
            store,
            pending_checkout_account(
                &org,
                &account,
                target_plan_tier,
                &intent,
                "Complete Stripe Checkout to unlock this workspace.",
            ),
        )
        .await?;
    }
    Ok(BillingCheckoutInfo {
        intent_id: intent.id,
        status: intent.status,
        session_id: intent.stripe_checkout_session_id,
        url: intent.url,
    })
}

fn pending_checkout_account(
    org: &OrganizationRow,
    account: &BillingAccountProjection,
    target_plan_tier: &str,
    intent: &BillingCheckoutIntent,
    message: &str,
) -> BillingAccountProjection {
    BillingAccountProjection {
        schema_version: 1,
        org_id: org.id,
        access_state: BILLING_CHECKOUT_PENDING.to_string(),
        plan_tier: org.plan_tier.clone(),
        effective_plan_tier: "free".to_string(),
        requested_plan_tier: Some(target_plan_tier.to_string()),
        paid_extra_seats: 0,
        stripe_customer_id: intent
            .stripe_customer_id
            .clone()
            .or_else(|| account.stripe_customer_id.clone()),
        stripe_subscription_id: intent
            .stripe_subscription_id
            .clone()
            .or_else(|| account.stripe_subscription_id.clone()),
        subscription_status: account.subscription_status.clone(),
        current_period_start: account.current_period_start,
        current_period_end: account.current_period_end,
        cancel_at_period_end: false,
        grace_until: None,
        pending_intent_id: Some(intent.id),
        message: Some(message.to_string()),
        updated_at: Utc::now(),
    }
}

pub async fn sync_checkout_session(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
    input: BillingCheckoutSyncRequest,
) -> AppResult<Value> {
    let session_id = validate_name(input.session_id.as_deref(), "session_id")?;
    let session = crate::stripe_billing::retrieve_checkout_session(config, &session_id).await?;
    let account = apply_checkout_session(
        store,
        &session.id,
        session.customer_id,
        session.subscription_id,
        session.payment_status,
        session.status,
        session.metadata,
    )
    .await?;
    if account.org_id != ctx.org_id {
        return Err(AppError::forbidden(
            "Checkout Session belongs to a different organization",
        ));
    }
    Ok(json!({ "billing": account }))
}

pub async fn create_billing_portal(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
    input: BillingPortalRequest,
) -> AppResult<Value> {
    let session = ctx
        .session
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("browser session required"))?;
    require_org_admin(store, session.user_id, ctx.org_id).await?;
    let customer_id = {
        let data = store.data.lock().await;
        data.billing_accounts
            .get(&ctx.org_id)
            .and_then(|account| account.stripe_customer_id.clone())
            .ok_or_else(|| AppError::validation("Stripe customer is not available"))?
    };
    let return_url = input
        .return_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.portal_return_url.clone());
    let portal =
        crate::stripe_billing::create_portal_session(config, &customer_id, &return_url).await?;
    Ok(json!({ "url": portal.url }))
}

pub async fn change_billing_plan(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
    input: BillingPlanChangeRequest,
) -> AppResult<Value> {
    let target = validate_plan_tier(input.plan_tier.as_deref())?;
    let session = ctx
        .session
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("browser session required"))?;
    require_org_admin(store, session.user_id, ctx.org_id).await?;
    if target == "free" {
        let (org, subscription_id) = {
            let data = store.data.lock().await;
            let org = data
                .organizations
                .get(&ctx.org_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("organization not found"))?;
            let subscription_id = data
                .billing_accounts
                .get(&ctx.org_id)
                .and_then(|account| account.stripe_subscription_id.clone());
            (org, subscription_id)
        };
        if let Some(subscription_id) = subscription_id {
            let subscription =
                crate::stripe_billing::cancel_subscription(config, &subscription_id, true).await?;
            let mut account =
                apply_subscription_object(store, ctx.org_id, &subscription.raw).await?;
            account.requested_plan_tier = Some("free".to_string());
            account.message = Some(
                "Downgrade to Free is scheduled for the end of the current billing period."
                    .to_string(),
            );
            account.updated_at = Utc::now();
            persist_billing_account(store, account.clone()).await?;
            return Ok(json!({ "billing": account }));
        }
        let account = apply_local_free_plan(store, org).await?;
        return Ok(json!({ "billing": account }));
    }
    let subscription_id = {
        let data = store.data.lock().await;
        data.billing_accounts
            .get(&ctx.org_id)
            .and_then(|account| account.stripe_subscription_id.clone())
    };
    if let Some(subscription_id) = subscription_id {
        let subscription = crate::stripe_billing::update_subscription_plan(
            config,
            &subscription_id,
            &target,
            &ctx.org_id.to_string(),
            &session.user_id.to_string(),
        )
        .await?;
        let account = apply_subscription_object(store, ctx.org_id, &subscription.raw).await?;
        if account.access_state != BILLING_PAID_ACTIVE {
            return Err(AppError::with_code(
                StatusCode::PAYMENT_REQUIRED,
                "payment_required",
                "Stripe could not confirm the plan change payment yet",
            ));
        }
        return Ok(json!({ "billing": account }));
    }
    let checkout = create_checkout_for_org(
        store,
        config,
        ctx.org_id,
        session.user_id,
        &target,
        "plan_change",
        Vec::new(),
    )
    .await?;
    Ok(json!({ "checkout": checkout }))
}

pub async fn add_billing_seat(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
    input: BillingSeatChangeRequest,
) -> AppResult<Value> {
    let session = ctx
        .session
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("browser session required"))?;
    require_org_admin(store, session.user_id, ctx.org_id).await?;
    let email = validate_email(input.email.as_deref())?;
    let role = validate_membership_role(input.role.as_deref().or(Some("member")))?;
    let (active_or_invited, seat_limit, plan_tier_id, subscription_id) = {
        let data = store.data.lock().await;
        let org = data
            .organizations
            .get(&ctx.org_id)
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        let active_or_invited = active_or_invited_seats(&data, ctx.org_id);
        let subscription_id = data
            .billing_accounts
            .get(&ctx.org_id)
            .and_then(|account| account.stripe_subscription_id.clone());
        (
            active_or_invited,
            org.seat_limit,
            org.plan_tier.clone(),
            subscription_id,
        )
    };
    let mut billing = None;
    if active_or_invited >= seat_limit as usize {
        let subscription_id = subscription_id.ok_or_else(|| {
            AppError::with_code(
                StatusCode::PAYMENT_REQUIRED,
                "payment_required",
                "organization seat limit reached; upgrade the plan before adding another seat",
            )
        })?;
        let plan = plan_tier(&plan_tier_id);
        let target_extra_seats = ((active_or_invited + 1) as i32 - plan.included_seats).max(0);
        let subscription = crate::stripe_billing::update_subscription_extra_seats(
            config,
            &subscription_id,
            target_extra_seats,
        )
        .await?;
        let account = apply_subscription_object(store, ctx.org_id, &subscription.raw).await?;
        if account.access_state != BILLING_PAID_ACTIVE {
            return Err(AppError::with_code(
                StatusCode::PAYMENT_REQUIRED,
                "payment_required",
                "Stripe could not confirm the extra-seat payment yet",
            ));
        }
        billing = Some(account);
    }
    let seat = reserve_seat(
        store,
        Some(session.user_id),
        ctx.org_id,
        ReserveSeatRequest {
            email: Some(email),
            role: Some(role),
        },
    )
    .await?;
    Ok(json!({ "seat": seat, "billing": billing }))
}

pub async fn cancel_billing(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
    input: BillingCancelRequest,
) -> AppResult<Value> {
    let session = ctx
        .session
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("browser session required"))?;
    require_org_admin(store, session.user_id, ctx.org_id).await?;
    let mut account = {
        let data = store.data.lock().await;
        data.billing_accounts
            .get(&ctx.org_id)
            .cloned()
            .ok_or_else(|| AppError::validation("billing account is not available"))?
    };
    let at_period_end = input.at_period_end.unwrap_or(true);
    if let Some(subscription_id) = account.stripe_subscription_id.clone() {
        let subscription =
            crate::stripe_billing::cancel_subscription(config, &subscription_id, at_period_end)
                .await?;
        if at_period_end {
            account = apply_subscription_object(store, ctx.org_id, &subscription.raw).await?;
            account.requested_plan_tier = Some("free".to_string());
            account.message =
                Some("Subscription cancellation is scheduled at period end.".to_string());
            account.updated_at = Utc::now();
            persist_billing_account(store, account.clone()).await?;
        } else {
            account = downgrade_org_after_subscription_end(store, ctx.org_id).await?;
        }
    } else {
        account.cancel_at_period_end = at_period_end;
        account.message = Some("Subscription cancellation requested.".to_string());
        account.updated_at = Utc::now();
        persist_billing_account(store, account.clone()).await?;
    }
    Ok(json!({ "billing": account }))
}

pub async fn report_storage_overage(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
) -> AppResult<Value> {
    report_usage_overage(store, config, ctx).await
}

pub async fn report_usage_overage(
    store: &Store,
    config: &crate::config::BillingConfig,
    ctx: &RequestContext,
) -> AppResult<Value> {
    let session = ctx
        .session
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("browser session required"))?;
    require_org_admin(store, session.user_id, ctx.org_id).await?;
    let usage = billing_overage_usage_for_org(store, ctx.org_id).await?;
    let previous = latest_usage_report_for_period(store, ctx.org_id, usage.period_start).await;
    let previous_storage_gib = previous
        .as_ref()
        .map(|report| report.reported_gib)
        .unwrap_or(0);
    let previous_api_requests = previous
        .as_ref()
        .map(|report| report.reported_api_requests)
        .unwrap_or(0);
    let storage_delta = (usage.reported_gib - previous_storage_gib).max(0);
    let api_request_delta = (usage.billable_api_requests - previous_api_requests).max(0);
    if storage_delta == 0 && api_request_delta == 0 {
        if let Some(existing) = previous {
            return Ok(json!({
                "usage_report": existing,
                "duplicate": true,
                "usage": usage_overage_value(&usage)
            }));
        }
    }
    let account = if storage_delta > 0 || api_request_delta > 0 {
        Some({
            let data = store.data.lock().await;
            data.billing_accounts
                .get(&ctx.org_id)
                .cloned()
                .ok_or_else(|| AppError::validation("billing account is not available"))?
        })
    } else {
        None
    };
    let customer_id = account
        .as_ref()
        .and_then(|account| account.stripe_customer_id.as_deref());
    let timestamp = Utc::now().timestamp();
    let stripe_storage_event_id = if storage_delta > 0 {
        let customer_id = customer_id.ok_or_else(|| {
            AppError::validation("Stripe customer is required before reporting storage overage")
        })?;
        let identifier = usage_report_event_identifier(
            "storage",
            ctx.org_id,
            usage.period_start,
            previous_storage_gib,
            usage.reported_gib,
        );
        Some(
            crate::stripe_billing::record_storage_meter_event(
                config,
                customer_id,
                &ctx.org_id.to_string(),
                storage_delta,
                &identifier,
                timestamp,
            )
            .await?,
        )
    } else {
        None
    };
    let stripe_api_request_event_id = if api_request_delta > 0 {
        let customer_id = customer_id.ok_or_else(|| {
            AppError::validation("Stripe customer is required before reporting API request overage")
        })?;
        let identifier = usage_report_event_identifier(
            "api_requests",
            ctx.org_id,
            usage.period_start,
            previous_api_requests,
            usage.billable_api_requests,
        );
        Some(
            crate::stripe_billing::record_api_request_meter_event(
                config,
                customer_id,
                &ctx.org_id.to_string(),
                api_request_delta,
                &identifier,
                timestamp,
            )
            .await?,
        )
    } else {
        None
    };
    let report = BillingUsageReportRecord {
        schema_version: 1,
        id: Uuid::new_v4(),
        org_id: ctx.org_id,
        usage_period_start: usage.period_start,
        usage_period_end: usage.period_end,
        billable_storage_bytes: usage.billable_storage_bytes,
        reported_gib: usage.reported_gib,
        reported_storage_gib_delta: storage_delta,
        billable_api_requests: usage.billable_api_requests,
        reported_api_requests: usage.billable_api_requests,
        reported_api_requests_delta: api_request_delta,
        stripe_event_id: stripe_storage_event_id
            .clone()
            .or_else(|| stripe_api_request_event_id.clone()),
        stripe_storage_event_id,
        stripe_api_request_event_id,
        status: if storage_delta > 0 || api_request_delta > 0 {
            "reported".to_string()
        } else {
            "no_overage".to_string()
        },
        created_at: Utc::now(),
    };
    store
        .persist_locked(
            "billing_usage_report",
            ctx.org_id,
            &report.id.to_string(),
            &report,
        )
        .await?;
    store
        .data
        .lock()
        .await
        .insert_billing_usage_report(report.clone());
    Ok(json!({
        "usage_report": report,
        "usage": usage_overage_value(&usage)
    }))
}

pub async fn process_stripe_webhook(store: &Store, event: Value) -> AppResult<Value> {
    let event_id = validate_name(event.get("id").and_then(Value::as_str), "event id")?;
    let event_type = validate_name(event.get("type").and_then(Value::as_str), "event type")?;
    {
        let data = store.data.lock().await;
        if data.billing_events.contains_key(&event_id) {
            return Ok(json!({ "processed": false, "duplicate": true }));
        }
    }
    let object = event
        .pointer("/data/object")
        .cloned()
        .ok_or_else(|| AppError::validation("Stripe event object is required"))?;
    let mut org_id = org_id_from_metadata(&object);
    let mut stripe_object_id = object.get("id").and_then(Value::as_str).map(str::to_string);
    let mut applied = None;
    match event_type.as_str() {
        "checkout.session.completed" => {
            let session_id = validate_name(object.get("id").and_then(Value::as_str), "session id")?;
            let account = apply_checkout_session(
                store,
                &session_id,
                stripe_id_field(&object, "customer"),
                stripe_id_field(&object, "subscription"),
                object
                    .get("payment_status")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                object
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                object.get("metadata").cloned().unwrap_or(Value::Null),
            )
            .await?;
            org_id = Some(account.org_id);
            applied = Some(json!({ "billing": account }));
        }
        "customer.subscription.updated" | "customer.subscription.created" => {
            if let Some(id) = org_id {
                let account = apply_subscription_object(store, id, &object).await?;
                applied = Some(json!({ "billing": account }));
            }
        }
        "customer.subscription.deleted" => {
            if let Some(id) = org_id {
                let account = downgrade_org_after_subscription_end(store, id).await?;
                applied = Some(json!({ "billing": account }));
            }
        }
        "invoice.payment_failed" => {
            if let Some(id) = org_id {
                let account = mark_payment_failed(store, id).await?;
                applied = Some(json!({ "billing": account }));
            }
        }
        "invoice.paid" => {
            stripe_object_id = object
                .get("subscription")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(stripe_object_id);
            if let Some(id) = org_id {
                let account = mark_invoice_paid(store, id).await?;
                applied = Some(json!({ "billing": account }));
            }
        }
        _ => {}
    }
    let record = BillingEventRecord {
        schema_version: 1,
        stripe_event_id: event_id.clone(),
        event_type,
        org_id,
        stripe_object_id,
        processed_at: Utc::now(),
    };
    store
        .persist_locked(
            "billing_event",
            org_id.unwrap_or(LOCAL_ORG_ID),
            &event_id,
            &record,
        )
        .await?;
    store.data.lock().await.insert_billing_event(record);
    Ok(json!({ "processed": true, "applied": applied }))
}

async fn apply_checkout_session(
    store: &Store,
    session_id: &str,
    customer_id: Option<String>,
    subscription_id: Option<String>,
    payment_status: Option<String>,
    status: Option<String>,
    metadata: Value,
) -> AppResult<BillingAccountProjection> {
    let intent_id = metadata
        .get("intent_id")
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok());
    let mut intent = {
        let data = store.data.lock().await;
        let by_id = intent_id.and_then(|id| data.billing_checkout_intents.get(&id).cloned());
        by_id
            .or_else(|| {
                data.billing_checkout_intents
                    .values()
                    .find(|intent| intent.stripe_checkout_session_id.as_deref() == Some(session_id))
                    .cloned()
            })
            .ok_or_else(|| AppError::not_found("billing checkout intent not found"))?
    };
    let paid = payment_status.as_deref() == Some("paid") || status.as_deref() == Some("complete");
    if !paid {
        intent.status = "pending_payment".to_string();
        store
            .persist_locked(
                "billing_checkout_intent",
                intent.org_id,
                &intent.id.to_string(),
                &intent,
            )
            .await?;
        store
            .data
            .lock()
            .await
            .insert_billing_checkout_intent(intent);
        return Err(AppError::with_code(
            StatusCode::PAYMENT_REQUIRED,
            "payment_required",
            "Checkout Session is not paid yet",
        ));
    }
    intent.status = "fulfilled".to_string();
    intent.stripe_customer_id = customer_id.clone().or(intent.stripe_customer_id);
    intent.stripe_subscription_id = subscription_id.clone().or(intent.stripe_subscription_id);
    store
        .persist_locked(
            "billing_checkout_intent",
            intent.org_id,
            &intent.id.to_string(),
            &intent,
        )
        .await?;
    store
        .data
        .lock()
        .await
        .insert_billing_checkout_intent(intent.clone());
    activate_paid_plan(
        store,
        PaidPlanActivation {
            org_id: intent.org_id,
            user_id: intent.user_id,
            target_plan_tier: intent.target_plan_tier,
            customer_id,
            subscription_id,
            pending_seat_emails: intent.pending_seat_emails,
            intent_id: Some(intent.id),
        },
    )
    .await
}

struct PaidPlanActivation {
    org_id: Uuid,
    user_id: Uuid,
    target_plan_tier: String,
    customer_id: Option<String>,
    subscription_id: Option<String>,
    pending_seat_emails: Vec<String>,
    intent_id: Option<Uuid>,
}

async fn activate_paid_plan(
    store: &Store,
    activation: PaidPlanActivation,
) -> AppResult<BillingAccountProjection> {
    let plan = plan_tier(&activation.target_plan_tier);
    let org_id = activation.org_id;
    let org = {
        let mut data = store.data.lock().await;
        let mut org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        org.plan_tier = plan.id.to_string();
        org.seat_limit = plan.included_seats;
        store
            .persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await?;
        data.insert_org(org.clone());
        org
    };
    let account = BillingAccountProjection {
        schema_version: 1,
        org_id,
        access_state: BILLING_PAID_ACTIVE.to_string(),
        plan_tier: plan.id.to_string(),
        effective_plan_tier: plan.id.to_string(),
        requested_plan_tier: None,
        paid_extra_seats: 0,
        stripe_customer_id: activation.customer_id,
        stripe_subscription_id: activation.subscription_id.clone(),
        subscription_status: Some("active".to_string()),
        current_period_start: None,
        current_period_end: None,
        cancel_at_period_end: false,
        grace_until: None,
        pending_intent_id: activation.intent_id,
        message: None,
        updated_at: Utc::now(),
    };
    persist_billing_account(store, account.clone()).await?;
    if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
        store.ensure_tenant_route(&org).await?;
    }
    for email in activation.pending_seat_emails {
        let _ = reserve_seat(
            store,
            Some(activation.user_id),
            org_id,
            ReserveSeatRequest {
                email: Some(email),
                role: Some("member".to_string()),
            },
        )
        .await;
    }
    if let Some(stripe_subscription_id) = activation.subscription_id {
        let subscription = BillingSubscriptionRecord {
            schema_version: 1,
            org_id,
            stripe_subscription_id,
            stripe_customer_id: account.stripe_customer_id.clone(),
            status: "active".to_string(),
            plan_tier: plan.id.to_string(),
            paid_extra_seats: 0,
            current_period_start: None,
            current_period_end: None,
            cancel_at_period_end: false,
            metadata: json!({}),
            updated_at: Utc::now(),
        };
        store
            .persist_locked(
                "billing_subscription",
                org_id,
                &subscription.stripe_subscription_id,
                &subscription,
            )
            .await?;
        store
            .data
            .lock()
            .await
            .insert_billing_subscription(subscription);
    }
    Ok(account)
}

async fn apply_subscription_object(
    store: &Store,
    org_id: Uuid,
    object: &Value,
) -> AppResult<BillingAccountProjection> {
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let access_state = match status.as_str() {
        "active" | "trialing" => BILLING_PAID_ACTIVE,
        "past_due" => BILLING_PAST_DUE_GRACE,
        "canceled" | "unpaid" | "incomplete_expired" => BILLING_READ_ONLY_PAYMENT_REQUIRED,
        _ => BILLING_CHECKOUT_PENDING,
    };
    let current_period_start = object
        .get("current_period_start")
        .and_then(Value::as_i64)
        .and_then(datetime_from_unix);
    let current_period_end = object
        .get("current_period_end")
        .and_then(Value::as_i64)
        .and_then(datetime_from_unix);
    let customer_id = stripe_id_field(object, "customer");
    let subscription_id = object.get("id").and_then(Value::as_str).map(str::to_string);
    let mut account = {
        let data = store.data.lock().await;
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        data.billing_accounts
            .get(&org_id)
            .cloned()
            .unwrap_or_else(|| default_billing_account(&org))
    };
    let target_plan = object
        .pointer("/metadata/target_plan_tier")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if account.plan_tier == "free" {
                "pro".to_string()
            } else {
                account.plan_tier.clone()
            }
        });
    let target_plan = validate_plan_tier(Some(&target_plan)).unwrap_or_else(|_| "pro".to_string());
    let paid_extra_seats = object
        .pointer("/metadata/paid_extra_seats")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<i32>().ok())
        .or_else(|| {
            object
                .pointer("/metadata/paid_extra_seats")
                .and_then(Value::as_i64)
                .map(|value| value as i32)
        })
        .unwrap_or(account.paid_extra_seats)
        .max(0);
    account.access_state = access_state.to_string();
    account.plan_tier = target_plan.to_string();
    account.effective_plan_tier = if access_state == BILLING_PAID_ACTIVE {
        target_plan.to_string()
    } else {
        account.effective_plan_tier
    };
    if access_state == BILLING_PAID_ACTIVE {
        account.requested_plan_tier = None;
        account.message = None;
    }
    account.paid_extra_seats = paid_extra_seats;
    account.stripe_customer_id = customer_id.or(account.stripe_customer_id);
    account.stripe_subscription_id = subscription_id.clone().or(account.stripe_subscription_id);
    account.subscription_status = Some(status.clone());
    account.current_period_start = current_period_start;
    account.current_period_end = current_period_end;
    account.cancel_at_period_end = object
        .get("cancel_at_period_end")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    account.updated_at = Utc::now();
    if access_state == BILLING_PAID_ACTIVE {
        let plan = plan_tier(&target_plan);
        let org = {
            let mut data = store.data.lock().await;
            let mut org = data
                .organizations
                .get(&org_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("organization not found"))?;
            org.plan_tier = plan.id.to_string();
            org.seat_limit = plan.included_seats + paid_extra_seats;
            store
                .persist_locked("organization", org.id, &org.id.to_string(), &org)
                .await?;
            data.insert_org(org.clone());
            org
        };
        if org.storage_choice != STORAGE_CHOICE_CUSTOMER_CLICKHOUSE {
            store.ensure_tenant_route(&org).await?;
        }
    }
    persist_billing_account(store, account.clone()).await?;
    if let Some(stripe_subscription_id) = subscription_id {
        let record = BillingSubscriptionRecord {
            schema_version: 1,
            org_id,
            stripe_subscription_id,
            stripe_customer_id: account.stripe_customer_id.clone(),
            status,
            plan_tier: target_plan.to_string(),
            paid_extra_seats,
            current_period_start,
            current_period_end,
            cancel_at_period_end: account.cancel_at_period_end,
            metadata: object.get("metadata").cloned().unwrap_or(Value::Null),
            updated_at: Utc::now(),
        };
        store
            .persist_locked(
                "billing_subscription",
                org_id,
                &record.stripe_subscription_id,
                &record,
            )
            .await?;
        store.data.lock().await.insert_billing_subscription(record);
    }
    Ok(account)
}

async fn mark_payment_failed(store: &Store, org_id: Uuid) -> AppResult<BillingAccountProjection> {
    update_account_state(
        store,
        org_id,
        BILLING_PAST_DUE_GRACE,
        Some("Payment failed. Update the payment method to keep writes enabled."),
    )
    .await
}

async fn mark_invoice_paid(store: &Store, org_id: Uuid) -> AppResult<BillingAccountProjection> {
    update_account_state(store, org_id, BILLING_PAID_ACTIVE, None).await
}

async fn downgrade_org_after_subscription_end(
    store: &Store,
    org_id: Uuid,
) -> AppResult<BillingAccountProjection> {
    let org = {
        let mut data = store.data.lock().await;
        let mut org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        org.plan_tier = "free".to_string();
        org.seat_limit = PLAN_FREE.included_seats;
        store
            .persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await?;
        data.insert_org(org.clone());
        org
    };
    let mut account = default_billing_account(&org);
    account.access_state = BILLING_CANCELED.to_string();
    account.message =
        Some("Subscription ended. Workspace is on Free read/write limits.".to_string());
    persist_billing_account(store, account.clone()).await?;
    Ok(account)
}

async fn update_account_state(
    store: &Store,
    org_id: Uuid,
    state: &str,
    message: Option<&str>,
) -> AppResult<BillingAccountProjection> {
    let mut account = {
        let data = store.data.lock().await;
        let org = data
            .organizations
            .get(&org_id)
            .cloned()
            .ok_or_else(|| AppError::not_found("organization not found"))?;
        data.billing_accounts
            .get(&org_id)
            .cloned()
            .unwrap_or_else(|| default_billing_account(&org))
    };
    account.access_state = state.to_string();
    account.message = message.map(str::to_string);
    account.updated_at = Utc::now();
    persist_billing_account(store, account.clone()).await?;
    Ok(account)
}

async fn persist_billing_account(
    store: &Store,
    account: BillingAccountProjection,
) -> AppResult<()> {
    store
        .persist_locked(
            "billing_account",
            account.org_id,
            &account.org_id.to_string(),
            &account,
        )
        .await?;
    store.data.lock().await.insert_billing_account(account);
    Ok(())
}

async fn persist_billing_checkout_intent(
    store: &Store,
    intent: &BillingCheckoutIntent,
) -> AppResult<()> {
    store
        .persist_locked(
            "billing_checkout_intent",
            intent.org_id,
            &intent.id.to_string(),
            intent,
        )
        .await?;
    store
        .data
        .lock()
        .await
        .insert_billing_checkout_intent(intent.clone());
    Ok(())
}

async fn apply_local_free_plan(
    store: &Store,
    mut org: OrganizationRow,
) -> AppResult<BillingAccountProjection> {
    org.plan_tier = "free".to_string();
    org.seat_limit = PLAN_FREE.included_seats;
    {
        let mut data = store.data.lock().await;
        store
            .persist_locked("organization", org.id, &org.id.to_string(), &org)
            .await?;
        data.insert_org(org.clone());
    }
    let account = default_billing_account(&org);
    persist_billing_account(store, account.clone()).await?;
    Ok(account)
}

async fn latest_usage_report_for_period(
    store: &Store,
    org_id: Uuid,
    period_start: DateTime<Utc>,
) -> Option<BillingUsageReportRecord> {
    let data = store.data.lock().await;
    data.billing_usage_reports
        .values()
        .filter(|report| report.org_id == org_id && report.usage_period_start == period_start)
        .max_by_key(|report| report.created_at)
        .cloned()
}

fn usage_report_event_identifier(
    kind: &str,
    org_id: Uuid,
    period_start: DateTime<Utc>,
    previous: i64,
    current: i64,
) -> String {
    format!(
        "instantml_{kind}_overage_{org_id}_{}_{}_{}",
        period_start.format("%Y%m"),
        previous,
        current
    )
}

fn usage_overage_value(usage: &BillingOverageUsage) -> Value {
    json!({
        "storage_bytes_for_warnings": usage.storage_bytes_for_warnings,
        "billable_storage_bytes": usage.billable_storage_bytes,
        "reported_gib": usage.reported_gib,
        "billable_api_requests": usage.billable_api_requests
    })
}

fn active_or_invited_seats(data: &StoreData, org_id: Uuid) -> usize {
    reserved_seat_count_in_data(data, org_id, Utc::now())
}

fn default_billing_account(org: &OrganizationRow) -> BillingAccountProjection {
    let plan = validate_plan_tier(Some(&org.plan_tier)).unwrap_or_else(|_| "free".to_string());
    let state = if plan == "free" {
        BILLING_FREE_ACTIVE
    } else {
        BILLING_PAID_ACTIVE
    };
    BillingAccountProjection {
        schema_version: 1,
        org_id: org.id,
        access_state: state.to_string(),
        plan_tier: plan.clone(),
        effective_plan_tier: plan,
        requested_plan_tier: None,
        paid_extra_seats: 0,
        stripe_customer_id: None,
        stripe_subscription_id: None,
        subscription_status: None,
        current_period_start: None,
        current_period_end: None,
        cancel_at_period_end: false,
        grace_until: None,
        pending_intent_id: None,
        message: None,
        updated_at: Utc::now(),
    }
}

fn normalize_checkout_seats(raw: Option<Vec<String>>) -> AppResult<Vec<String>> {
    raw.unwrap_or_default()
        .into_iter()
        .map(|email| validate_email(Some(&email)))
        .collect()
}

fn org_id_from_metadata(object: &Value) -> Option<Uuid> {
    object
        .pointer("/metadata/org_id")
        .or_else(|| object.pointer("/subscription_details/metadata/org_id"))
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

fn stripe_id_field(value: &Value, field: &str) -> Option<String> {
    match value.get(field) {
        Some(Value::String(id)) => Some(id.clone()),
        Some(Value::Object(object)) => object.get("id").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

fn datetime_from_unix(seconds: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp(seconds, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org_fixture(name: &str, slug: &str) -> OrganizationRow {
        OrganizationRow {
            id: Uuid::new_v4(),
            slug: slug.to_string(),
            name: name.to_string(),
            plan_tier: "free".to_string(),
            account_type: "business".to_string(),
            seat_limit: PLAN_FREE.included_seats,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        }
    }

    fn store_with_data(data: StoreData) -> Store {
        Store {
            metric_store: crate::metric_store::connect_url(
                "http://default:@127.0.0.1:8123/instantml_orgs_test",
                "TEST_CLICKHOUSE_URL",
            )
            .unwrap(),
            control_store: None,
            hosted_clickhouse: None,
            byoc_clickhouse: crate::config::ByocClickHouseConfig {
                egress_cidrs: Vec::new(),
                egress_set_version: "test".to_string(),
                allow_private_endpoints: true,
                credential_store: crate::config::ByocCredentialStoreConfig::Disabled,
            },
            tenant_metric_stores: Arc::new(Mutex::new(HashMap::new())),
            tenant_loaded: Arc::new(Mutex::new(BTreeSet::new())),
            shared_cell_metric_store: None,
            inflight_idempotency: Arc::new(Mutex::new(BTreeSet::new())),
            data: Arc::new(Mutex::new(data)),
            record_clock_micros: Arc::new(Mutex::new(0)),
            control_projection_loaded: Arc::new(Mutex::new(false)),
            last_control_refresh_error: Arc::new(Mutex::new(None)),
            last_control_refresh: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn default_paid_legacy_org_remains_active() {
        let org = OrganizationRow {
            id: Uuid::new_v4(),
            slug: "acme".to_string(),
            name: "Acme".to_string(),
            plan_tier: "pro".to_string(),
            account_type: "customer".to_string(),
            seat_limit: PLAN_PRO.included_seats,
            created_by_user_id: None,
            created_at: Utc::now(),
            tenant_routing_tier: "dedicated".to_string(),
            storage_choice: STORAGE_CHOICE_HOSTED.to_string(),
            storage_state: STORAGE_STATE_READY.to_string(),
        };
        let account = default_billing_account(&org);
        assert_eq!(account.access_state, BILLING_PAID_ACTIVE);
        assert_eq!(account.effective_plan_tier, "pro");
    }

    #[tokio::test]
    async fn checkout_pending_account_keeps_paid_workspace_blocked_and_recoverable() {
        let user = UserRow {
            id: Uuid::new_v4(),
            primary_email: "ada@example.com".to_string(),
            display_name: Some("Ada".to_string()),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: None,
        };
        let mut org = org_fixture("Ada Lab", "ada-lab");
        org.created_by_user_id = Some(user.id);
        let intent = BillingCheckoutIntent {
            schema_version: 1,
            id: Uuid::new_v4(),
            org_id: org.id,
            user_id: user.id,
            action: "new_org".to_string(),
            target_plan_tier: "pro".to_string(),
            pending_seat_emails: Vec::new(),
            stripe_checkout_session_id: None,
            stripe_customer_id: None,
            stripe_subscription_id: None,
            status: "checkout_failed".to_string(),
            url: None,
            created_at: Utc::now(),
            expires_at: None,
        };
        let account = pending_checkout_account(
            &org,
            &default_billing_account(&org),
            "pro",
            &intent,
            "Stripe Checkout could not be created. Retry checkout from billing.",
        );
        let mut data = StoreData::default();
        data.insert_user(user);
        data.insert_org(org.clone());
        data.insert_billing_checkout_intent(intent.clone());
        data.insert_billing_account(account);
        let store = store_with_data(data);

        let data = store.data.lock().await;
        let stored_account = data
            .billing_accounts
            .get(&org.id)
            .expect("billing account should block paid org writes after checkout failure");
        assert_eq!(stored_account.access_state, BILLING_CHECKOUT_PENDING);
        assert_eq!(stored_account.effective_plan_tier, "free");
        assert_eq!(stored_account.requested_plan_tier.as_deref(), Some("pro"));
        assert!(stored_account
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("could not be created"));
        let intent_id = stored_account
            .pending_intent_id
            .expect("pending account should reference the checkout intent");
        let stored_intent = data
            .billing_checkout_intents
            .get(&intent_id)
            .cloned()
            .expect("failed checkout should keep a recoverable local intent");
        assert_eq!(stored_intent.status, "checkout_failed");
        drop(data);

        let blocked = ensure_billing_write_allowed(&store, org.id, "create runs")
            .await
            .unwrap_err();
        assert_eq!(blocked.status(), StatusCode::PAYMENT_REQUIRED);
    }
}
