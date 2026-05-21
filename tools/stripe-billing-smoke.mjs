import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ensureLocalClickHouse } from "./local-clickhouse.mjs";

const repo = process.cwd();
const stripeSecret = cleanEnv(process.env.STRIPE_SECRET_KEY || process.env.INSTANTML_STRIPE_SECRET_KEY);
const stripeApiVersion = cleanEnv(process.env.STRIPE_API_VERSION) || "2026-04-22.dahlia";
const webhookSecret = "whsec_instantml_local_smoke";
const storageMeterEventName =
  cleanEnv(process.env.INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME) ||
  "instantml_storage_overage_gib_month";

if (!stripeSecret) {
  console.error(
    "STRIPE_SECRET_KEY is required for the Stripe billing smoke. Use a Stripe sandbox/test key.",
  );
  process.exit(2);
}

if (!stripeSecret.startsWith("sk_test_") && process.env.INSTANTML_STRIPE_SMOKE_ALLOW_LIVE !== "1") {
  console.error(
    "Refusing to run the Stripe billing smoke with a non-test key. Set INSTANTML_STRIPE_SMOKE_ALLOW_LIVE=1 only for an intentional live billing test.",
  );
  process.exit(2);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "instantml-stripe-billing-"));
const clickhouseHttpPort = await freePort();
const clickhouseTcpPort = await freePort();
const clickhouseInterserverPort = await freePort();
const apiPort = await freePort();
const baseUrl = `http://127.0.0.1:${apiPort}`;
let clickhouse = null;
let server = null;
let cleanupSubscriptionId = null;
let cleanupCustomerId = null;
let sessionCookie = "";

try {
  const clickhouseUrl = `http://default:@127.0.0.1:${clickhouseHttpPort}/instantml`;
  clickhouse = await ensureLocalClickHouse({
    repo,
    url: clickhouseUrl,
    dataDir: path.join(tempDir, "clickhouse"),
    logDir: path.join(tempDir, "clickhouse-logs"),
    tcpPort: clickhouseTcpPort,
    interserverHttpPort: clickhouseInterserverPort,
  });

  const serverLog = path.join(tempDir, "server.log");
  const output = fs.openSync(serverLog, "w");
  server = spawn("cargo", ["run", "--manifest-path", "apps/rust-server/Cargo.toml", "--", "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      CLICKHOUSE_URL: clickhouse.url,
      INSTANTML_BIND_ADDR: `127.0.0.1:${apiPort}`,
      INSTANTML_AUTH_MODE: "local",
      INSTANTML_DEV_AUTH_ENABLED: "true",
      INSTANTML_BILLING_ENABLED: "true",
      INSTANTML_ALLOWED_FRONTEND_ORIGINS: baseUrl,
      INSTANTML_FRONTEND_BASE_URL: baseUrl,
      INSTANTML_BILLING_SUCCESS_URL: `${baseUrl}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
      INSTANTML_BILLING_CANCEL_URL: `${baseUrl}/dashboard/settings`,
      INSTANTML_BILLING_PORTAL_RETURN_URL: `${baseUrl}/dashboard/settings`,
      INSTANTML_ARTIFACT_ROOT: path.join(tempDir, "artifacts"),
      INSTANTML_REQUEST_TIMEOUT_SECONDS: "120",
      STRIPE_SECRET_KEY: stripeSecret,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_API_VERSION: stripeApiVersion,
      INSTANTML_STRIPE_STORAGE_METER_EVENT_NAME: storageMeterEventName,
    },
    stdio: ["ignore", output, output],
  });

  await waitForHttp(`${baseUrl}/readyz`, server, serverLog);

  const prices = await ensureStripeCatalog();
  const smokeId = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  const email = `stripe-smoke+${smokeId}@example.com`;
  const orgName = `Stripe Smoke ${smokeId}`;

  const signup = await apiJson("POST", "/api/auth/dev/google", {
    email,
    display_name: "Stripe Smoke",
    mode: "signup",
    account_type: "customer",
    org_name: orgName,
    plan_tier: "pro",
  }, { saveCookie: true });

  assertEqual(signup.billing_checkout?.status, "checkout_created", "paid signup creates Checkout");
  assertPresent(signup.billing_checkout?.session_id, "paid signup returns a Checkout Session id");
  assertPresent(signup.billing_checkout?.url, "paid signup returns a Checkout URL");
  const orgId = signup.organization?.id;
  const userId = signup.user?.id;
  assertPresent(orgId, "signup returns organization id");
  assertPresent(userId, "signup returns user id");
  assertEqual(signup.organization?.plan_tier, "free", "paid signup stores org as free before payment");

  const unpaidSync = await apiJson("POST", "/api/billing/checkout/sync", {
    session_id: signup.billing_checkout.session_id,
  }, { expectStatus: 402 });
  assertEqual(unpaidSync.code, "payment_required", "unpaid Checkout sync remains gated");

  const customer = await createStripeCustomerWithCard(email, orgId, userId);
  cleanupCustomerId = customer.id;
  const subscription = await stripeRequest("POST", "/v1/subscriptions", [
    ["customer", customer.id],
    ["items[0][price]", prices.pro],
    ["items[0][quantity]", "1"],
    ["items[1][price]", prices.storage],
    ["payment_behavior", "error_if_incomplete"],
    ["metadata[org_id]", orgId],
    ["metadata[user_id]", userId],
    ["metadata[target_plan_tier]", "pro"],
    ["metadata[paid_extra_seats]", "0"],
    ["metadata[instantml_smoke]", "true"],
    ["expand[]", "items.data.price"],
  ]);
  cleanupSubscriptionId = subscription.id;
  assertTruthy(["active", "trialing"].includes(subscription.status), "Stripe subscription is active");

  const createdWebhook = await postWebhook(
    "customer.subscription.created",
    subscription,
    `evt_smoke_subscription_created_${smokeId}`,
  );
  assertEqual(createdWebhook.processed, true, "subscription webhook is processed");

  const duplicateWebhook = await postWebhook(
    "customer.subscription.created",
    subscription,
    `evt_smoke_subscription_created_${smokeId}`,
  );
  assertEqual(duplicateWebhook.duplicate, true, "duplicate Stripe event is idempotent");

  let status = await billingStatus();
  assertEqual(status.access_state, "paid_active", "payment activates billing");
  assertEqual(status.plan_tier, "pro", "payment activates Pro");
  assertEqual(status.stripe_subscription_id, subscription.id, "subscription id is projected");
  assertEqual(status.requested_plan_tier, null, "active subscription clears pending requested plan");

  await postWebhook(
    "invoice.payment_failed",
    invoiceObject(subscription.id, orgId),
    `evt_smoke_invoice_failed_${smokeId}`,
  );
  status = await billingStatus();
  assertEqual(status.access_state, "past_due_grace", "failed invoice moves to grace state");

  await postWebhook(
    "invoice.paid",
    invoiceObject(subscription.id, orgId),
    `evt_smoke_invoice_paid_${smokeId}`,
  );
  status = await billingStatus();
  assertEqual(status.access_state, "paid_active", "paid invoice restores active billing");

  const apiKey = await apiJson("POST", `/api/orgs/${orgId}/api-keys`, {
    name: "Stripe smoke SDK key",
    scopes: ["sdk:ingest"],
  });
  assertTruthy(
    typeof apiKey.api_key === "string" && apiKey.api_key.startsWith("instantml_"),
    "paid workspace can create API keys",
  );

  await apiJson("POST", "/api/billing/add-seat", {
    email: `seat-one+${smokeId}@example.com`,
    role: "member",
  });
  await apiJson("POST", "/api/billing/add-seat", {
    email: `seat-two+${smokeId}@example.com`,
    role: "member",
  });
  const paidSeat = await apiJson("POST", "/api/billing/add-seat", {
    email: `seat-three+${smokeId}@example.com`,
    role: "member",
  });
  assertEqual(paidSeat.billing?.paid_extra_seats, 1, "extra seat updates Stripe subscription");

  const premium = await apiJson("POST", "/api/billing/change-plan", { plan_tier: "premium" });
  assertEqual(premium.billing?.access_state, "paid_active", "plan change remains active");
  assertEqual(premium.billing?.plan_tier, "premium", "plan change projects Premium");

  const storageReport = await apiJson("POST", "/api/billing/storage-overage/report", {});
  assertTruthy(
    ["no_overage", "reported"].includes(storageReport.usage_report?.status),
    "storage overage report is recorded",
  );

  const cancel = await apiJson("POST", "/api/billing/cancel", { at_period_end: true });
  assertEqual(cancel.billing?.cancel_at_period_end, true, "cancellation schedules period-end downgrade");
  assertEqual(cancel.billing?.requested_plan_tier, "free", "cancellation requests Free");

  const deletedSubscription = await stripeRequest(
    "GET",
    `/v1/subscriptions/${subscription.id}`,
    [["expand[]", "items.data.price"]],
  );
  await postWebhook(
    "customer.subscription.deleted",
    {
      ...deletedSubscription,
      status: "canceled",
      metadata: {
        ...(deletedSubscription.metadata || {}),
        org_id: orgId,
      },
    },
    `evt_smoke_subscription_deleted_${smokeId}`,
  );
  status = await billingStatus();
  assertEqual(status.access_state, "canceled", "deleted subscription downgrades local access");
  assertEqual(status.plan_tier, "free", "deleted subscription downgrades local plan");

  console.log("Stripe billing smoke passed");
} finally {
  await cleanupStripeResources();
  if (server) {
    server.kill();
    await onceClose(server);
  }
  if (clickhouse) await clickhouse.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function ensureStripeCatalog() {
  const meter =
    cleanEnv(process.env.STRIPE_STORAGE_METER_ID) ||
    cleanEnv(process.env.INSTANTML_STRIPE_STORAGE_METER_ID) ||
    await ensureMeter();
  const pro =
    cleanEnv(process.env.STRIPE_PRO_PRICE_ID) ||
    cleanEnv(process.env.INSTANTML_STRIPE_PRO_PRICE_ID) ||
    await ensurePrice("instantml_pro_monthly", "InstantML Pro", 19900, false);
  const premium =
    cleanEnv(process.env.STRIPE_PREMIUM_PRICE_ID) ||
    cleanEnv(process.env.INSTANTML_STRIPE_PREMIUM_PRICE_ID) ||
    await ensurePrice("instantml_premium_monthly", "InstantML Premium", 69900, false);
  const extraSeat =
    cleanEnv(process.env.STRIPE_EXTRA_SEAT_PRICE_ID) ||
    cleanEnv(process.env.INSTANTML_STRIPE_EXTRA_SEAT_PRICE_ID) ||
    await ensurePrice("instantml_extra_seat_monthly", "InstantML extra writer seat", 9900, false);
  const storage =
    cleanEnv(process.env.STRIPE_STORAGE_OVERAGE_PRICE_ID) ||
    cleanEnv(process.env.INSTANTML_STRIPE_STORAGE_OVERAGE_PRICE_ID) ||
    await ensurePrice(
      "instantml_storage_overage_gib_month",
      "InstantML retained storage overage GiB-month",
      3,
      true,
      meter,
    );
  assertPresent(pro, "Pro price id");
  assertPresent(premium, "Premium price id");
  assertPresent(extraSeat, "extra-seat price id");
  assertPresent(storage, "storage overage price id");
  return { pro, premium, extraSeat, storage, meter };
}

async function ensurePrice(lookupKey, productName, unitAmountCents, metered, meterId = null) {
  const existing = await stripeRequest("GET", "/v1/prices", [
    ["active", "true"],
    ["lookup_keys[]", lookupKey],
    ["limit", "1"],
  ]);
  const existingId = existing.data?.[0]?.id;
  if (existingId) return existingId;

  const fields = [
    ["currency", "usd"],
    ["unit_amount", String(unitAmountCents)],
    ["recurring[interval]", "month"],
    ["product_data[name]", productName],
    ["lookup_key", lookupKey],
  ];
  if (metered) {
    fields.push(["recurring[meter]", meterId]);
    fields.push(["recurring[usage_type]", "metered"]);
  }
  const created = await stripeRequest("POST", "/v1/prices", fields);
  return created.id;
}

async function ensureMeter() {
  const meters = await stripeRequest("GET", "/v1/billing/meters", [["limit", "100"]]);
  const existing = meters.data?.find(
    (meter) => meter.event_name === storageMeterEventName && meter.status === "active",
  );
  if (existing?.id) return existing.id;

  const created = await stripeRequest("POST", "/v1/billing/meters", [
    ["display_name", "InstantML retained storage overage GiB-month"],
    ["event_name", storageMeterEventName],
    ["default_aggregation[formula]", "sum"],
    ["value_settings[event_payload_key]", "value"],
    ["customer_mapping[type]", "by_id"],
    ["customer_mapping[event_payload_key]", "stripe_customer_id"],
  ]);
  return created.id;
}

async function createStripeCustomerWithCard(email, orgId, userId) {
  const customer = await stripeRequest("POST", "/v1/customers", [
    ["email", email],
    ["metadata[org_id]", orgId],
    ["metadata[user_id]", userId],
    ["metadata[instantml_smoke]", "true"],
  ]);
  const paymentMethod = await stripeRequest("POST", "/v1/payment_methods", [
    ["type", "card"],
    ["card[token]", "tok_visa"],
    ["billing_details[email]", email],
  ]);
  await stripeRequest("POST", `/v1/payment_methods/${paymentMethod.id}/attach`, [
    ["customer", customer.id],
  ]);
  await stripeRequest("POST", `/v1/customers/${customer.id}`, [
    ["invoice_settings[default_payment_method]", paymentMethod.id],
  ]);
  return customer;
}

function invoiceObject(subscriptionId, orgId) {
  return {
    id: `in_smoke_${crypto.randomBytes(8).toString("hex")}`,
    object: "invoice",
    subscription: subscriptionId,
    metadata: {
      org_id: orgId,
      instantml_smoke: "true",
    },
  };
}

async function postWebhook(type, object, eventId) {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    api_version: stripeApiVersion,
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const response = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`webhook ${type} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function billingStatus() {
  const body = await apiJson("GET", "/api/billing/status");
  return body.billing;
}

async function apiJson(method, route, body = undefined, options = {}) {
  const headers = {
    accept: "application/json",
    origin: baseUrl,
  };
  if (sessionCookie) headers.cookie = sessionCookie;
  const request = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${route}`, request);
  if (options.saveCookie) {
    const cookie = response.headers.get("set-cookie");
    if (cookie) {
      const match = cookie.match(/instantml_session=[^;]+/);
      if (match) sessionCookie = match[0];
    }
  }
  const responseBody = await parseJsonResponse(response);
  const expectedStatus = options.expectStatus ?? 200;
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${route} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(responseBody)}`,
    );
  }
  return responseBody;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function stripeRequest(method, stripePath, fields = [], options = {}) {
  const url = new URL(`https://api.stripe.com${stripePath}`);
  const params = new URLSearchParams();
  for (const [key, value] of fields) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }
  const init = {
    method,
    headers: {
      authorization: `Bearer ${stripeSecret}`,
      "stripe-version": stripeApiVersion,
    },
  };
  if (method === "GET") {
    url.search = params.toString();
  } else if (method !== "DELETE") {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = params.toString();
  } else if (params.size > 0) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = params.toString();
  }
  const response = await fetch(url, init);
  const body = await parseJsonResponse(response);
  if (!response.ok && !options.allowFailure) {
    const message = body.error?.message || body.text || JSON.stringify(body);
    throw new Error(`Stripe ${method} ${stripePath} failed with ${response.status}: ${message}`);
  }
  return body;
}

async function cleanupStripeResources() {
  if (cleanupSubscriptionId) {
    await stripeRequest(
      "DELETE",
      `/v1/subscriptions/${cleanupSubscriptionId}`,
      [],
      { allowFailure: true },
    ).catch(() => {});
  }
  if (cleanupCustomerId) {
    await stripeRequest(
      "DELETE",
      `/v1/customers/${cleanupCustomerId}`,
      [],
      { allowFailure: true },
    ).catch(() => {});
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTruthy(value, message) {
  if (!value) throw new Error(message);
}

function assertPresent(value, message) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${message} is required`);
  }
}

function cleanEnv(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const local = http.createServer();
    local.listen(0, "127.0.0.1", () => {
      const { port } = local.address();
      local.close(() => resolve(port));
    });
    local.on("error", reject);
  });
}

async function waitForHttp(url, child, logPath) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) {
      throw new Error(`Rust server exited early. Log:\n${fs.readFileSync(logPath, "utf8")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}. Log:\n${fs.readFileSync(logPath, "utf8")}`);
}

function onceClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
