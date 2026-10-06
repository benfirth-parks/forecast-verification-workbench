# Data dictionary

Authoritative definitions are the migrations (`supabase/migrations`). Sensitivity: **P** public, **I** internal,
**S** sensitive (restricted roles). Times are `timestamptz` (UTC); local days are `date` with the domain's IANA zone.

## forecast_issuances (immutable)
| Field | Type | Meaning | Missing means | Sens. |
| --- | --- | --- | --- | --- |
| assessment_type | text | public_bulletin, operational_forecast (Avy FX), morning_hazard, other | — (required) | P |
| issued_at | timestamptz | Issue time stated by the source (`report.dateIssued`; morning form submit time) | — | P |
| valid_from / valid_to | timestamptz | Product validity from the source | — | P |
| time_zone | text | IANA zone used for local days (`report.timezone`) | import error | P |
| sub_area_id / title | text | avalanche.ca area id and title; Avy FX polygon names | whole domain | P |
| source_system / source_record_id / source_version | text | Provenance; version = source version + payload hash prefix | — | P |
| raw_payload / raw_payload_hash | jsonb / text | Exact payload and SHA-256 of its canonical JSON | — | P (bulletin), I (morning) |
| status / supersedes_id | text / uuid | `issued`, or `amended` pointing at the prior captured version | — | P |
| captured_at | timestamptz | When this system first saw this version | — | P |

## hazard_assessments, band_ratings, avalanche_problems
| Field | Meaning | Allowed values / unit | Missing means |
| --- | --- | --- | --- |
| assessment_kind | forecast, nowcast, hindsight | | |
| valid_date | Local day assessed | date in domain zone | |
| forecast_horizon_days | valid_date − local issue date | days | not applicable (hindsight) |
| band_ratings.rating_state | rated or explicit non-rated state | rated, no_rating, early_season, spring, summer, no_forecast, no_elevation, not_entered | row absent = band not provided (never Low) |
| band_ratings.danger_rating | 1 Low … 5 Extreme | integer, only when rated | |
| problem_type | CAA/OGRS problem | dry_loose, wet_loose, storm_slab, wind_slab, persistent_slab, deep_persistent_slab, wet_slab, glide_slab, cornice | |
| elevation_bands / aspects / cells | Where the problem applies | alp/tln/btl; N…NW; "N:alp" cells (Avy FX rose) | unknown, not "everywhere" |
| likelihood_min/max | Ordinal likelihood | unlikely, possible, likely, very_likely, almost_certain | not stated |
| sensitivity / distribution | Avy FX / conceptual-model factors | unreactive…touchy; isolated, specific, widespread | not stated |
| expected_size_min/max | Destructive size | 1–5 in half classes | not stated |
| status / version / supersedes_id | Versioning; final rows are frozen | draft, final, superseded | |
| label | e.g. "Later expert assessment" for hindsight entered > 7 days after validity | | |

## Evidence tables (immutable, unique on source_system + source_record_id + source_version)
- **avalanche_events** — `observed_at` (required), `occurred_from/to` (null = unknown occurrence time),
  `observation_confidence` (high/moderate/low; drives evidence rule), `size_min/max`, `aspect`, `elevation_m` (metres; feet converted with an info message),
  `location_name` and `geometry_geojson` (**S**), `raw_payload` (all source columns, **S**).
- **mitigation_actions** — `action_time`, `method`, `result_class` (source wording; `unknown` when only "control happened" is known), `result_summary`.
- **field_observations** — `observation_type`, `standardized_payload` (mapped `payload.*` fields), `raw_payload`.
- **weather_observations** — station, variable (hn24 cm, hw24 mm, wind_speed_max km/h, air_temp_max °C, freezing_level m, precip_24 mm), `value` (null = missing; non-numeric readings are flagged, never 0).
- **data_coverage** — overall, visibility, patrol, mitigation sampling (high/moderate/low/unknown), remote detection (operational/partial/none), required rationale.

## Verification tables
- **verification_cases** — one per issuance × unit (`<valid_date>|<sub-area>|<product type>`). Holds the evidence class, its rationale and rule id, review status, assigned reviewer (coded user).
- **verification_scores** — metric rows per case × scoring version × input hash (immutable).
- **adjudications** — discrepancy category, severity, contributing factors, reviewer confidence, comments (**S**), versioned like assessments.

## Import and audit
`import_runs` (adapter, checksum, dry-run flag, status, summary; never deleted; `superseded` hides its records),
`import_files`, `import_errors` (severity error/warning/info, row, field), `source_field_mappings`, `scoring_versions`,
`audit_events` (append-only), `application_users` (coded id + role), `application_roles`, `feature_flags`.
