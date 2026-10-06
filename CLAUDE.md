# CLAUDE.md — Forecast Verification Workbench

Research prototype for retrospective avalanche forecast verification (Parks Canada, Banff/Yoho/Kootenay).
The build brief (`forecast-verification-build.md`, project files) is authoritative unless the user says otherwise.

## Before editing
- Read the brief section relevant to the change, `docs/phase-0-discovery.md` and the affected tests.
- Inspect migrations and existing data shapes; never assume similar-looking fields mean the same thing.
- If a field definition, time zone, validity rule, danger convention, terrain band or source identifier
  is unclear, stop and ask.

## Never
- Fabricate operational data or create demo records that could pass for real ones (fixtures are labelled SYNTHETIC).
- Treat an unreported avalanche as a non-event, or a missing rating as Low.
- Modify or delete source records, finalized assessments or audit events (new versions only).
- Use information that became available after issue time when reconstructing a forecast.
- Rank or score individuals; person-level analytics stay off.
- Send records, narratives or locations to an external AI service.
- Put secrets in browser code, Git, logs or screenshots.
- Add machine learning in the first release.

## Layout
- `src/domain` vocabularies, canonical types, time-zone helpers (UTC storage, explicit IANA zones).
- `src/scoring` pure metric functions (no I/O). `src/importers` pure adapters (validate + normalize).
- `src/server` SQL repository, API router, auth. `netlify/functions` thin wrappers.
- `src/app` React UI. `supabase/migrations` schema, triggers, RLS.

## Commands
`npm run lint`, `npm run check`, `npm test`, `npm run test:e2e`, `npm run build` — all must pass.

## Migrations
- Add a new numbered file; never edit an applied migration.
- Every new table: RLS enabled, deny by default, explicit policies, immutability trigger for source data.
- Add DB tests in `tests/db` for constraints and policies.

## Commits
Small phases. Show the full diff and test results before committing; commit to `main` only after approval.

## Terms
Issuance = one captured version of a forecast product. Case = one issuance × valid day × unit.
Hindsight = reviewer's independent after-the-fact assessment. Evidence class = whether the outcome is
observed positive, supported negative, unknown due to coverage, conflicting, or not applicable.
Bands: alp, tln, btl. Signed error = forecast − hindsight.
