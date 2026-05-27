# Customer-Owned GCP ClickHouse Setup

Date: 2026-05-25

Status: First-slice customer/operator guide

## Scope

Premium BYOC stores InstantML runs, metrics, logs, attributes, rich objects,
artifact metadata, imports, and tenant operational records in the customer's
self-hosted ClickHouse database on Google Cloud. InstantML still stores
identity, billing, sessions, API keys, route metadata, and artifact bytes in
its hosted control plane and R2 artifact backend.

Storage usage for BYOC orgs counts only artifact bytes stored by InstantML in
Cloudflare R2. It does not count the customer's ClickHouse database bytes.

## Recommended GCP ClickHouse Setup

1. Create or choose a read-write self-hosted ClickHouse deployment on Google
   Cloud in a region close to the InstantML data-plane region. A dedicated
   Compute Engine VM or managed instance group is the simplest first setup; use
   GKE only if your team already operates Kubernetes for stateful services.
2. Expose the ClickHouse HTTP interface over a public HTTPS endpoint, usually
   through a TLS-terminating proxy or load balancer in front of the ClickHouse
   host.
3. Add every InstantML egress CIDR displayed in onboarding to the GCP firewall,
   load-balancer allowlist, or reverse-proxy allowlist. This is the Rust
   API/data-plane egress, not the user's browser IP.
4. Create one dedicated database for the InstantML org, for example
   `instantml_acme`.
5. Create one dedicated SQL user for InstantML, for example
   `instantml_writer`.
6. Grant schema migration, insert, and read permissions for initial setup.
7. Paste the HTTPS ClickHouse endpoint origin, database, username, and password
   into InstantML onboarding, then validate and save.
8. After InstantML saves the connection, you may revoke DDL privileges from the
   runtime user. Future InstantML schema migrations may require temporarily
   granting them again.

Recommended infrastructure settings:

- Region: choose the same Google Cloud region as the InstantML data plane shown
  in onboarding or by your InstantML operator contact. Use the closest available
  region if training jobs are elsewhere, because writes flow SDK -> InstantML
  API -> ClickHouse.
- Compute and disk: start with a dedicated ClickHouse host, an SSD persistent
  data disk, and enough free disk headroom for merges and backups. Keep data on
  a persistent disk separate from the boot disk.
- TLS: use a certificate from a public trusted CA and keep hostname verification
  valid for the endpoint pasted into InstantML. Self-signed certificates are
  local/operator-test only.
- Backups and monitoring: enable disk snapshots or ClickHouse backups, and alert
  on disk usage, failed backups, CPU, memory, and ClickHouse query errors.
- Install reference: ClickHouse's current install guide is
  https://clickhouse.com/docs/install.

Recommended SQL shape:

```sql
CREATE DATABASE IF NOT EXISTS instantml_acme;

CREATE USER IF NOT EXISTS instantml_writer
IDENTIFIED WITH sha256_password BY '<generated-password>';

GRANT SHOW, SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER TABLE
ON instantml_acme.*
TO instantml_writer;

-- Optional after InstantML validates and saves the connection:
REVOKE CREATE TABLE, CREATE VIEW, ALTER TABLE
ON instantml_acme.*
FROM instantml_writer;
```

The endpoint should look like:

```text
https://clickhouse.acme.example.com:8443
```

Do not include username/password in the URL, and do not include a path, query
string, or fragment. Hosted BYOC currently requires a public HTTPS endpoint;
private VPC-only endpoints are local/operator-test only.

Example firewall shape:

```bash
gcloud compute firewall-rules create instantml-clickhouse-https \
  --network=<vpc-name> \
  --target-tags=<clickhouse-instance-tag> \
  --allow=tcp:8443 \
  --source-ranges=<instantml-egress-cidr-1>,<instantml-egress-cidr-2>
```

Use the exact CIDRs from onboarding. Do not substitute the browser IP.

## Current Limitations

- Empty orgs only. Route switching is blocked after product data exists.
- Public HTTPS ClickHouse endpoints only in hosted mode; self-signed
  certificates are local/operator-test only.
- The database must already exist; InstantML does not create databases in the
  first BYOC slice.
- Initial validation/save applies the InstantML schema and therefore needs DDL.
  Normal route loads do not rerun schema migration once the saved route records
  the current schema version. Future schema upgrades may require temporarily
  re-granting DDL and revalidating.
- Hosted BYOC stores customer passwords through the configured BYOC Secret
  Manager backend. `local-user-data` credential storage is for local smoke tests
  only.
