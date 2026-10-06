# Phase 0 — Discovery, contracts and plan

Prepared 2026-10-06. Status: **draft for Ben's review**. Items marked ❓ need an answer before real data is imported; ✅ marks answers Ben has given.

**Confirmed by Ben (2026-10-06):** the hazard is set in two places. The public bulletin is produced at 17:00 the day before and represents the next day's hazard. Every day a morning meeting and an afternoon meeting also set the hazard and findings internally. All findings and observations live in CAA InfoEx.

## 1. Current state

There was no repository for this workbench. Two of Ben's existing apps are directly relevant:

| Repo | What it is | Relevance |
| --- | --- | --- |
| `benfirth-parks/banff-winter-meeting` (private) | The winter morning meeting app: staffing, weather summary, MIN reports, HS Sheet sync, avalanche-control history, road status. Netlify + Supabase (`banff-summer-meeting` project). Daily GitHub Actions sync at 07:20 MT. | It **is** the morning meeting workflow, but it records no hazard assessment today. Its daily sync already produces three evidence feeds (below). |
| `benfirth-parks/parks-avy-fx` (public) | AVID replacement used to author the BYK forecast. Netlify Blobs storage. Each forecast has a **Nowcast** card plus three forecast-day cards, and a public feed (`/.netlify/functions/feed?format=json`). | Second forecast source, and the only structured "nowcast" that exists today. Its vocabulary (sensitivity, distribution, typical size, aspect×elevation rose) differs from avalanche.ca's (likelihood, size range). |

The workbench follows Ben's established pattern (React + Vite + TypeScript, Netlify Functions, Supabase).

## 2. Source inventory and proposed mapping

| Source | Format / access | Maps to | State |
| --- | --- | --- | --- |
| avalanche.ca public bulletin, owner `parks-byk` | JSON, `GET api.avalanche.ca/forecasts/en/products` (public, current products only) | `forecast_issuances` (public_bulletin), `hazard_assessments` (forecast), `band_ratings`, `avalanche_problems` | Adapter built and tested on the live 2026-10-01 product. Problem shape unverified (see 3). |
| Parks Avy FX feed | JSON, public feed of unexpired Live forecasts | issuances (operational_forecast), forecast days, **nowcast** assessment from nowcast problems | Adapter built against the feed code; tested on a synthetic payload. |
| Morning meeting hazard call | Entered on the workbench's Daily meetings page (or imported, see Q2) | issuance (morning_hazard), forecast assessment, `weather_expectations` | Built. ✅ a morning meeting happens every day. |
| Afternoon meeting hazard call | Daily meetings page, afternoon tab | `hazard_assessments` (nowcast, label "Afternoon meeting") | Built. ✅ an afternoon meeting happens every day. The Avy FX nowcast card is kept separately. |
| HN24 / HW24 per station | Winter meeting `snow_sheet_sync.results_json` (from Rockies Weather Data Explorer → HS Sheet) | `weather_observations` | Not yet wired; CSV import works today. |
| Avalanche control days | Winter meeting `snow_sheet_sync.control_json` (A/C ticks per HS Sheet tab) | `mitigation_actions` with `result_class = unknown` | Not yet wired. Records *that* control happened, not results. ❓ Q6. |
| MIN field reports | Winter meeting `min_cache` (avalanche.ca MIN API, public) | `field_observations` | Not yet wired. Public data. |
| Avalanche observations, mitigation results, field obs, weather | ✅ CAA InfoEx | `avalanche_events`, `mitigation_actions`, `field_observations`, `weather_observations` | CSV and Excel (.xlsx) adapters with a field mapping are built. An InfoEx column template needs a sample export (Q6). |
| Coverage (visibility, patrols, remote detection) | Reviewer statement per case | `data_coverage` | Built. ❓ Q8. |

## 3. avalanche.ca findings

- The API serves **current products only**. No archive endpoint is documented ([API docs](https://avalanche.ca/api-docs)); `/forecasts/en/archive/<date>` returned 400/500. So past winters cannot be rebuilt from this API, and the product is updated in place: **to freeze a bulletin as issued, the workbench must capture it when it appears.** `netlify/functions/bulletin-snapshot.mts` does this every 30 minutes once enabled; each changed payload becomes a new version and the first captured version is the one verified. It is built but switched off (feature flag + no schedule) because the brief puts scheduled imports in Phase 4.
- On 2026-10-06 the BYK product (issued 2026-10-01 17:00 MDT, valid to 2026-10-15) had early-season ratings and `problems: []`. The problem field layout (`type`, `data.elevations`, `data.aspects`, `data.likelihood`, `data.expectedSize`) is coded from Avalanche Canada's public client conventions and is **unverified** until the first in-season product (regular forecasting starts November 1). Unknown shapes produce warnings, never silent repairs, and the raw payload is always stored.
- ✅ **Day-one rule.** Ben confirmed that the 17:00 bulletin represents the next day. The adapter's default rule `evening_next_day` maps day one to the day after issue for a bulletin issued at or after 12:00 local, and to the issue day for one issued earlier (a morning update, flagged with a warning). The early-season payload labels its first rating with the issue time and the issue day ("Thursday" for 2026-10-01), so imports of that shape carry a `payload_date_mismatch` warning; the payload is stored unchanged. The other rules (`payload_date`, `issue_date_plus_index`, `next_day_plus_index`) remain available.
- In season the BYK product is likely split into several sub-areas (the early-season title lists all of them). Each sub-area becomes its own case. ❓ Q5.
- avalanche.ca is blocked from this build environment's network, but reachable from Netlify and GitHub Actions (the winter meeting's MIN sync already calls it).

## 4. Architecture as built (and deviations from the brief)

React/Vite/TypeScript UI · one Netlify Function router at `/api/v1/*` · Supabase Postgres with RLS · pure `src/scoring` and `src/importers` packages · Vitest, Playwright, and database tests on an embedded Postgres (PGlite) that runs the real migrations.

Deviations, each deliberate:
1. **Danger ratings per band are a child table (`band_ratings`)** rather than one `hazard_assessments` row per band, so one assessment holds all three bands plus problems that span bands. Non-rated states (early season, no rating…) are explicit, never Low.
2. **Server data access uses node-postgres over Supabase's pooled connection** instead of supabase-js, so multi-step writes are real transactions and the same SQL is tested locally. Supabase Auth still issues sessions.
3. **Geometry is stored as GeoJSON**; `0002_postgis.sql` adds PostGIS columns generated from it (PGlite can't run PostGIS, so spatial SQL is tested only against Supabase).
4. **One API function** instead of one file per route; routes match the brief's contract.
5. **Tables before charts.** Analytics are tables with n/N on every rate; Plotly/ECharts and the MapLibre map come in Phase 3.

## 5. Evidence-classification proposal (rule `evidence-v1-draft`)

- **Observed positive**: at least one avalanche with observation confidence high or moderate whose occurrence window overlaps the case day (or, with no occurrence time, observed within it). Optional minimum size.
- **Supported negative**: no qualifying avalanche **and** a coverage statement with overall coverage ≥ moderate and at least one of visibility, patrol, mitigation sampling or remote detection ≥ moderate.
- **Unknown due to coverage**: everything else, including "no reports and no coverage statement".
- **Conflicting**: reviewer-entered unresolved conflicts. **Not applicable**: reviewer-stated reason.
- Reviewers can override with a written rationale; the override and the automatic result are both recorded.
- Danger and problem metrics count only cases with a final hindsight and evidence observed positive or supported negative. ❓ Q8.

## 6. Open questions for Ben

1. ✅ Hazard is set at a morning and an afternoon meeting every day. ❓ Is it a full danger rating and problem list per band each time?
2. ❓ Are the morning and afternoon hazard calls already entered in InfoEx (as InfoEx hazard assessments)? If so they should be imported from InfoEx rather than typed again here; otherwise they are entered on the Daily meetings page or as a block in the winter meeting app.
3. ✅ The afternoon meeting is captured as the afternoon call (stored as a nowcast). ❓ Who enters it.
4. ✅ The 17:00 bulletin covers the next day (section 3).
5. ❓ Verify per sub-area, or one BYK case per day?
6. ✅ Findings and observations live in CAA InfoEx. ❓ How data leaves InfoEx (report export to Excel/CSV, or API access), and a sample export with names removed, so the column template can be written. ❓ Whether the InfoEx subscriber agreement allows copying Parks' own InfoEx records into this prototype; other operations' records are excluded by default.
7. ❓ Which winter and area for the first full retrospective season? Since avalanche.ca has no archive, a past winter needs Parks' own forecast archive (AVID export?).
8. ❓ Is the draft supported-negative rule above acceptable for research use?
9. ❓ Elevation-band thresholds per area (stored per domain, none hard-coded yet).
10. ❓ Which stations are authoritative for weather verification (default: the five HS Sheet stations).
11. ❓ Staff identifiers: coded only (default) — confirm.
12. ❓ Approval status of GitHub/Netlify/Supabase for real operational records. Until then the workbench runs locally with public and synthetic data only.

## 7. Next phases

- **Phase 1 close-out (needs Ben):** review the pull request into `main` of `benfirth-parks/forecast-verification-workbench`; a Supabase project (new one recommended; the winter meeting project is shared with the summer app).
- **Phase 2:** InfoEx column templates from a sample export (and hazard-assessment import if Q2 says they live there); wire the winter meeting feeds (HN24/HW24, A/C days, MIN) as adapters; CAAML adapter.
- **Phase 3:** timeline ribbon with brushing, MapLibre evidence map, charts, exports with provenance metadata, admin screens.
- **Phase 4 (approval):** enable the bulletin snapshot schedule from November 1, stale-data alerts.
