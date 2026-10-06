# Source mappings

## avalanche.ca product → canonical (`src/importers/avcan-bulletin.ts`, v1.0.0)
| Source | Canonical | Rule |
| --- | --- | --- |
| `owner.value` | filter | only `parks-byk` |
| `report.id` | source_record_id | |
| `version` + payload hash | source_version | in-place edits get a new version |
| `report.dateIssued` / `validUntil` / `timezone` | issued_at / valid_to / time_zone | invalid or missing → error |
| `report.title`, `area.id` | sub_area_title, sub_area_id | |
| `report.confidence.rating.value` | confidence | |
| `report.highlights` | rationale (text) | HTML stripped |
| `dangerRatings[i].date.value` | valid_date | day-one rule `evening_next_day` (default): issued at or after 12:00 local → day one is the next day, earlier → the issue day; then + i. A payload date that disagrees is a warning, never a change to the payload |
| `dangerRatings[i].ratings.{alp,tln,btl}.rating.value` | band_ratings | low…extreme → 1…5; norating, earlyseason, spring, summer → explicit states; unknown → error |
| `problems[j].type.value` | problem_type | spelling variants only; unknown → error |
| `problems[j].data.elevations[].value`, `aspects[].value` | elevation_bands, aspects | unknown → warning |
| `problems[j].data.likelihood.value` | likelihood_min/max | single or range ("possible_likely") |
| `problems[j].data.expectedSize.min/max` | expected_size_min/max | half classes 1–5 |
| `problems[j].comment` | comments | HTML stripped |
Problems are attached to the first rated day only (the product does not split them by day).

## Parks Avy FX feed → canonical (`src/importers/avyfx-feed.ts`, v1.0.0)
`issued`, `validUntil` (UTC) · `days[].date` + `danger.alpine/treeline/belowTreeline` → forecast assessments ·
`problems[].day = "nowcast"` → a nowcast assessment for the issue date · `aspectsElevations` "N:tl" → cell "N:tln" ·
`size` (typical size) → both size min and max · `sensitivity`, `distribution` kept as their own ordinal fields (not converted to likelihood).

## Daily meetings form → canonical
Morning tab: submit = new `morning_hazard` issuance (source_system `workbench-morning`, record id = date). A second submit
for the same date is an amendment; the case keeps the first. Expected weather rows → `weather_expectations` for the local day.
Afternoon tab: submit = a `nowcast` assessment labelled "Afternoon meeting" for the date, linked to that day's morning issuance.

## The day's calls (`src/scoring/stages.ts`)
For each valid day the case page and analytics line up: the public bulletin (first captured version, shortest lead time,
normally the 17:00 issue the evening before; the Avy FX feed only when no avalanche.ca capture exists), the morning
meeting (first version), the latest afternoon meeting entry, and the case's own hindsight. Changes between consecutive
calls are descriptive revisions, not errors; "toward hindsight" counts use finalized hindsight only.

## Observation CSV and Excel (`src/importers/csv-observations.ts`, `src/importers/xlsx.ts`, v1.0.0)
Excel files go through the same mapping engine. The reader takes the first sheet unless one is named, finds the header
row under any one-cell title rows, keeps spreadsheet row numbers in messages, reads date cells as wall-clock time in
the mapping's `time_zone`, uses a formula's saved result, flattens rich text, and reports error cells as warnings.
The import checksum is the SHA-256 of the uploaded file, so re-uploading the same file creates no duplicates.

**CAA InfoEx.** Ben's findings and observations live in InfoEx. No InfoEx column template ships yet because the
export's headers have not been seen; map the columns by hand in the Imports page until a sample export is reviewed.
Use `source_system: "caa-infoex"` and the InfoEx record id as `source_record_id`. Import only Parks' own records;
the InfoEx subscriber agreement governs other operations' data.

Mapping JSON: `target`, `source_system`, `domain_code`, `time_zone`, `elevation_unit`, `columns` {canonical → header},
optional `variables` for wide weather files. Timestamps without an offset are read in `time_zone`; a repeated or
skipped local hour is an error; date-only values are a warning and flagged `time_estimated`. Unmapped columns are kept in `raw_payload`.

## Planned (Phase 2)
Winter meeting `snow_sheet_sync.results_json` → weather_observations; `control_json` → mitigation_actions (result unknown);
`min_cache.reports_json` → field_observations (type `min_report`).
