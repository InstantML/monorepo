-- Control-plane schema. System of record for users, orgs, memberships,
-- sessions, API keys, invitations, billing, and tenant routes.
--
-- This replaces the ClickHouse append-only event log (`instantml_user_data`)
-- and its in-memory projection. Uniqueness, atomicity, and read-after-write
-- are now enforced by Postgres rather than reconstructed in Rust.
--
-- Conventions:
--   * uuid PKs match the Rust `Uuid` ids already minted by the app.
--   * timestamptz everywhere; the app works in UTC.
--   * Scalar fields the app filters/joins/uniques on are explicit columns.
--   * Free-form fields (`metadata`, `config`, view `payload`) stay JSONB.
--   * Arrays use native Postgres arrays (text[], bytea[]).

CREATE TABLE users (
    id            uuid PRIMARY KEY,
    primary_email text NOT NULL,
    display_name  text,
    avatar_url    text,
    created_at    timestamptz NOT NULL,
    last_seen_at  timestamptz,
    -- Case-insensitive email uniqueness. The old in-memory map keyed on the
    -- raw string; lower() is stricter and prevents Foo@x / foo@x duplicates.
    CONSTRAINT users_primary_email_unique UNIQUE (primary_email)
);

-- OAuth / external identity → user mapping. (provider, subject) is the natural
-- key; one identity resolves to exactly one user.
CREATE TABLE identities (
    provider         text NOT NULL,
    provider_subject text NOT NULL,
    user_id          uuid NOT NULL REFERENCES users (id),
    PRIMARY KEY (provider, provider_subject)
);

CREATE TABLE organizations (
    id                  uuid PRIMARY KEY,
    slug                text NOT NULL,
    name                text NOT NULL,
    plan_tier           text NOT NULL,
    account_type        text NOT NULL,
    seat_limit          integer NOT NULL,
    created_by_user_id  uuid REFERENCES users (id),
    created_at          timestamptz NOT NULL,
    tenant_routing_tier text NOT NULL DEFAULT 'dedicated',
    storage_choice      text NOT NULL DEFAULT 'hosted',
    storage_state       text NOT NULL DEFAULT 'ready',
    -- The headline fix: two concurrent signups for the same slug can no longer
    -- both succeed.
    CONSTRAINT organizations_slug_unique UNIQUE (slug)
);

CREATE TABLE memberships (
    id         uuid PRIMARY KEY,
    org_id     uuid NOT NULL REFERENCES organizations (id),
    user_id    uuid NOT NULL REFERENCES users (id),
    role       text NOT NULL,
    status     text NOT NULL,
    created_at timestamptz NOT NULL,
    CONSTRAINT memberships_org_user_unique UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_org_idx ON memberships (org_id);

CREATE TABLE org_invitations (
    id                     uuid PRIMARY KEY,
    org_id                 uuid NOT NULL REFERENCES organizations (id),
    email                  text NOT NULL,
    role                   text NOT NULL,
    status                 text NOT NULL,
    token_hash             bytea NOT NULL,
    previous_token_hashes  bytea[] NOT NULL DEFAULT '{}',
    invited_by_user_id     uuid REFERENCES users (id),
    created_at             timestamptz NOT NULL,
    expires_at             timestamptz NOT NULL,
    last_sent_at           timestamptz,
    accepted_at            timestamptz,
    accepted_by_user_id    uuid REFERENCES users (id),
    revoked_at             timestamptz,
    revoked_by_user_id     uuid REFERENCES users (id),
    delivery_status        text NOT NULL,
    email_provider         text,
    provider_message_id    text,
    CONSTRAINT org_invitations_token_hash_unique UNIQUE (token_hash)
);
CREATE INDEX org_invitations_org_idx ON org_invitations (org_id);
CREATE INDEX org_invitations_email_idx ON org_invitations (org_id, email);

CREATE TABLE email_deliveries (
    id                  uuid PRIMARY KEY,
    org_id              uuid NOT NULL,
    invitation_id       uuid NOT NULL,
    recipient_email     text NOT NULL,
    provider            text NOT NULL,
    status              text NOT NULL,
    provider_message_id text,
    error_code          text,
    created_at          timestamptz NOT NULL
);
CREATE INDEX email_deliveries_invitation_idx ON email_deliveries (invitation_id);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users (id),
    org_id       uuid NOT NULL,
    token_hash   bytea NOT NULL,
    metadata     jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL,
    last_seen_at timestamptz,
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE service_accounts (
    id                 uuid PRIMARY KEY,
    org_id             uuid NOT NULL REFERENCES organizations (id),
    name               text NOT NULL,
    created_by_user_id uuid REFERENCES users (id),
    created_at         timestamptz NOT NULL,
    disabled_at        timestamptz
);
CREATE INDEX service_accounts_org_idx ON service_accounts (org_id);

CREATE TABLE api_keys (
    id                 uuid PRIMARY KEY,
    org_id             uuid NOT NULL REFERENCES organizations (id),
    service_account_id uuid NOT NULL REFERENCES service_accounts (id),
    name               text NOT NULL,
    key_prefix         text NOT NULL,
    key_hash           bytea NOT NULL,
    scopes             text[] NOT NULL DEFAULT '{}',
    project_id         uuid,
    created_at         timestamptz NOT NULL,
    expires_at         timestamptz,
    last_used_at       timestamptz,
    revoked_at         timestamptz,
    CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash)
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);
CREATE INDEX api_keys_service_account_idx ON api_keys (service_account_id);

-- Tenant route metadata (which ClickHouse data plane an org uses). The routing
-- mechanics are unchanged; only the storage of the record moves here.
CREATE TABLE tenant_routes (
    org_id                          uuid PRIMARY KEY REFERENCES organizations (id),
    status                          text NOT NULL,
    provisioner                     text NOT NULL,
    plan_tier                       text,
    warehouse_kind                  text,
    requested_min_replica_memory_gb integer,
    requested_max_replica_memory_gb integer,
    requested_num_replicas          integer,
    applied_min_replica_memory_gb   integer,
    applied_max_replica_memory_gb   integer,
    applied_num_replicas            integer,
    endpoint                        text NOT NULL,
    database                        text NOT NULL,
    username                        text NOT NULL,
    password_secret_ref             text,
    password_ciphertext             text,
    schema_version                  integer,
    service_id                      text,
    created_at                      timestamptz NOT NULL,
    updated_at                      timestamptz NOT NULL,
    error                           text
);

-- Per-(user, org) dashboard preferences. user_id NULL = org-wide default.
-- The old projection keyed on (Uuid, Option<Uuid>); we model the org-wide row
-- with a sentinel partial unique index since NULLs are distinct in UNIQUE.
CREATE TABLE dashboard_preferences (
    schema_version   integer NOT NULL,
    org_id           uuid NOT NULL REFERENCES organizations (id),
    user_id          uuid,
    selected_project text,
    updated_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX dashboard_preferences_org_user_idx
    ON dashboard_preferences (org_id, user_id)
    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX dashboard_preferences_org_default_idx
    ON dashboard_preferences (org_id)
    WHERE user_id IS NULL;

CREATE TABLE workspace_views (
    schema_version integer NOT NULL,
    id             uuid PRIMARY KEY,
    org_id         uuid NOT NULL REFERENCES organizations (id),
    owner_user_id  uuid,
    name           text NOT NULL,
    project        text,
    payload        jsonb NOT NULL,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    deleted_at     timestamptz
);
CREATE INDEX workspace_views_org_idx ON workspace_views (org_id);

-- Billing -------------------------------------------------------------------

-- One account projection per org (PK = org_id).
CREATE TABLE billing_accounts (
    schema_version        integer NOT NULL,
    org_id                uuid PRIMARY KEY REFERENCES organizations (id),
    access_state          text NOT NULL,
    plan_tier             text NOT NULL,
    effective_plan_tier   text NOT NULL,
    requested_plan_tier   text,
    paid_extra_seats      integer NOT NULL,
    stripe_customer_id    text,
    stripe_subscription_id text,
    subscription_status   text,
    current_period_start  timestamptz,
    current_period_end    timestamptz,
    cancel_at_period_end  boolean NOT NULL,
    grace_until           timestamptz,
    pending_intent_id     uuid,
    message               text,
    updated_at            timestamptz NOT NULL
);

CREATE TABLE billing_checkout_intents (
    schema_version             integer NOT NULL,
    id                         uuid PRIMARY KEY,
    org_id                     uuid NOT NULL REFERENCES organizations (id),
    user_id                    uuid NOT NULL,
    action                     text NOT NULL,
    target_plan_tier           text NOT NULL,
    pending_seat_emails        text[] NOT NULL DEFAULT '{}',
    stripe_checkout_session_id text,
    stripe_customer_id         text,
    stripe_subscription_id     text,
    status                     text NOT NULL,
    url                        text,
    created_at                 timestamptz NOT NULL,
    expires_at                 timestamptz
);
CREATE INDEX billing_checkout_intents_org_idx ON billing_checkout_intents (org_id);

CREATE TABLE billing_change_intents (
    schema_version         integer NOT NULL,
    id                     uuid PRIMARY KEY,
    org_id                 uuid NOT NULL REFERENCES organizations (id),
    user_id                uuid NOT NULL,
    action                 text NOT NULL,
    target_plan_tier       text,
    target_extra_seats     integer,
    pending_seat_email     text,
    pending_seat_role      text,
    stripe_invoice_id      text,
    stripe_subscription_id text,
    status                 text NOT NULL,
    created_at             timestamptz NOT NULL,
    expires_at             timestamptz
);
CREATE INDEX billing_change_intents_org_idx ON billing_change_intents (org_id);

-- Keyed by Stripe subscription id (natural unique key from Stripe).
CREATE TABLE billing_subscriptions (
    schema_version         integer NOT NULL,
    stripe_subscription_id text PRIMARY KEY,
    org_id                 uuid NOT NULL REFERENCES organizations (id),
    stripe_customer_id     text,
    status                 text NOT NULL,
    plan_tier              text NOT NULL,
    paid_extra_seats       integer NOT NULL,
    current_period_start   timestamptz,
    current_period_end     timestamptz,
    cancel_at_period_end   boolean NOT NULL,
    metadata               jsonb NOT NULL DEFAULT '{}',
    updated_at             timestamptz NOT NULL
);
CREATE INDEX billing_subscriptions_org_idx ON billing_subscriptions (org_id);

-- Stripe webhook idempotency: PK on the event id makes duplicate delivery a
-- no-op via ON CONFLICT, instead of an in-memory dedupe map.
CREATE TABLE billing_events (
    schema_version   integer NOT NULL,
    stripe_event_id  text PRIMARY KEY,
    event_type       text NOT NULL,
    org_id           uuid,
    stripe_object_id text,
    processed_at     timestamptz NOT NULL
);

CREATE TABLE billing_usage_reports (
    schema_version               integer NOT NULL,
    id                           uuid PRIMARY KEY,
    org_id                       uuid NOT NULL REFERENCES organizations (id),
    usage_period_start           timestamptz NOT NULL,
    usage_period_end             timestamptz NOT NULL,
    billable_storage_bytes       bigint NOT NULL,
    reported_gib                 bigint NOT NULL,
    reported_storage_gib_delta   bigint NOT NULL DEFAULT 0,
    billable_api_requests        bigint NOT NULL DEFAULT 0,
    reported_api_requests        bigint NOT NULL DEFAULT 0,
    reported_api_requests_delta  bigint NOT NULL DEFAULT 0,
    stripe_event_id              text,
    stripe_storage_event_id      text,
    stripe_api_request_event_id  text,
    status                       text NOT NULL,
    created_at                   timestamptz NOT NULL
);
CREATE INDEX billing_usage_reports_org_idx ON billing_usage_reports (org_id);

-- Idempotency keys for mutating API requests. Replaces both the in-memory
-- `idempotency` map and the `inflight_idempotency` set: INSERT ... ON CONFLICT
-- handles the in-flight race, and the row holds the cached response.
CREATE TABLE idempotency_keys (
    org_id        uuid NOT NULL,
    key           text NOT NULL,
    request_hash  bytea NOT NULL,
    response_json jsonb NOT NULL,
    expires_at    timestamptz NOT NULL,
    PRIMARY KEY (org_id, key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
