# Privacy and security

**Prototype boundary.** GitHub, Netlify and Supabase are not approved for Parks Canada operational records until
security, privacy and information-management authorities approve them. Until then: local development with public
bulletins and synthetic fixtures only.

## Data classification
Public: avalanche.ca bulletins, MIN reports. Internal: morning assessments, nowcasts, hindsight, scores. Sensitive:
exact avalanche/incident locations, raw source payloads of agency observations, adjudication comments, user identities.

## Roles
viewer (read cases, evidence and aggregates; no raw payloads) · analyst (+ import history, audit, raw payloads) ·
reviewer (+ hindsight, coverage, evidence, adjudication, morning/nowcast entry) · administrator (+ imports, supersession, users, flags).
Checked in the API (`requireRole`) and again by RLS.

## RLS
Enabled on every table, deny by default. `has_role()` reads the caller's role from `application_users`.
Reads: viewer+ for forecasts/evidence/cases; analyst+ for import diagnostics and audit. Writes: reviewer for hindsight
(own rows), coverage, adjudications, case state; administrator for source data and reference tables.
Triggers make source records, scores and audit events immutable regardless of role. Tested in `tests/db`.

## Secrets
Server-only env vars: `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPABASE_SECRET_KEY`. Browser gets only the Supabase
URL and publishable key for sign-in. TLS to the database is always verified. `.env` is git-ignored.

## Logging and exports
The API logs only error messages, never payloads or comments. Exports (Phase 3) will carry cutoff, source versions,
scoring version, filters, exclusions, exporting user, timestamp and commit, and create an audit event.

## Other controls
CSP and security headers in `netlify.toml`; person-level analytics disabled by feature flag; coded user identifiers;
no data sent to external AI services. Retention, backup/recovery and incident response must be defined before any
production import (Phase 5).
