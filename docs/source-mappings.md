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
| `dangerRatings[i].date.value` | valid_date | day-one rule (default: local date of the value) |
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

## Morning meeting form → canonical
Submit = new `morning_hazard` issuance (source_system `workbench-morning`, record id = date). A second submit for the
same date is an amendment; the case keeps the first. Expected weather rows → `weather_expectations` for the local day.

## Observation CSV (`src/importers/csv-observations.ts`, v1.0.0)
Mapping JSON: `target`, `source_system`, `domain_code`, `time_zone`, `elevation_unit`, `columns` {canonical → header},
optional `variables` for wide weather files. Timestamps without an offset are read in `time_zone`; a repeated or
skipped local hour is an error; date-only values are a warning and flagged `time_estimated`. Unmapped columns are kept in `raw_payload`.

## Planned (Phase 2)
Winter meeting `snow_sheet_sync.results_json` → weather_observations; `control_json` → mitigation_actions (result unknown);
`min_cache.reports_json` → field_observations (type `min_report`).
