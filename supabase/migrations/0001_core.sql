-- Forecast Verification Workbench — core schema (research prototype).
--
-- Principles enforced in the database, not just the app:
--   * Source records (issuances, observations) are append-only.
--   * Finalized assessments and adjudications cannot be edited; a revision is
--     a new row that supersedes the old one.
--   * Rollback of an import marks the run superseded; rows are never deleted.
--   * Row-level security is on for every table and denies by default.
-- Timestamps are timestamptz (UTC); local days carry an explicit IANA zone.
-- Geometry is stored as GeoJSON here; 0002_postgis.sql adds PostGIS columns.

-- ---------- roles and users ----------

create table public.application_roles (
  code text primary key check (code in ('viewer','analyst','reviewer','administrator')),
  rank integer not null unique,
  description text not null
);
insert into public.application_roles (code, rank, description) values
  ('viewer', 1, 'View approved forecasts, evidence and aggregate analytics'),
  ('analyst', 2, 'Filters, approved exports, scoring details'),
  ('reviewer', 3, 'Enter and finalize hindsight assessments and adjudications'),
  ('administrator', 4, 'Users, domains, vocabularies, imports, scoring versions, feature flags');

create table public.application_users (
  id uuid primary key,                       -- = auth.users.id
  code text not null unique,                 -- coded identifier for analytics; never a name
  role text not null references public.application_roles(code),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Role of the calling user, or null. SECURITY DEFINER so policies can read it.
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.application_users where id = auth.uid() and active
$$;
create or replace function public.has_role(minimum text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.rank from public.application_roles r where r.code = public.app_role())
                  >= (select r.rank from public.application_roles r where r.code = minimum), false)
$$;

create table public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null,
  updated_at timestamptz not null default now()
);
insert into public.feature_flags (key, enabled, description) values
  ('bulletin_snapshot_schedule', false, 'Scheduled capture of the avalanche.ca BYK product (Phase 4; needs approval)'),
  ('person_level_analytics', false, 'Per-person analytics. Off by design; do not enable without governance approval');

-- ---------- geography ----------

create table public.forecast_domains (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  geometry_geojson jsonb,
  time_zone text not null,
  valid_from timestamptz not null,
  valid_to timestamptz,
  metadata jsonb not null default '{}'
);

create table public.terrain_bands (
  id uuid primary key default gen_random_uuid(),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  code text not null check (code in ('alp','tln','btl')),
  name text not null,
  minimum_elevation_m integer,
  maximum_elevation_m integer,
  aspects text[],
  valid_from timestamptz not null,
  valid_to timestamptz,
  unique (forecast_domain_id, code, valid_from)
);

-- ---------- imports and provenance ----------

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  adapter text not null,
  adapter_version text not null,
  source_system text not null,
  source_identifier text not null,
  checksum text not null,
  dry_run boolean not null,
  status text not null check (status in ('validated','committed','failed','superseded')),
  summary jsonb not null default '{}',
  mapping jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_by uuid not null,
  superseded_by uuid references public.import_runs(id),
  supersede_reason text
);
create index on public.import_runs (checksum);

create table public.import_files (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references public.import_runs(id),
  file_name text not null,
  byte_size integer,
  checksum text not null
);

create table public.import_errors (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references public.import_runs(id),
  severity text not null check (severity in ('error','warning','info')),
  code text not null,
  message text not null,
  row_number integer,
  field text
);
create index on public.import_errors (import_run_id);

create table public.source_field_mappings (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  target text not null,
  version integer not null,
  mapping jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  unique (source_system, target, version)
);

create table public.scoring_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  config jsonb not null,
  config_hash text not null unique,
  created_at timestamptz not null default now(),
  created_by uuid not null
);

-- ---------- forecasts and assessments ----------

create table public.forecast_issuances (
  id uuid primary key default gen_random_uuid(),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  assessment_type text not null check (assessment_type in ('operational_forecast','morning_hazard','public_bulletin','other')),
  issued_at timestamptz not null,
  valid_from timestamptz not null,
  valid_to timestamptz not null check (valid_to > valid_from),
  time_zone text not null,
  sub_area_id text,
  sub_area_title text,
  source_system text not null,
  source_record_id text not null,
  source_version text,
  raw_payload jsonb not null,
  raw_payload_hash text not null,
  forecaster_team_code text,
  status text not null check (status in ('issued','amended','cancelled')),
  supersedes_id uuid references public.forecast_issuances(id),
  captured_at timestamptz not null,
  import_run_id uuid not null references public.import_runs(id),
  ingested_at timestamptz not null default now(),
  -- Same source record + identical payload = duplicate; a changed payload is an amendment.
  unique (source_system, source_record_id, raw_payload_hash)
);
create index on public.forecast_issuances (forecast_domain_id, issued_at);

create table public.hazard_assessments (
  id uuid primary key default gen_random_uuid(),
  forecast_issuance_id uuid references public.forecast_issuances(id),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  assessment_kind text not null check (assessment_kind in ('forecast','nowcast','hindsight')),
  assessment_time timestamptz not null,
  valid_from timestamptz not null,
  valid_to timestamptz not null check (valid_to > valid_from),
  valid_date date not null,
  forecast_horizon_days integer,
  confidence text check (confidence in ('low','moderate','high')),
  rationale text,
  critical_factors jsonb not null default '{}',
  label text,
  status text not null check (status in ('draft','final','superseded')),
  version integer not null check (version >= 1),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  supersedes_id uuid references public.hazard_assessments(id),
  verification_case_id uuid,  -- hindsight only; FK added below
  check (assessment_kind <> 'hindsight' or forecast_issuance_id is null),
  check (assessment_kind <> 'forecast' or forecast_issuance_id is not null)
);
create index on public.hazard_assessments (forecast_domain_id, valid_date, assessment_kind);

-- One row per band. A missing row or a non-rated state is NOT Low.
create table public.band_ratings (
  hazard_assessment_id uuid not null references public.hazard_assessments(id),
  band text not null check (band in ('alp','tln','btl')),
  danger_rating integer check (danger_rating between 1 and 5),
  rating_state text not null check (rating_state in ('rated','no_rating','early_season','spring','summer','no_forecast','no_elevation','not_entered')),
  check ((rating_state = 'rated') = (danger_rating is not null)),
  primary key (hazard_assessment_id, band)
);

create table public.avalanche_problems (
  id uuid primary key default gen_random_uuid(),
  hazard_assessment_id uuid not null references public.hazard_assessments(id),
  problem_type text not null check (problem_type in ('dry_loose','wet_loose','storm_slab','wind_slab','persistent_slab','deep_persistent_slab','wet_slab','glide_slab','cornice')),
  rank integer,
  elevation_bands text[] not null default '{}',
  aspects text[] not null default '{}',
  cells text[],
  minimum_elevation_m integer,
  maximum_elevation_m integer,
  likelihood_min text check (likelihood_min in ('unlikely','possible','likely','very_likely','almost_certain')),
  likelihood_max text check (likelihood_max in ('unlikely','possible','likely','very_likely','almost_certain')),
  sensitivity text check (sensitivity in ('unreactive','stubborn','reactive','touchy')),
  distribution text check (distribution in ('isolated','specific','widespread')),
  expected_size_min numeric check (expected_size_min between 1 and 5),
  expected_size_max numeric check (expected_size_max between 1 and 5),
  trend text,
  confidence text,
  comments text,
  check (expected_size_min is null or expected_size_max is null or expected_size_min <= expected_size_max)
);

create table public.weather_expectations (
  id uuid primary key default gen_random_uuid(),
  forecast_issuance_id uuid not null references public.forecast_issuances(id),
  location_reference text not null,
  variable text not null,
  unit text not null,
  expected_min numeric,
  expected_max numeric,
  expected_value numeric,
  period_start timestamptz not null,
  period_end timestamptz not null,
  source_model text,
  available_at timestamptz not null
);

-- ---------- evidence (append-only source records) ----------

create table public.weather_stations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  forecast_domain_id uuid references public.forecast_domains(id),
  elevation_m integer,
  authoritative boolean not null default false,
  metadata jsonb not null default '{}'
);

create table public.weather_observations (
  id uuid primary key default gen_random_uuid(),
  station_code text not null,
  observed_at timestamptz not null,
  variable text not null,
  value numeric,
  unit text not null,
  quality_status text not null,
  quality_flags text[] not null default '{}',
  source_system text not null,
  source_record_id text not null,
  source_version text not null,
  import_run_id uuid not null references public.import_runs(id),
  ingested_at timestamptz not null default now(),
  unique (source_system, source_record_id, source_version)
);

create table public.avalanche_events (
  id uuid primary key default gen_random_uuid(),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  occurred_from timestamptz,
  occurred_to timestamptz,
  observed_at timestamptz not null,
  location_name text,
  geometry_geojson jsonb,
  location_confidence text not null,
  trigger_type text,
  avalanche_type text,
  problem_type text,
  size_min numeric,
  size_max numeric,
  failure_layer text,
  aspect text,
  elevation_m integer,
  elevation_band text,
  observation_confidence text not null,
  source_system text not null,
  source_record_id text not null,
  source_version text not null,
  raw_payload jsonb not null,
  import_run_id uuid not null references public.import_runs(id),
  ingested_at timestamptz not null default now(),
  unique (source_system, source_record_id, source_version)
);

create table public.mitigation_actions (
  id uuid primary key default gen_random_uuid(),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  action_time timestamptz not null,
  location_name text,
  target_geometry_geojson jsonb,
  method text not null,
  result_class text not null,
  result_summary jsonb not null default '{}',
  linked_avalanche_event_ids uuid[] not null default '{}',
  observation_confidence text not null,
  source_system text not null,
  source_record_id text not null,
  source_version text not null,
  raw_payload jsonb not null,
  import_run_id uuid not null references public.import_runs(id),
  ingested_at timestamptz not null default now(),
  unique (source_system, source_record_id, source_version)
);

create table public.field_observations (
  id uuid primary key default gen_random_uuid(),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  observation_type text not null,
  observed_at timestamptz not null,
  location_name text,
  geometry_geojson jsonb,
  standardized_payload jsonb not null,
  raw_payload jsonb not null,
  quality_status text not null,
  source_system text not null,
  source_record_id text not null,
  source_version text not null,
  import_run_id uuid not null references public.import_runs(id),
  ingested_at timestamptz not null default now(),
  unique (source_system, source_record_id, source_version)
);

create table public.data_coverage (
  id uuid primary key default gen_random_uuid(),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  period_start timestamptz not null,
  period_end timestamptz not null check (period_end > period_start),
  coverage_type text not null,
  coverage_class text not null check (coverage_class in ('high','moderate','low','unknown')),
  visibility_class text check (visibility_class in ('high','moderate','low','unknown')),
  patrol_coverage_class text check (patrol_coverage_class in ('high','moderate','low','unknown')),
  remote_detection_status text,
  mitigation_sampling_class text check (mitigation_sampling_class in ('high','moderate','low','unknown')),
  spatial_coverage_geojson jsonb,
  rationale text not null check (length(trim(rationale)) > 0),
  source_ids uuid[] not null default '{}',
  created_by uuid not null,
  created_at timestamptz not null default now(),
  supersedes_id uuid references public.data_coverage(id)
);

-- ---------- verification ----------

create table public.verification_cases (
  id uuid primary key default gen_random_uuid(),
  forecast_issuance_id uuid not null references public.forecast_issuances(id),
  forecast_domain_id uuid not null references public.forecast_domains(id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  valid_date date not null,
  verification_unit text not null,
  forecast_assessment_id uuid not null references public.hazard_assessments(id),
  hindsight_assessment_id uuid references public.hazard_assessments(id),
  outcome_evidence_class text check (outcome_evidence_class in ('observed_positive','supported_negative','unknown_due_to_coverage','conflicting_evidence','not_applicable')),
  evidence_rationale text,
  evidence_rule_id text,
  review_status text not null default 'unassigned' check (review_status in ('unassigned','in_review','final','reopened')),
  assigned_reviewer uuid references public.application_users(id),
  scoring_version_id uuid references public.scoring_versions(id),
  created_at timestamptz not null default now(),
  unique (forecast_issuance_id, verification_unit),
  check (outcome_evidence_class is null or evidence_rationale is not null)
);
alter table public.hazard_assessments
  add constraint hazard_assessments_case_fk foreign key (verification_case_id) references public.verification_cases(id);

create table public.verification_scores (
  id uuid primary key default gen_random_uuid(),
  verification_case_id uuid not null references public.verification_cases(id),
  scoring_version_id uuid not null references public.scoring_versions(id),
  metric_family text not null,
  metric_name text not null,
  metric_value numeric,
  metric_payload jsonb not null default '{}',
  calculated_at timestamptz not null default now(),
  input_hash text not null,
  unique (verification_case_id, scoring_version_id, metric_family, metric_name, input_hash)
);

create table public.adjudications (
  id uuid primary key default gen_random_uuid(),
  verification_case_id uuid not null references public.verification_cases(id),
  category text not null check (category in ('weather_forecast','problem_type','spatial_distribution','likelihood_sensitivity','expected_size','timing','local_variability','inadequate_coverage','source_data_error','ambiguous_evidence','other')),
  severity text check (severity in ('minor','moderate','major')),
  contributing_factors text[] not null default '{}',
  reviewer_confidence text not null check (reviewer_confidence in ('low','moderate','high')),
  comments text,
  status text not null check (status in ('draft','final','superseded')),
  version integer not null check (version >= 1),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  supersedes_id uuid references public.adjudications(id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'
);
create index on public.audit_events (entity, entity_id);

-- ---------- immutability ----------

create or replace function public.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% on %.% is not allowed: source and audit records are immutable', tg_op, tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end $$;

do $$
declare t text;
begin
  foreach t in array array['forecast_issuances','band_ratings','avalanche_problems','weather_expectations',
    'weather_observations','avalanche_events','mitigation_actions','field_observations','verification_scores','audit_events',
    'import_errors','import_files','scoring_versions']
  loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.forbid_change()', t || '_immutable', t);
  end loop;
end $$;

-- Children of draft assessments may be replaced while the draft is open.
create or replace function public.guard_assessment_children() returns trigger language plpgsql as $$
declare s text;
begin
  select status into s from public.hazard_assessments where id = coalesce(new.hazard_assessment_id, old.hazard_assessment_id);
  if s <> 'draft' then
    raise exception 'assessment % is %, its ratings and problems are frozen', coalesce(new.hazard_assessment_id, old.hazard_assessment_id), s
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end $$;
drop trigger band_ratings_immutable on public.band_ratings;
drop trigger avalanche_problems_immutable on public.avalanche_problems;
create trigger band_ratings_guard before insert or update or delete on public.band_ratings
  for each row execute function public.guard_assessment_children();
create trigger avalanche_problems_guard before insert or update or delete on public.avalanche_problems
  for each row execute function public.guard_assessment_children();

-- Final records: only final → superseded is allowed, nothing else changes.
create or replace function public.guard_versioned() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' then return old; end if;
    raise exception 'cannot delete a % record', old.status using errcode = 'restrict_violation';
  end if;
  if old.status = 'draft' then return new; end if;
  if old.status = 'final' and new.status = 'superseded'
     and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
    return new;
  end if;
  raise exception '% record % cannot be edited; create a new version', old.status, old.id using errcode = 'restrict_violation';
end $$;
create trigger hazard_assessments_versioned before update or delete on public.hazard_assessments
  for each row execute function public.guard_versioned();
create trigger adjudications_versioned before update or delete on public.adjudications
  for each row execute function public.guard_versioned();

-- Import runs: only status/finish/supersession bookkeeping may change.
create or replace function public.guard_import_run() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'import runs are never deleted' using errcode = 'restrict_violation'; end if;
  if (to_jsonb(new) - array['status','finished_at','superseded_by','supersede_reason','summary'])
     <> (to_jsonb(old) - array['status','finished_at','superseded_by','supersede_reason','summary']) then
    raise exception 'import run % identity fields are immutable', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger import_runs_guard before update or delete on public.import_runs
  for each row execute function public.guard_import_run();

-- ---------- row-level security: deny by default ----------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Read access: any active role for shared reference and evidence tables.
do $$
declare t text;
begin
  foreach t in array array['application_roles','feature_flags','forecast_domains','terrain_bands','forecast_issuances',
    'hazard_assessments','band_ratings','avalanche_problems','weather_expectations','weather_stations','weather_observations',
    'avalanche_events','mitigation_actions','field_observations','data_coverage','verification_cases','verification_scores',
    'adjudications','scoring_versions']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (public.has_role(''viewer''))', t || '_read', t);
  end loop;
end $$;

-- Import diagnostics and audit history: analysts and administrators.
create policy import_runs_read on public.import_runs for select to authenticated using (public.has_role('analyst'));
create policy import_files_read on public.import_files for select to authenticated using (public.has_role('analyst'));
create policy import_errors_read on public.import_errors for select to authenticated using (public.has_role('analyst'));
create policy source_field_mappings_read on public.source_field_mappings for select to authenticated using (public.has_role('analyst'));
create policy audit_events_read on public.audit_events for select to authenticated using (public.has_role('analyst'));

-- Users: everyone sees their own row; administrators manage all.
create policy application_users_self on public.application_users for select to authenticated using (id = auth.uid() or public.has_role('administrator'));
create policy application_users_admin on public.application_users for all to authenticated
  using (public.has_role('administrator')) with check (public.has_role('administrator'));

-- Reviewer writes: hindsight, coverage, adjudications, case status.
create policy hazard_assessments_hindsight_insert on public.hazard_assessments for insert to authenticated
  with check (assessment_kind = 'hindsight' and public.has_role('reviewer') and created_by = auth.uid());
create policy hazard_assessments_hindsight_update on public.hazard_assessments for update to authenticated
  using (assessment_kind = 'hindsight' and public.has_role('reviewer')) with check (assessment_kind = 'hindsight');
create policy band_ratings_reviewer on public.band_ratings for all to authenticated
  using (public.has_role('reviewer')) with check (public.has_role('reviewer'));
create policy avalanche_problems_reviewer on public.avalanche_problems for all to authenticated
  using (public.has_role('reviewer')) with check (public.has_role('reviewer'));
create policy data_coverage_insert on public.data_coverage for insert to authenticated
  with check (public.has_role('reviewer') and created_by = auth.uid());
create policy adjudications_insert on public.adjudications for insert to authenticated
  with check (public.has_role('reviewer') and created_by = auth.uid());
create policy adjudications_update on public.adjudications for update to authenticated
  using (public.has_role('reviewer')) with check (public.has_role('reviewer'));
create policy verification_cases_update on public.verification_cases for update to authenticated
  using (public.has_role('reviewer')) with check (public.has_role('reviewer'));
create policy audit_events_insert on public.audit_events for insert to authenticated
  with check (public.has_role('viewer') and actor = auth.uid());

-- Administrator writes: reference data, imports, scoring versions, flags.
do $$
declare t text;
begin
  foreach t in array array['forecast_domains','terrain_bands','weather_stations','feature_flags','source_field_mappings',
    'scoring_versions','import_runs','import_files','import_errors','forecast_issuances','weather_expectations',
    'weather_observations','avalanche_events','mitigation_actions','field_observations','verification_cases','verification_scores']
  loop
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_role(''administrator''))', t || '_admin_insert', t);
  end loop;
end $$;
create policy forecast_assessments_admin_insert on public.hazard_assessments for insert to authenticated
  with check (assessment_kind in ('forecast','nowcast') and public.has_role('administrator'));
create policy feature_flags_admin_update on public.feature_flags for update to authenticated
  using (public.has_role('administrator')) with check (public.has_role('administrator'));
create policy import_runs_admin_update on public.import_runs for update to authenticated
  using (public.has_role('administrator')) with check (public.has_role('administrator'));
