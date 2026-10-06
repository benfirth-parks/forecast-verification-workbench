// Persistence. Every write goes through here so idempotency, versioning,
// supersession and audit events are applied in one place. The database
// triggers enforce the same rules a second time.
import type {
  AvalancheProblem, HazardAssessment, VerificationCase,
} from "../domain/types";
import { localDayBounds } from "../domain/time";
import { ELEVATION_BANDS, type RatingCell, type ElevationBand } from "../domain/vocab";
import type { ImportResult } from "../importers/common";
import type { BulletinBundle } from "../importers/avcan-bulletin";
import type { ObservationRecord } from "../importers/csv-observations";
import { canonicalJson } from "../scoring/common";
import type { DayStages, Stage } from "../scoring/stages";
import { sha256 } from "../importers/common";
import type { Db } from "./db";

export interface Actor { id: string; role: string }

export const BYK_DOMAIN = { code: "BYK", name: "Banff, Yoho and Kootenay", time_zone: "America/Edmonton" };

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export async function audit(db: Db, actor: Actor | null, action: string, entity: string, entityId: string | null, details: Record<string, unknown> = {}) {
  await db.query(
    "insert into audit_events (actor, action, entity, entity_id, details) values ($1,$2,$3,$4,$5)",
    [actor?.id ?? null, action, entity, entityId, JSON.stringify(details)],
  );
}

export async function domainId(db: Db, code: string): Promise<string> {
  const r = await db.query<{ id: string }>("select id from forecast_domains where code = $1", [code]);
  if (!r.rows[0]) throw new NotFoundError(`Unknown forecast domain ${code}`);
  return r.rows[0].id;
}

export async function ensureDomain(db: Db, d = BYK_DOMAIN): Promise<string> {
  await db.query(
    "insert into forecast_domains (code, name, time_zone, valid_from) values ($1,$2,$3,'2026-07-01T06:00:00Z') on conflict (code) do nothing",
    [d.code, d.name, d.time_zone],
  );
  return domainId(db, d.code);
}

// ---------- assessments ----------

async function insertChildren(db: Db, a: HazardAssessment) {
  for (const b of ELEVATION_BANDS) {
    const cell = a.ratings[b];
    if (!cell) continue;
    await db.query(
      "insert into band_ratings (hazard_assessment_id, band, danger_rating, rating_state) values ($1,$2,$3,$4)",
      [a.id, b, cell.kind === "rated" ? cell.level : null, cell.kind === "rated" ? "rated" : cell.state],
    );
  }
  for (const p of a.problems) {
    await db.query(
      `insert into avalanche_problems (hazard_assessment_id, problem_type, rank, elevation_bands, aspects, cells,
        minimum_elevation_m, maximum_elevation_m, likelihood_min, likelihood_max, sensitivity, distribution,
        expected_size_min, expected_size_max, trend, confidence, comments)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [a.id, p.problem_type, p.rank, p.elevation_bands, p.aspects, p.cells, p.minimum_elevation_m, p.maximum_elevation_m,
        p.likelihood_min, p.likelihood_max, p.sensitivity, p.distribution, p.expected_size_min, p.expected_size_max,
        p.trend, p.confidence, p.comments],
    );
  }
}

/** Inserts an assessment. Children are written while it is a draft, then it is set to its target status. */
export async function insertAssessment(db: Db, a: HazardAssessment, domain: string, caseId: string | null = null) {
  await db.query(
    `insert into hazard_assessments (id, forecast_issuance_id, forecast_domain_id, assessment_kind, assessment_time,
      valid_from, valid_to, valid_date, forecast_horizon_days, confidence, rationale, label, status, version,
      created_by, created_at, supersedes_id, verification_case_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,$14,$15,$16,$17)`,
    [a.id, a.forecast_issuance_id, domain, a.assessment_kind, a.assessment_time, a.valid_from, a.valid_to, a.valid_date,
      a.forecast_horizon_days, a.confidence, a.rationale, a.label, a.version, a.created_by, a.created_at, a.supersedes_id, caseId],
  );
  await insertChildren(db, a);
  if (a.status !== "draft") await db.query("update hazard_assessments set status = $2 where id = $1", [a.id, a.status]);
}

interface AssessmentRow {
  id: string; forecast_issuance_id: string | null; assessment_kind: HazardAssessment["assessment_kind"];
  assessment_time: Date | string; valid_from: Date | string; valid_to: Date | string; valid_date: Date | string;
  forecast_horizon_days: number | null; confidence: HazardAssessment["confidence"]; rationale: string | null;
  label: string | null; status: HazardAssessment["status"]; version: number; created_by: string;
  created_at: Date | string; supersedes_id: string | null; domain_code: string;
}
const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const day = (v: Date | string) => (typeof v === "string" ? v.slice(0, 10) : new Date(v.getTime() - v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10));

export async function loadAssessments(db: Db, ids: string[]): Promise<HazardAssessment[]> {
  if (!ids.length) return [];
  const rows = (await db.query<AssessmentRow>(
    `select a.*, d.code as domain_code from hazard_assessments a join forecast_domains d on d.id = a.forecast_domain_id
     where a.id = any($1::uuid[])`, [ids])).rows;
  const ratings = (await db.query<{ hazard_assessment_id: string; band: ElevationBand; danger_rating: number | null; rating_state: string }>(
    "select * from band_ratings where hazard_assessment_id = any($1::uuid[])", [ids])).rows;
  const problems = (await db.query<AvalancheProblem & { hazard_assessment_id: string; expected_size_min: unknown; expected_size_max: unknown }>(
    "select * from avalanche_problems where hazard_assessment_id = any($1::uuid[]) order by rank nulls last", [ids])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.filter((id) => byId.has(id)).map((id) => {
    const r = byId.get(id)!;
    const rt: Partial<Record<ElevationBand, RatingCell>> = {};
    for (const x of ratings.filter((x) => x.hazard_assessment_id === id)) {
      rt[x.band] = x.rating_state === "rated"
        ? { kind: "rated", level: x.danger_rating as 1 | 2 | 3 | 4 | 5 }
        : { kind: "not_rated", state: x.rating_state as Exclude<RatingCell, { kind: "rated" }>["state"] };
    }
    return {
      id, forecast_issuance_id: r.forecast_issuance_id, forecast_domain_code: r.domain_code, assessment_kind: r.assessment_kind,
      assessment_time: iso(r.assessment_time)!, valid_from: iso(r.valid_from)!, valid_to: iso(r.valid_to)!, valid_date: day(r.valid_date),
      forecast_horizon_days: r.forecast_horizon_days, ratings: rt,
      problems: problems.filter((p) => p.hazard_assessment_id === id).map((p) => ({
        problem_type: p.problem_type, rank: p.rank, elevation_bands: p.elevation_bands ?? [], aspects: p.aspects ?? [],
        cells: p.cells, minimum_elevation_m: p.minimum_elevation_m, maximum_elevation_m: p.maximum_elevation_m,
        likelihood_min: p.likelihood_min, likelihood_max: p.likelihood_max, sensitivity: p.sensitivity, distribution: p.distribution,
        expected_size_min: p.expected_size_min === null ? null : Number(p.expected_size_min),
        expected_size_max: p.expected_size_max === null ? null : Number(p.expected_size_max),
        trend: p.trend, confidence: p.confidence, comments: p.comments,
      })),
      confidence: r.confidence, rationale: r.rationale, status: r.status, version: r.version, created_by: r.created_by,
      created_at: iso(r.created_at)!, supersedes_id: r.supersedes_id, label: r.label,
    };
  });
}

// ---------- imports ----------

export async function recordImportRun(
  db: Db, result: ImportResult<unknown>, actor: Actor, opts: { dryRun: boolean; mapping?: unknown; fileName?: string; byteSize?: number },
): Promise<string> {
  const failed = result.summary.errors > 0 && result.records.length === 0;
  const r = await db.query<{ id: string }>(
    `insert into import_runs (adapter, adapter_version, source_system, source_identifier, checksum, dry_run, status, summary, mapping, created_by, finished_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) returning id`,
    [result.adapter, result.adapter_version, result.source_system, result.source_identifier, result.checksum, opts.dryRun,
      failed ? "failed" : opts.dryRun ? "validated" : "committed", JSON.stringify(result.summary),
      opts.mapping ? JSON.stringify(opts.mapping) : null, actor.id],
  );
  const id = r.rows[0].id;
  if (opts.fileName) {
    await db.query("insert into import_files (import_run_id, file_name, byte_size, checksum) values ($1,$2,$3,$4)", [id, opts.fileName, opts.byteSize ?? null, result.checksum]);
  }
  for (const m of result.messages) {
    await db.query("insert into import_errors (import_run_id, severity, code, message, row_number, field) values ($1,$2,$3,$4,$5,$6)",
      [id, m.severity, m.code, m.message, m.row ?? null, m.field ?? null]);
  }
  return id;
}

export interface CommitSummary { importRunId: string; inserted: number; duplicates: number; amended: number; casesCreated: number }

export async function commitBulletins(db: Db, result: ImportResult<BulletinBundle>, actor: Actor, runId: string): Promise<CommitSummary> {
  let inserted = 0, duplicates = 0, amended = 0, casesCreated = 0;
  for (const b of result.records) {
    const iss = b.issuance;
    const dom = await domainId(db, iss.forecast_domain_code);
    const dup = await db.query("select 1 from forecast_issuances where source_system=$1 and source_record_id=$2 and raw_payload_hash=$3",
      [iss.source_system, iss.source_record_id, iss.raw_payload_hash]);
    if (dup.rows.length) { duplicates++; continue; }
    const prior = await db.query<{ id: string }>(
      `select i.id from forecast_issuances i join import_runs r on r.id = i.import_run_id
       where i.source_system=$1 and i.source_record_id=$2 and r.status <> 'superseded' order by i.captured_at desc limit 1`,
      [iss.source_system, iss.source_record_id]);
    const supersedes = prior.rows[0]?.id ?? null;
    await db.query(
      `insert into forecast_issuances (id, forecast_domain_id, assessment_type, issued_at, valid_from, valid_to, time_zone,
        sub_area_id, sub_area_title, source_system, source_record_id, source_version, raw_payload, raw_payload_hash,
        forecaster_team_code, status, supersedes_id, captured_at, import_run_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [iss.id, dom, iss.assessment_type, iss.issued_at, iss.valid_from, iss.valid_to, iss.time_zone, b.sub_area.id, b.sub_area.title,
        iss.source_system, iss.source_record_id, iss.source_version, JSON.stringify(iss.raw_payload), iss.raw_payload_hash,
        iss.forecaster_team_code, supersedes ? "amended" : "issued", supersedes, iss.captured_at, runId],
    );
    for (const a of b.assessments) await insertAssessment(db, { ...a, forecast_issuance_id: iss.id, created_by: actor.id }, dom);
    if (supersedes) { amended++; continue; } // cases stay on the as-issued version
    inserted++;
    const first = b.assessments.find((a) => a.assessment_kind === "forecast");
    if (first) {
      await createCase(db, { issuanceId: iss.id, domain: dom, assessment: first, unit: `${first.valid_date}|${b.sub_area.id ?? "all"}|${iss.assessment_type}` });
      casesCreated++;
    }
  }
  return { importRunId: runId, inserted, duplicates, amended, casesCreated };
}

async function createCase(db: Db, o: { issuanceId: string; domain: string; assessment: HazardAssessment; unit: string }) {
  await db.query(
    `insert into verification_cases (forecast_issuance_id, forecast_domain_id, period_start, period_end, valid_date, verification_unit, forecast_assessment_id)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (forecast_issuance_id, verification_unit) do nothing`,
    [o.issuanceId, o.domain, o.assessment.valid_from, o.assessment.valid_to, o.assessment.valid_date, o.unit, o.assessment.id],
  );
}

export async function commitObservations(db: Db, result: ImportResult<ObservationRecord>, runId: string): Promise<CommitSummary> {
  let inserted = 0, duplicates = 0;
  for (const o of result.records) {
    const p = o.record.provenance;
    let r: { rows: unknown[] };
    if (o.kind === "avalanche_event") {
      const e = o.record;
      const geo = e.latitude !== null && e.longitude !== null ? JSON.stringify({ type: "Point", coordinates: [e.longitude, e.latitude] }) : null;
      r = await db.query(
        `insert into avalanche_events (forecast_domain_id, occurred_from, occurred_to, observed_at, location_name, geometry_geojson,
          location_confidence, trigger_type, avalanche_type, problem_type, size_min, size_max, failure_layer, aspect, elevation_m,
          elevation_band, observation_confidence, source_system, source_record_id, source_version, raw_payload, import_run_id)
         values ((select id from forecast_domains where code=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         on conflict (source_system, source_record_id, source_version) do nothing returning id`,
        [e.forecast_domain_code, e.occurred_from, e.occurred_to, e.observed_at, e.location_name, geo, e.location_confidence, e.trigger_type,
          e.avalanche_type, e.problem_type, e.size_min, e.size_max, e.failure_layer, e.aspect, e.elevation_m, e.elevation_band,
          e.observation_confidence, p.source_system, p.source_record_id, p.source_version, JSON.stringify(e.raw_payload), runId]);
    } else if (o.kind === "mitigation_action") {
      const m = o.record;
      r = await db.query(
        `insert into mitigation_actions (forecast_domain_id, action_time, location_name, method, result_class, result_summary,
          observation_confidence, source_system, source_record_id, source_version, raw_payload, import_run_id)
         values ((select id from forecast_domains where code=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (source_system, source_record_id, source_version) do nothing returning id`,
        [m.forecast_domain_code, m.action_time, m.location_name, m.method, m.result_class, JSON.stringify(m.result_summary),
          m.observation_confidence, p.source_system, p.source_record_id, p.source_version, JSON.stringify(m.raw_payload), runId]);
    } else if (o.kind === "field_observation") {
      const f = o.record;
      r = await db.query(
        `insert into field_observations (forecast_domain_id, observation_type, observed_at, location_name, standardized_payload,
          raw_payload, quality_status, source_system, source_record_id, source_version, import_run_id)
         values ((select id from forecast_domains where code=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (source_system, source_record_id, source_version) do nothing returning id`,
        [f.forecast_domain_code, f.observation_type, f.observed_at, f.location_name, JSON.stringify(f.standardized_payload),
          JSON.stringify(f.raw_payload), f.quality_status, p.source_system, p.source_record_id, p.source_version, runId]);
    } else {
      const w = o.record;
      r = await db.query(
        `insert into weather_observations (station_code, observed_at, variable, value, unit, quality_status, quality_flags,
          source_system, source_record_id, source_version, import_run_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (source_system, source_record_id, source_version) do nothing returning id`,
        [w.station_code, w.observed_at, w.variable, w.value, w.unit, w.quality_status, w.quality_flags,
          p.source_system, p.source_record_id, p.source_version, runId]);
    }
    if (r.rows.length) inserted++; else duplicates++;
  }
  return { importRunId: runId, inserted, duplicates, amended: 0, casesCreated: 0 };
}

export async function supersedeImportRun(db: Db, id: string, reason: string, actor: Actor) {
  const r = await db.query("update import_runs set status='superseded', supersede_reason=$2 where id=$1 and status='committed' returning id", [id, reason]);
  if (!r.rows.length) throw new ConflictError("Only a committed import run can be superseded");
  await audit(db, actor, "import.supersede", "import_run", id, { reason });
}

// ---------- morning assessment ----------

export interface MorningInput {
  date: string;
  issued_at: string;
  ratings: Partial<Record<ElevationBand, RatingCell>>;
  problems: AvalancheProblem[];
  confidence: HazardAssessment["confidence"];
  rationale: string | null;
  weather: { variable: string; unit: string; expected_min: number | null; expected_max: number | null; location_reference: string }[];
}

export async function createMorningAssessment(db: Db, input: MorningInput, actor: Actor) {
  const dom = await ensureDomain(db);
  const zone = BYK_DOMAIN.time_zone;
  const bounds = localDayBounds(input.date, zone);
  const payload = { ...input, entered_by: actor.id };
  const hash = sha256(canonicalJson(payload));
  const existing = await db.query<{ id: string }>(
    "select id from forecast_issuances where source_system='workbench-morning' and source_record_id=$1 order by captured_at desc limit 1", [input.date]);
  const run = await db.query<{ id: string }>(
    `insert into import_runs (adapter, adapter_version, source_system, source_identifier, checksum, dry_run, status, created_by, finished_at)
     values ('morning-form','1.0.0','workbench-morning',$1,$2,false,'committed',$3, now()) returning id`, [`morning ${input.date}`, hash, actor.id]);
  const issuanceId = globalThis.crypto.randomUUID();
  await db.query(
    `insert into forecast_issuances (id, forecast_domain_id, assessment_type, issued_at, valid_from, valid_to, time_zone, source_system,
      source_record_id, source_version, raw_payload, raw_payload_hash, status, supersedes_id, captured_at, import_run_id)
     values ($1,$2,'morning_hazard',$3,$4,$5,$6,'workbench-morning',$7,$8,$9,$10,$11,$12, now(), $13)`,
    [issuanceId, dom, input.issued_at, bounds.start, bounds.end, zone, input.date, hash.slice(0, 12), JSON.stringify(payload), hash,
      existing.rows[0] ? "amended" : "issued", existing.rows[0]?.id ?? null, run.rows[0].id]);
  const assessment: HazardAssessment = {
    id: globalThis.crypto.randomUUID(), forecast_issuance_id: issuanceId, forecast_domain_code: BYK_DOMAIN.code,
    assessment_kind: "forecast", assessment_time: input.issued_at, valid_from: bounds.start, valid_to: bounds.end,
    valid_date: input.date, forecast_horizon_days: 0, ratings: input.ratings, problems: input.problems,
    confidence: input.confidence, rationale: input.rationale, status: "final", version: 1, created_by: actor.id,
    created_at: new Date().toISOString(), supersedes_id: null, label: "Morning meeting assessment",
  };
  await insertAssessment(db, assessment, dom);
  for (const w of input.weather) {
    await db.query(
      `insert into weather_expectations (forecast_issuance_id, location_reference, variable, unit, expected_min, expected_max, period_start, period_end, available_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [issuanceId, w.location_reference, w.variable, w.unit, w.expected_min, w.expected_max, bounds.start, bounds.end, input.issued_at]);
  }
  if (!existing.rows[0]) {
    await createCase(db, { issuanceId, domain: dom, assessment, unit: `${input.date}|all|morning_hazard` });
  }
  await audit(db, actor, existing.rows[0] ? "morning.amend" : "morning.create", "forecast_issuance", issuanceId, { date: input.date });
  return { issuanceId, assessmentId: assessment.id, amended: Boolean(existing.rows[0]) };
}

/** Afternoon meeting call for a date (stored as a nowcast): what the team believed by end of day, before hindsight review. */
export async function createNowcast(db: Db, input: Omit<MorningInput, "weather"> , actor: Actor) {
  const dom = await ensureDomain(db);
  const bounds = localDayBounds(input.date, BYK_DOMAIN.time_zone);
  const morning = await db.query<{ id: string }>(
    "select id from forecast_issuances where source_system='workbench-morning' and source_record_id=$1 order by captured_at asc limit 1", [input.date]);
  const a: HazardAssessment = {
    id: globalThis.crypto.randomUUID(), forecast_issuance_id: morning.rows[0]?.id ?? null, forecast_domain_code: BYK_DOMAIN.code,
    assessment_kind: "nowcast", assessment_time: input.issued_at, valid_from: bounds.start, valid_to: bounds.end,
    valid_date: input.date, forecast_horizon_days: 0, ratings: input.ratings, problems: input.problems,
    confidence: input.confidence, rationale: input.rationale, status: "final", version: 1, created_by: actor.id,
    created_at: new Date().toISOString(), supersedes_id: null, label: "Afternoon meeting",
  };
  await insertAssessment(db, a, dom);
  await audit(db, actor, "nowcast.create", "hazard_assessment", a.id, { date: input.date });
  return { assessmentId: a.id };
}

// ---------- cases ----------

interface CaseRow {
  id: string; forecast_issuance_id: string; period_start: Date | string; period_end: Date | string; valid_date: Date | string;
  verification_unit: string; forecast_assessment_id: string; hindsight_assessment_id: string | null;
  outcome_evidence_class: VerificationCase["outcome_evidence_class"]; evidence_rationale: string | null;
  review_status: VerificationCase["review_status"]; assigned_reviewer: string | null; scoring_version_id: string | null;
  created_at: Date | string; domain_code: string;
}
const toCase = (r: CaseRow): VerificationCase => ({
  id: r.id, forecast_issuance_id: r.forecast_issuance_id, forecast_domain_code: r.domain_code,
  period_start: iso(r.period_start)!, period_end: iso(r.period_end)!, valid_date: day(r.valid_date),
  verification_unit: r.verification_unit, forecast_assessment_id: r.forecast_assessment_id,
  hindsight_assessment_id: r.hindsight_assessment_id, outcome_evidence_class: r.outcome_evidence_class,
  evidence_rationale: r.evidence_rationale, review_status: r.review_status, assigned_reviewer: r.assigned_reviewer,
  scoring_version_id: r.scoring_version_id, created_at: iso(r.created_at)!,
});

const ACTIVE_CASES = `from verification_cases c
  join forecast_domains d on d.id = c.forecast_domain_id
  join forecast_issuances i on i.id = c.forecast_issuance_id
  join import_runs r on r.id = i.import_run_id and r.status <> 'superseded'`;

export interface CaseFilter { from?: string; to?: string; status?: string; evidence?: string; type?: string }

export async function listCases(db: Db, f: CaseFilter = {}) {
  const where: string[] = [], params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.from) add("c.valid_date >= ?", f.from);
  if (f.to) add("c.valid_date <= ?", f.to);
  if (f.status) add("c.review_status = ?", f.status);
  if (f.evidence) add("c.outcome_evidence_class = ?", f.evidence);
  if (f.type) add("i.assessment_type = ?", f.type);
  const rows = (await db.query<CaseRow & { assessment_type: string; sub_area_title: string | null; issued_at: Date | string; amendments: number }>(
    `select c.*, d.code as domain_code, i.assessment_type, i.sub_area_title, i.issued_at,
       (select count(*)::int from forecast_issuances x where x.supersedes_id is not null and x.source_record_id = i.source_record_id and x.source_system = i.source_system) as amendments
     ${ACTIVE_CASES} ${where.length ? "where " + where.join(" and ") : ""} order by c.valid_date desc, i.assessment_type`, params)).rows;
  const forecasts = await loadAssessments(db, rows.map((r) => r.forecast_assessment_id));
  const byId = new Map(forecasts.map((a) => [a.id, a]));
  return rows.map((r) => ({
    ...toCase(r), assessment_type: r.assessment_type, sub_area_title: r.sub_area_title, issued_at: iso(r.issued_at),
    amendments: r.amendments, forecast: byId.get(r.forecast_assessment_id) ?? null,
  }));
}

export async function getCase(db: Db, id: string): Promise<VerificationCase> {
  const r = await db.query<CaseRow>(`select c.*, d.code as domain_code ${ACTIVE_CASES} where c.id = $1`, [id]);
  if (!r.rows[0]) throw new NotFoundError("Case not found");
  return toCase(r.rows[0]);
}

export async function caseDetail(db: Db, id: string) {
  const c = await getCase(db, id);
  const issuance = (await db.query<Record<string, unknown>>(
    `select id, assessment_type, issued_at, valid_from, valid_to, time_zone, sub_area_id, sub_area_title, source_system, source_record_id,
       source_version, raw_payload_hash, status, captured_at, import_run_id, raw_payload from forecast_issuances where id = $1`, [c.forecast_issuance_id])).rows[0];
  const amendments = (await db.query<{ id: string; captured_at: string; source_version: string }>(
    `select id, captured_at, source_version from forecast_issuances where source_system=$1 and source_record_id=$2 and id <> $3 order by captured_at`,
    [issuance.source_system, issuance.source_record_id, issuance.id])).rows;
  const [forecast] = await loadAssessments(db, [c.forecast_assessment_id]);
  const hindIds = (await db.query<{ id: string }>(
    "select id from hazard_assessments where verification_case_id = $1 and assessment_kind='hindsight' order by version", [id])).rows.map((r) => r.id);
  const hindsight = await loadAssessments(db, hindIds);
  const nowIds = (await db.query<{ id: string }>(
    `select a.id from hazard_assessments a where a.assessment_kind='nowcast' and a.valid_date = $1 and a.forecast_domain_id = (select forecast_domain_id from verification_cases where id=$2)
     order by a.assessment_time`, [c.valid_date, id])).rows.map((r) => r.id);
  const nowcasts = await loadAssessments(db, nowIds);
  const live = "and import_run_id in (select id from import_runs where status <> 'superseded')";
  const evidenceWindow = [c.period_start, c.period_end];
  const avalanches = (await db.query(
    `select * from avalanche_events where forecast_domain_id = (select forecast_domain_id from verification_cases where id=$3)
      and ((occurred_from is not null and occurred_from < $2 and coalesce(occurred_to, occurred_from) >= $1)
        or (occurred_from is null and observed_at >= $1 and observed_at < $2::timestamptz + interval '24 hours')) ${live} order by observed_at`,
    [...evidenceWindow, id])).rows;
  const mitigation = (await db.query(
    `select * from mitigation_actions where action_time >= $1 and action_time < $2 ${live} order by action_time`, evidenceWindow)).rows;
  const field = (await db.query(
    `select * from field_observations where observed_at >= $1 and observed_at < $2 ${live} order by observed_at`, evidenceWindow)).rows;
  const weatherObs = (await db.query(
    `select * from weather_observations where observed_at >= $1 and observed_at < $2::timestamptz + interval '12 hours' ${live} order by station_code, observed_at`, evidenceWindow)).rows;
  const weatherExp = (await db.query("select * from weather_expectations where forecast_issuance_id = $1", [c.forecast_issuance_id])).rows;
  const coverage = (await db.query(
    "select * from data_coverage where period_start < $2 and period_end > $1 order by created_at", evidenceWindow)).rows;
  const adjudications = (await db.query("select * from adjudications where verification_case_id = $1 order by created_at", [id])).rows;
  const history = (await db.query("select at, actor, action, details from audit_events where entity_id = $1 order by at", [id])).rows;
  return { case: c, issuance, amendments, forecast, hindsight, nowcasts, evidence: { avalanches, mitigation, field, weatherObs, weatherExp, coverage }, adjudications, history };
}

// ---------- the day's stages ----------

export interface StageMeta { issued_at: string | null; assessment_type?: string; horizon_days?: number | null; versions?: number; entries?: number; status?: string }
export interface DayStageInfo { date: string; stages: DayStages; meta: Partial<Record<Stage, StageMeta>>; hindsightFinal: boolean }

/**
 * For each valid day: the public bulletin issued for it (first captured
 * version, shortest lead time, normally the 17:00 issue the evening before),
 * the morning meeting (first version as entered), the latest afternoon
 * meeting entry, and a hindsight review. With `hindsightCaseId` only that
 * case's own hindsight is used, so one case never reveals another reviewer's
 * independent hindsight.
 */
export async function loadDayStages(db: Db, opts: { from?: string; to?: string; domainCode?: string; hindsightCaseId?: string } = {}): Promise<DayStageInfo[]> {
  const domain = await db.query<{ id: string }>("select id from forecast_domains where code = $1", [opts.domainCode ?? BYK_DOMAIN.code]);
  if (!domain.rows[0]) return []; // nothing imported yet
  const params: unknown[] = [domain.rows[0].id];
  let range = "";
  if (opts.from) { params.push(opts.from); range += ` and a.valid_date >= $${params.length}`; }
  if (opts.to) { params.push(opts.to); range += ` and a.valid_date <= $${params.length}`; }
  const live = "join import_runs r on r.id = i.import_run_id and r.status <> 'superseded'";
  type Row = { id: string; d: string; issued_at: Date | string | null; assessment_type?: string; horizon?: number | null; n?: number; status?: string };
  const bulletin = (await db.query<Row>(
    `select distinct on (a.valid_date) a.id, a.valid_date::text as d, i.issued_at, i.assessment_type, a.forecast_horizon_days as horizon
     from hazard_assessments a join forecast_issuances i on i.id = a.forecast_issuance_id ${live}
     where a.forecast_domain_id = $1 and a.assessment_kind = 'forecast' and i.supersedes_id is null
       and i.assessment_type in ('public_bulletin', 'operational_forecast') ${range}
     order by a.valid_date, (i.assessment_type <> 'public_bulletin'), (a.forecast_horizon_days = 0), a.forecast_horizon_days, i.captured_at`, params)).rows;
  const morning = (await db.query<Row>(
    `select distinct on (a.valid_date) a.id, a.valid_date::text as d, i.issued_at,
       (select count(*)::int from forecast_issuances x where x.source_system = i.source_system and x.source_record_id = i.source_record_id) as n
     from hazard_assessments a join forecast_issuances i on i.id = a.forecast_issuance_id ${live}
     where a.forecast_domain_id = $1 and a.assessment_kind = 'forecast' and i.supersedes_id is null and i.assessment_type = 'morning_hazard' ${range}
     order by a.valid_date, i.captured_at`, params)).rows;
  const afternoon = (await db.query<Row>(
    `select distinct on (a.valid_date) a.id, a.valid_date::text as d, a.assessment_time as issued_at, count(*) over (partition by a.valid_date)::int as n
     from hazard_assessments a left join forecast_issuances i on i.id = a.forecast_issuance_id
     where a.forecast_domain_id = $1 and a.assessment_kind = 'nowcast' and a.status = 'final'
       and (i.id is null or (i.assessment_type = 'morning_hazard' and i.import_run_id in (select id from import_runs where status <> 'superseded'))) ${range}
     order by a.valid_date, a.assessment_time desc`, params)).rows;
  const hParams = [...params];
  let caseFilter = "";
  if (opts.hindsightCaseId) { hParams.push(opts.hindsightCaseId); caseFilter = ` and a.verification_case_id = $${hParams.length}`; }
  const hindsight = (await db.query<Row>(
    `select distinct on (a.valid_date) a.id, a.valid_date::text as d, a.assessment_time as issued_at, a.status
     from hazard_assessments a
     where a.forecast_domain_id = $1 and a.assessment_kind = 'hindsight' and a.status <> 'superseded' ${range}${caseFilter}
     order by a.valid_date, (a.status = 'final') desc, a.version desc, a.created_at desc`, hParams)).rows;
  const all = await loadAssessments(db, [...bulletin, ...morning, ...afternoon, ...hindsight].map((r) => r.id));
  const byId = new Map(all.map((a) => [a.id, a]));
  const days = new Map<string, DayStageInfo>();
  const put = (stage: Stage, rows: Row[], meta: (r: Row) => StageMeta) => {
    for (const r of rows) {
      const a = byId.get(r.id);
      if (!a) continue;
      const d = days.get(r.d) ?? { date: r.d, stages: {}, meta: {}, hindsightFinal: false };
      d.stages[stage] = a;
      d.meta[stage] = meta(r);
      days.set(r.d, d);
    }
  };
  put("bulletin", bulletin, (r) => ({ issued_at: iso(r.issued_at), assessment_type: r.assessment_type, horizon_days: r.horizon ?? null }));
  put("morning", morning, (r) => ({ issued_at: iso(r.issued_at), versions: r.n }));
  put("afternoon", afternoon, (r) => ({ issued_at: iso(r.issued_at), entries: r.n }));
  put("hindsight", hindsight, (r) => ({ issued_at: iso(r.issued_at), status: r.status }));
  for (const d of days.values()) d.hindsightFinal = d.stages.hindsight?.status === "final";
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function saveHindsightDraft(db: Db, caseId: string, h: Pick<HazardAssessment, "ratings" | "problems" | "confidence" | "rationale">, actor: Actor) {
  const c = await getCase(db, caseId);
  const versions = await db.query<{ id: string; status: string; version: number }>(
    "select id, status, version from hazard_assessments where verification_case_id=$1 and assessment_kind='hindsight' order by version desc", [caseId]);
  const latest = versions.rows[0];
  const dom = await domainId(db, c.forecast_domain_code);
  const now = new Date().toISOString();
  const lateLabel = Date.now() > Date.parse(c.period_end) + 7 * 864e5 ? "Later expert assessment (entered more than 7 days after validity)" : null;
  const base: HazardAssessment = {
    id: globalThis.crypto.randomUUID(), forecast_issuance_id: null, forecast_domain_code: c.forecast_domain_code,
    assessment_kind: "hindsight", assessment_time: now, valid_from: c.period_start, valid_to: c.period_end, valid_date: c.valid_date,
    forecast_horizon_days: null, ratings: h.ratings, problems: h.problems, confidence: h.confidence, rationale: h.rationale,
    status: "draft", version: 1, created_by: actor.id, created_at: now, supersedes_id: null, label: lateLabel,
  };
  if (latest?.status === "draft") {
    // Replace the open draft's content in place (drafts are mutable).
    await db.query("delete from band_ratings where hazard_assessment_id=$1", [latest.id]);
    await db.query("delete from avalanche_problems where hazard_assessment_id=$1", [latest.id]);
    await db.query("update hazard_assessments set confidence=$2, rationale=$3, assessment_time=$4 where id=$1", [latest.id, h.confidence, h.rationale, now]);
    await insertChildren(db, { ...base, id: latest.id });
    await audit(db, actor, "hindsight.draft_update", "verification_case", caseId, { assessment_id: latest.id });
    return { assessmentId: latest.id, version: latest.version };
  }
  const a = { ...base, version: (latest?.version ?? 0) + 1, supersedes_id: latest?.id ?? null };
  await insertAssessment(db, a, dom, caseId);
  await db.query("update verification_cases set hindsight_assessment_id = coalesce(hindsight_assessment_id, $2), review_status = case when review_status='unassigned' then 'in_review' else review_status end where id=$1", [caseId, a.id]);
  await audit(db, actor, latest ? "hindsight.revise" : "hindsight.create", "verification_case", caseId, { assessment_id: a.id, version: a.version });
  return { assessmentId: a.id, version: a.version };
}

export async function finalizeHindsight(db: Db, caseId: string, actor: Actor) {
  const draft = (await db.query<{ id: string; supersedes_id: string | null; version: number }>(
    "select id, supersedes_id, version from hazard_assessments where verification_case_id=$1 and assessment_kind='hindsight' and status='draft' order by version desc limit 1", [caseId])).rows[0];
  if (!draft) throw new ConflictError("No draft hindsight to finalize");
  if (draft.supersedes_id) await db.query("update hazard_assessments set status='superseded' where id=$1 and status='final'", [draft.supersedes_id]);
  await db.query("update hazard_assessments set status='final' where id=$1", [draft.id]);
  await db.query("update verification_cases set hindsight_assessment_id=$2 where id=$1", [caseId, draft.id]);
  await audit(db, actor, "hindsight.finalize", "verification_case", caseId, { assessment_id: draft.id, version: draft.version });
  return { assessmentId: draft.id, version: draft.version };
}

export async function setEvidence(db: Db, caseId: string, e: { evidence_class: string; rationale: string; rule_id: string }, actor: Actor) {
  await db.query("update verification_cases set outcome_evidence_class=$2, evidence_rationale=$3, evidence_rule_id=$4 where id=$1",
    [caseId, e.evidence_class, e.rationale, e.rule_id]);
  await audit(db, actor, "evidence.classify", "verification_case", caseId, e);
}

export async function addCoverage(db: Db, caseId: string, cov: {
  coverage_class: string; visibility_class: string | null; patrol_coverage_class: string | null; mitigation_sampling_class: string | null;
  remote_detection_status: string | null; rationale: string; coverage_type: string;
}, actor: Actor) {
  const c = await getCase(db, caseId);
  const r = await db.query<{ id: string }>(
    `insert into data_coverage (forecast_domain_id, period_start, period_end, coverage_type, coverage_class, visibility_class, patrol_coverage_class,
      mitigation_sampling_class, remote_detection_status, rationale, created_by)
     values ((select forecast_domain_id from verification_cases where id=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [caseId, c.period_start, c.period_end, cov.coverage_type, cov.coverage_class, cov.visibility_class, cov.patrol_coverage_class,
      cov.mitigation_sampling_class, cov.remote_detection_status, cov.rationale, actor.id]);
  await audit(db, actor, "coverage.add", "verification_case", caseId, { coverage_id: r.rows[0].id, coverage_class: cov.coverage_class });
  return r.rows[0].id;
}

export async function saveAdjudication(db: Db, caseId: string, a: {
  category: string; severity: string | null; contributing_factors: string[]; reviewer_confidence: string; comments: string | null; supersedes_id?: string | null;
}, actor: Actor) {
  await getCase(db, caseId);
  let version = 1;
  if (a.supersedes_id) {
    const prev = (await db.query<{ version: number; status: string }>("select version, status from adjudications where id=$1 and verification_case_id=$2", [a.supersedes_id, caseId])).rows[0];
    if (!prev) throw new NotFoundError("Adjudication to revise not found");
    version = prev.version + 1;
  }
  const r = await db.query<{ id: string }>(
    `insert into adjudications (verification_case_id, category, severity, contributing_factors, reviewer_confidence, comments, status, version, created_by, supersedes_id)
     values ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9) returning id`,
    [caseId, a.category, a.severity, a.contributing_factors, a.reviewer_confidence, a.comments, version, actor.id, a.supersedes_id ?? null]);
  await audit(db, actor, "adjudication.draft", "verification_case", caseId, { adjudication_id: r.rows[0].id, category: a.category });
  return r.rows[0].id;
}

export async function finalizeAdjudication(db: Db, caseId: string, adjudicationId: string, actor: Actor) {
  const a = (await db.query<{ supersedes_id: string | null; status: string }>("select supersedes_id, status from adjudications where id=$1 and verification_case_id=$2", [adjudicationId, caseId])).rows[0];
  if (!a) throw new NotFoundError("Adjudication not found");
  if (a.status !== "draft") throw new ConflictError(`Adjudication is ${a.status}`);
  if (a.supersedes_id) await db.query("update adjudications set status='superseded' where id=$1 and status='final'", [a.supersedes_id]);
  await db.query("update adjudications set status='final' where id=$1", [adjudicationId]);
  await audit(db, actor, "adjudication.finalize", "verification_case", caseId, { adjudication_id: adjudicationId });
}

export async function setReviewStatus(db: Db, caseId: string, status: "final" | "reopened" | "in_review", actor: Actor, reason?: string) {
  await db.query("update verification_cases set review_status=$2 where id=$1", [caseId, status]);
  await audit(db, actor, `case.${status}`, "verification_case", caseId, reason ? { reason } : {});
}

export async function assignCase(db: Db, caseId: string, reviewer: string | null, actor: Actor) {
  await db.query("update verification_cases set assigned_reviewer=$2 where id=$1", [caseId, reviewer]);
  await audit(db, actor, "case.assign", "verification_case", caseId, { reviewer });
}

export async function ensureScoringVersion(db: Db, name: string, config: unknown, actor: Actor): Promise<string> {
  const json = canonicalJson(config);
  const hash = sha256(json);
  await db.query("insert into scoring_versions (name, config, config_hash, created_by) values ($1,$2,$3,$4) on conflict (config_hash) do nothing",
    [name, json, hash, actor.id]);
  return (await db.query<{ id: string }>("select id from scoring_versions where config_hash=$1", [hash])).rows[0].id;
}

export async function storeScores(db: Db, caseId: string, versionId: string, inputHash: string,
  rows: { metric_family: string; metric_name: string; metric_value: number | null; metric_payload: Record<string, unknown> }[]) {
  for (const r of rows) {
    await db.query(
      `insert into verification_scores (verification_case_id, scoring_version_id, metric_family, metric_name, metric_value, metric_payload, input_hash)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
      [caseId, versionId, r.metric_family, r.metric_name, r.metric_value, JSON.stringify(r.metric_payload), inputHash]);
  }
  await db.query("update verification_cases set scoring_version_id=$2 where id=$1", [caseId, versionId]);
}
