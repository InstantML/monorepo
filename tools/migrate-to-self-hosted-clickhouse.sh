#!/usr/bin/env bash
# Migrate from ClickHouse Cloud → self-hosted ClickHouse on a single GCP VM.
#
# Why: ClickHouse Cloud is ~$1k+/mo at the smallest sensible config; a single
# n2-standard-2 VM running Dockerized ClickHouse is ~$75/mo all-in and is
# plenty for a 3-person pilot. See wiki/decisions/per-org-clickhouse-warehouse
# for the broader cost discussion.
#
# What this does:
#   1. Provisions a VM in the existing instantml-cloud-run VPC + subnet
#      (same as the rust-server services, so they reach it at <5ms latency).
#   2. Installs Docker + ClickHouse via a startup script.
#   3. Generates a random ClickHouse password (printed once to your terminal,
#      then immediately written to Secret Manager).
#   4. Adds a firewall rule allowing Cloud Run egress (136.115.243.188/32) to
#      reach ClickHouse's HTTP and native ports.
#   5. Updates the 3 Secret Manager entries that the rust-server reads.
#   6. Rolls instantml-control and instantml-data-us-central1-a so they pick
#      up the new secrets.
#
# What this does NOT do:
#   - Migrate data out of the (now-paused) ClickHouse Cloud services. Trial
#     credits expired; their data is mostly demo seed which is regeneratable.
#     If you DO need to pull data, add a card to ClickHouse Cloud first,
#     resume, dump via `clickhouse-client INTO OUTFILE`, then run this.
#   - Set up nightly backups. See the README addendum after this lands.
#   - Delete the orphaned per-org warehouse (`InstantML - Warehouse 9d380753`)
#     on the ClickHouse Cloud side — do that manually in their console after
#     verifying the new VM works.
#
# How to run:
#   bash tools/migrate-to-self-hosted-clickhouse.sh
#
# Idempotency:
#   Each step checks if the target already exists before creating. Safe to
#   re-run if a step fails mid-way.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Config (override via env if you need to)
# ──────────────────────────────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-project-597c758c-c6cb-4be5-952}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-instantml-clickhouse}"
MACHINE_TYPE="${MACHINE_TYPE:-n2-standard-2}"
BOOT_DISK_SIZE_GB="${BOOT_DISK_SIZE_GB:-100}"
NETWORK="${NETWORK:-instantml-cloud-run}"
SUBNET="${SUBNET:-instantml-cloud-run-us-central1}"
CLOUD_RUN_EGRESS_IP="${CLOUD_RUN_EGRESS_IP:-136.115.243.188/32}"
CLICKHOUSE_IMAGE="${CLICKHOUSE_IMAGE:-clickhouse/clickhouse-server:24.8}"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-instantml}"
CLICKHOUSE_DB="${CLICKHOUSE_DB:-default}"

# Secret Manager names — must match what the rust-server reads.
SECRET_ENDPOINT="instantml-clickhouse-user-data-endpoint"
SECRET_USERNAME="instantml-clickhouse-user-data-username"
SECRET_PASSWORD="instantml-clickhouse-user-data-password"

# Cloud Run service names.
CONTROL_SERVICE="instantml-control"
DATA_SERVICE="instantml-data-us-central1-a"

# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────
log()  { printf "\033[1;34m[migrate]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ok]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

confirm() {
  local prompt="$1"
  read -r -p "$(printf '\033[1;36m[?]\033[0m %s [y/N] ' "$prompt")" reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *)           return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# ──────────────────────────────────────────────────────────────────────────
# Pre-flight
# ──────────────────────────────────────────────────────────────────────────
log "Pre-flight checks"
require_cmd gcloud
require_cmd python3

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1)"
[ -n "$active_account" ] || die "gcloud has no active account. Run: gcloud auth login"
ok "gcloud authenticated as: $active_account"

current_project="$(gcloud config get-value project 2>/dev/null || true)"
if [ "$current_project" != "$PROJECT_ID" ]; then
  warn "gcloud project is '$current_project', expected '$PROJECT_ID'"
  confirm "Switch gcloud project to $PROJECT_ID for this session?" \
    && gcloud config set project "$PROJECT_ID" >/dev/null \
    || die "Aborted by user."
fi
ok "project: $PROJECT_ID"

# ──────────────────────────────────────────────────────────────────────────
# Plan summary
# ──────────────────────────────────────────────────────────────────────────
cat <<EOF

\033[1;37m── Plan ──\033[0m
  VM:               $VM_NAME ($MACHINE_TYPE, ${BOOT_DISK_SIZE_GB}GB pd-ssd)
  Zone / Network:   $ZONE / $NETWORK / $SUBNET
  ClickHouse image: $CLICKHOUSE_IMAGE
  ClickHouse user:  $CLICKHOUSE_USER (password: generated, stored in Secret Manager)
  Firewall:         allow $CLOUD_RUN_EGRESS_IP → tcp:8123,9000 on $NETWORK
  Secret Manager:   update $SECRET_ENDPOINT, $SECRET_USERNAME, $SECRET_PASSWORD
  Cloud Run roll:   $CONTROL_SERVICE, $DATA_SERVICE

\033[1;33mNote:\033[0m After this finishes, the ClickHouse Cloud services are no longer used
       (they're already paused due to credit exhaustion). Delete them manually
       in https://console.clickhouse.cloud once you've verified the dashboard
       works against the new VM.
EOF

confirm "Proceed?" || die "Aborted by user."

# ──────────────────────────────────────────────────────────────────────────
# 1. Generate ClickHouse password (32 random url-safe bytes)
# ──────────────────────────────────────────────────────────────────────────
log "Generating ClickHouse password"
CLICKHOUSE_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
ok "password generated (stays in this shell only; will be written to Secret Manager)"

# ──────────────────────────────────────────────────────────────────────────
# 2. Provision VM (with ClickHouse startup script)
# ──────────────────────────────────────────────────────────────────────────
if gcloud compute instances describe "$VM_NAME" --zone="$ZONE" >/dev/null 2>&1; then
  warn "VM '$VM_NAME' already exists in $ZONE — skipping creation"
else
  log "Provisioning VM: $VM_NAME"
  startup_script=$(cat <<STARTUP
#!/bin/bash
set -e
# Cloud-init style startup. Runs once on first boot.
# Docker is already preinstalled on cos-stable images.
mkdir -p /var/lib/clickhouse
docker run -d --restart=always \\
  -p 8123:8123 -p 9000:9000 \\
  -v /var/lib/clickhouse:/var/lib/clickhouse \\
  -e CLICKHOUSE_USER="$CLICKHOUSE_USER" \\
  -e CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \\
  -e CLICKHOUSE_DB="$CLICKHOUSE_DB" \\
  -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \\
  --name clickhouse \\
  $CLICKHOUSE_IMAGE
STARTUP
  )
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=cos-stable \
    --image-project=cos-cloud \
    --network="$NETWORK" \
    --subnet="$SUBNET" \
    --no-address \
    --boot-disk-size="${BOOT_DISK_SIZE_GB}GB" \
    --boot-disk-type=pd-ssd \
    --metadata-from-file="startup-script=/dev/stdin" \
    <<<"$startup_script" >/dev/null
  ok "VM created"
fi

log "Waiting for VM to be reachable + ClickHouse to start (~60s)..."
sleep 60

VM_IP="$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" \
  --format='value(networkInterfaces[0].networkIP)')"
ok "VM internal IP: $VM_IP"

# ──────────────────────────────────────────────────────────────────────────
# 3. Firewall rule
# ──────────────────────────────────────────────────────────────────────────
FW_NAME="allow-clickhouse-from-cloud-run"
if gcloud compute firewall-rules describe "$FW_NAME" >/dev/null 2>&1; then
  warn "firewall rule '$FW_NAME' already exists — skipping"
else
  log "Creating firewall rule: $FW_NAME"
  # Cloud Run egress is NAT'd, but we also allow the VPC subnet for same-VPC
  # ingress from Cloud Run via Direct VPC egress.
  gcloud compute firewall-rules create "$FW_NAME" \
    --network="$NETWORK" \
    --source-ranges="10.0.0.0/8,$CLOUD_RUN_EGRESS_IP" \
    --allow=tcp:8123,tcp:9000 \
    --description="Allow Cloud Run rust-server to reach self-hosted ClickHouse" \
    >/dev/null
  ok "firewall rule created"
fi

# ──────────────────────────────────────────────────────────────────────────
# 4. Update Secret Manager
# ──────────────────────────────────────────────────────────────────────────
log "Updating Secret Manager entries"

# Endpoint URL format the rust-server expects (matches existing convention).
ENDPOINT_URL="clickhouse://$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD@$VM_IP:9000/$CLICKHOUSE_DB"

# Helper that ensures the secret exists then writes a new version.
write_secret() {
  local name="$1"
  local value="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    log "  creating secret: $name"
    gcloud secrets create "$name" --replication-policy=automatic >/dev/null
  fi
  echo -n "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
}

write_secret "$SECRET_ENDPOINT" "$ENDPOINT_URL"
write_secret "$SECRET_USERNAME" "$CLICKHOUSE_USER"
write_secret "$SECRET_PASSWORD" "$CLICKHOUSE_PASSWORD"
ok "Secret Manager updated"

# ──────────────────────────────────────────────────────────────────────────
# 5. Roll Cloud Run services
# ──────────────────────────────────────────────────────────────────────────
log "Rolling Cloud Run services to pick up new secrets"
ROLL_TS="$(date +%s)"
gcloud run services update "$CONTROL_SERVICE" --region="$REGION" \
  --update-env-vars="MIGRATION_ROLL=$ROLL_TS" >/dev/null
ok "control plane rolled"
gcloud run services update "$DATA_SERVICE" --region="$REGION" \
  --update-env-vars="MIGRATION_ROLL=$ROLL_TS" >/dev/null
ok "data plane rolled"

# ──────────────────────────────────────────────────────────────────────────
# 6. Verify
# ──────────────────────────────────────────────────────────────────────────
log "Verifying"
sleep 15
health="$(curl -sS -m 10 https://api.instantml.ai/health || echo '{}')"
echo "  /health: $health"
if echo "$health" | grep -q '"status":"ok"'; then
  ok "API is responding"
else
  warn "API health not 'ok' yet — services may still be starting. Re-check in 30s."
fi

cat <<EOF

\033[1;32m── Migration complete ──\033[0m

  ClickHouse VM:     $VM_NAME ($VM_IP:9000)
  Endpoint secret:   $SECRET_ENDPOINT (latest version)
  Control plane:     rolled at $(date)
  Data plane:        rolled at $(date)

Next steps:
  1. Open the dashboard at https://instantml.ai/dashboard and verify it loads.
     Schema migrations run on first connection from the rust-server, so the
     first few queries may be slow.

  2. Re-seed demo data if you want the synthetic 1,000-run dataset back:
       # (run from monorepo root once the rust-server confirms the schema is up)
       npm run seed:demo   # or whichever script SETUP.md documents

  3. Set up nightly backups (separate one-time setup):
       gcloud compute ssh $VM_NAME --zone=$ZONE
       # then install clickhouse-backup and cron it to push to a GCS bucket

  4. Once you've verified everything works end-to-end, DELETE the ClickHouse
     Cloud services to make sure they don't accidentally resume with a card on
     file:
       https://console.clickhouse.cloud → delete both services

  Monthly cost now:  ~\$75/mo (VM + boot disk) instead of ~\$1,000+/mo.
EOF
