# Customer-Owned ClickHouse Setup

Date: 2026-05-22

Status: First-slice customer/operator guide

## Scope

Premium BYOC stores InstantML runs, metrics, logs, attributes, rich objects,
artifact metadata, imports, and tenant operational records in the customer's
ClickHouse database. InstantML still stores identity, billing, sessions, API
keys, route metadata, and artifact bytes in its hosted control plane and R2
artifact backend.

Storage usage for BYOC orgs counts only artifact bytes stored by InstantML. It
does not count the customer's ClickHouse warehouse bytes.

## Recommended ClickHouse Cloud Setup

1. Create or choose a read-write ClickHouse service in a region close to the
   InstantML data-plane region.
2. Add every InstantML egress CIDR displayed in onboarding to the ClickHouse
   service IP access list. This is the Rust API/data-plane egress, not the
   user's browser IP.
3. Create one dedicated database for the InstantML org, for example
   `instantml_acme`.
4. Create one dedicated SQL user for InstantML, for example
   `instantml_writer`.
5. Grant schema migration, insert, and read permissions for initial setup.
6. Paste the HTTPS ClickHouse endpoint origin, database, username, and password
   into InstantML onboarding, then validate and save.
7. After InstantML saves the connection, you may revoke DDL privileges from the
   runtime user. Future InstantML schema migrations may require temporarily
   granting them again.

Recommended SQL shape:

```sql
CREATE DATABASE IF NOT EXISTS instantml_acme;

CREATE USER IF NOT EXISTS instantml_writer
IDENTIFIED WITH sha256_password BY '<generated-password>';

GRANT SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER TABLE, DROP TABLE
ON instantml_acme.*
TO instantml_writer;

-- Optional after InstantML validates and saves the connection:
REVOKE CREATE TABLE, ALTER TABLE, DROP TABLE
ON instantml_acme.*
FROM instantml_writer;
```

The endpoint should look like:

```text
https://abc123.us-central1.gcp.clickhouse.cloud:8443
```

Do not include username/password in the URL, and do not include a path, query
string, or fragment.

## Current Limitations

- Empty orgs only. Route switching is blocked after product data exists.
- Public HTTPS ClickHouse endpoints only in hosted mode.
- The database must already exist; InstantML does not create databases in the
  first BYOC slice.
- Initial validation/save applies the InstantML schema and therefore needs DDL.
  Normal route loads do not rerun schema migration once the saved route records
  schema version 1.
- Hosted BYOC stores customer passwords through the configured BYOC Secret
  Manager backend. `local-user-data` credential storage is for local smoke tests
  only.
