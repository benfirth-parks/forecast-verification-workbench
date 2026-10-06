# Forecast Verification Workbench

> **Research prototype — retrospective use only.** Not an operational forecast,
> not a danger-rating recommender, and not a personnel-evaluation tool.

Compares what was forecast for Banff, Yoho and Kootenay (the avalanche.ca public
bulletin, the Parks Avy FX forecast, and the winter morning meeting's hazard
assessment) with an independent hindsight assessment built from afternoon
nowcasts, field observations, mitigation results, observed weather and
avalanche activity. It flags *possible* systematic misses in problem type,
sensitivity/likelihood, spatial distribution, expected size and weather, always
with numerators, denominators and the cases behind them.

The authoritative build brief is `forecast-verification-build.md` in the project
files. Phase 0 findings and open questions: [docs/phase-0-discovery.md](docs/phase-0-discovery.md).

## What works now (Phase 1 vertical slice)

- Importers with dry-run validation, row-level messages, checksums and idempotent re-import:
  avalanche.ca product JSON, Parks Avy FX feed JSON, observation CSV and Excel files
  (avalanches, mitigation, field observations, weather stations), for example InfoEx exports.
- The 17:00 bulletin is mapped to the next day's hazard (Ben's confirmed rule).
- Immutable forecast snapshots; edited bulletins become amendments, cases stay on the as-issued version.
- Daily meetings entry: the morning meeting's call (+ expected weather) and the afternoon meeting's call.
- The day's calls side by side on each case (bulletin → morning → afternoon → hindsight), with what changed,
  and season tables of how often each meeting raised, lowered or kept the call.
- Review queue, split-screen case page, independent hindsight first, differences unlocked after.
- Coverage statements and evidence classification (missing reports are never negatives).
- Versioned hindsight and adjudications; scores stored per scoring version.
- Season analytics with screening flags for systematic misses.
- Roles (viewer, analyst, reviewer, administrator) checked in the API and enforced by RLS.

Not yet: map (MapLibre), seasonal timeline ribbon, exports, admin screens, an InfoEx column
template (needs a sample export), CAAML adapter, scheduled bulletin capture (built, switched off pending approval).

## Setup

```bash
npm install
npm run dev          # http://localhost:5173 with an embedded local Postgres (./.local-db)
```

Local development needs no accounts: it uses an embedded Postgres (PGlite)
running the same migrations, and a development sign-in where you pick a role.
Nothing leaves your machine. Development sign-in refuses to run when
`CONTEXT=production`.

## Tests

```bash
npm run lint && npm run check   # ESLint + TypeScript
npm test                         # unit, importer, database/RLS and API integration tests
npm run test:e2e                 # Playwright browser walkthrough
npm run build                    # production build
```

## Deployment (Netlify + Supabase)

1. Create a Supabase project (ca-central-1). Run `supabase/migrations/*.sql` in order
   (enable PostGIS first for `0002`).
2. In Netlify set, server-side only: `DATABASE_URL` (Supabase pooled connection string),
   `DATABASE_CA_CERT` (Supabase database CA), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
   `AWS_LAMBDA_JS_RUNTIME=nodejs22.x`. For the browser sign-in: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Add users in Supabase Auth, then insert each into `application_users` with a coded
   identifier and a role.
4. Deploy previews may set `WORKBENCH_AUTH=dev`; production ignores it.

## Data-handling warnings

- Do not import Parks Canada operational records into any deployment until security,
  privacy and information-management approval covers GitHub, Netlify and Supabase
  for that data (see docs/privacy-security.md).
- Never commit `.env`, real exports, or screenshots containing records.
- No record, narrative or location is ever sent to an external AI service.
- Test fixtures marked SYNTHETIC are invented; the one real fixture is a public bulletin.
