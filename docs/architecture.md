# Architecture decision record — Phase 1

- **Stack:** React 18 + Vite + TypeScript + Tailwind; Netlify Functions (one router, `/api/v1/*`); Supabase Postgres + Auth; PostGIS via `0002`.
- **Pure core:** `src/domain`, `src/scoring`, `src/importers` have no I/O and are shared by API, batch jobs and tests.
- **One SQL repository** (`src/server/repo.ts`) behind a minimal `Db` interface: node-postgres in production, PGlite
  (embedded Postgres running the same migrations) in local dev, tests and Playwright.
- **Immutability in the database** via triggers, not just application code.
- **Snapshots, not archives**, for avalanche.ca: the API has no archive, so capture-on-issue is the only way to freeze bulletins.
- **Deferred:** map, timeline brushing, charts library, exports, admin UI, Excel/CAAML adapters, scheduled capture.
See `phase-0-discovery.md` §4 for deviations from the brief and why.
