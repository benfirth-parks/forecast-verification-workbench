// Migration, constraint, immutability and RLS tests against embedded Postgres.
import type { PGlite } from "@electric-sql/pglite";
import { DEV_USERS } from "../../src/server/auth";
import { asUser, freshDb } from "./harness";

let pg: PGlite;
let domain: string;
let run: string;
let issuance: string;
const admin = DEV_USERS.administrator.id, reviewer = DEV_USERS.reviewer.id, viewer = DEV_USERS.viewer.id;

beforeAll(async () => {
  ({ pg } = (await freshDb()) as unknown as { pg: PGlite });
  domain = ((await pg.query("select id from forecast_domains where code='BYK'")).rows[0] as { id: string }).id;
  run = ((await pg.query(`insert into import_runs (adapter, adapter_version, source_system, source_identifier, checksum, dry_run, status, created_by)
    values ('t','1','test','fixture','abc',false,'committed',$1) returning id`, [admin])).rows[0] as { id: string }).id;
  issuance = ((await pg.query(`insert into forecast_issuances (forecast_domain_id, assessment_type, issued_at, valid_from, valid_to, time_zone, source_system,
    source_record_id, raw_payload, raw_payload_hash, status, captured_at, import_run_id)
    values ($1,'public_bulletin','2027-01-14T23:00Z','2027-01-14T23:00Z','2027-01-15T23:00Z','America/Edmonton','test','r1','{}','h1','issued',now(),$2) returning id`,
    [domain, run])).rows[0] as { id: string }).id;
});

const fails = async (p: Promise<unknown>, pattern: RegExp) => { await expect(p).rejects.toThrow(pattern); };

describe("constraints", () => {
  it("prevents duplicate ingestion of the same source version", async () => {
    await fails(pg.query(`insert into forecast_issuances (forecast_domain_id, assessment_type, issued_at, valid_from, valid_to, time_zone, source_system,
      source_record_id, raw_payload, raw_payload_hash, status, captured_at, import_run_id)
      values ($1,'public_bulletin','2027-01-14T23:00Z','2027-01-14T23:00Z','2027-01-15T23:00Z','America/Edmonton','test','r1','{}','h1','issued',now(),$2)`, [domain, run]), /duplicate key/);
  });
  it("requires a rating number exactly when the state is rated", async () => {
    const a = await draftAssessment("forecast");
    await fails(pg.query("insert into band_ratings values ($1,'alp',null,'rated')", [a]), /check constraint/);
    await fails(pg.query("insert into band_ratings values ($1,'alp',3,'early_season')", [a]), /check constraint/);
    await pg.query("insert into band_ratings values ($1,'alp',null,'early_season')", [a]);
  });
  it("rejects invalid vocabulary and size ranges", async () => {
    const a = await draftAssessment("forecast");
    await fails(pg.query("insert into avalanche_problems (hazard_assessment_id, problem_type) values ($1,'slush_flow')", [a]), /check constraint/);
    await fails(pg.query("insert into avalanche_problems (hazard_assessment_id, problem_type, expected_size_min, expected_size_max) values ($1,'wind_slab',3,2)", [a]), /check constraint/);
  });
  it("requires a rationale for every coverage statement", async () => {
    await fails(pg.query(`insert into data_coverage (forecast_domain_id, period_start, period_end, coverage_type, coverage_class, rationale, created_by)
      values ($1,'2027-01-15T07:00Z','2027-01-16T07:00Z','combined','high','  ',$2)`, [domain, reviewer]), /check constraint/);
  });
});

async function draftAssessment(kind: "forecast" | "hindsight", status = "draft") {
  const r = await pg.query(`insert into hazard_assessments (forecast_issuance_id, forecast_domain_id, assessment_kind, assessment_time, valid_from, valid_to, valid_date, status, version, created_by)
    values ($1,$2,$3,now(),'2027-01-15T07:00Z','2027-01-16T07:00Z','2027-01-15',$4,1,$5) returning id`, [kind === "forecast" ? issuance : null, domain, kind, status, admin]);
  return (r.rows[0] as { id: string }).id;
}

describe("immutability", () => {
  it("blocks edits and deletes of source records", async () => {
    await fails(pg.query("update forecast_issuances set status='cancelled' where id=$1", [issuance]), /immutable/);
    await fails(pg.query("delete from forecast_issuances where id=$1", [issuance]), /immutable/);
  });
  it("freezes final assessments but allows final → superseded", async () => {
    const a = await draftAssessment("forecast");
    await pg.query("insert into band_ratings values ($1,'alp',3,'rated')", [a]);
    await pg.query("update hazard_assessments set status='final' where id=$1", [a]);
    await fails(pg.query("update hazard_assessments set rationale='changed' where id=$1", [a]), /create a new version/);
    await fails(pg.query("update band_ratings set danger_rating=4 where hazard_assessment_id=$1", [a]), /frozen/);
    await fails(pg.query("delete from hazard_assessments where id=$1", [a]), /cannot delete/);
    await pg.query("update hazard_assessments set status='superseded' where id=$1", [a]);
    await fails(pg.query("update hazard_assessments set status='final' where id=$1", [a]), /cannot be edited/);
  });
  it("keeps audit events append-only", async () => {
    await pg.query("insert into audit_events (actor, action, entity) values ($1,'x','y')", [admin]);
    await fails(pg.query("update audit_events set action='z'"), /immutable/);
    await fails(pg.query("delete from audit_events"), /immutable/);
  });
  it("never deletes import runs and only lets bookkeeping change", async () => {
    await fails(pg.query("delete from import_runs where id=$1", [run]), /never deleted/);
    await fails(pg.query("update import_runs set checksum='other' where id=$1", [run]), /immutable/);
    await pg.query("update import_runs set status='committed', summary='{}' where id=$1", [run]);
  });
});

describe("row-level security", () => {
  it("shows nothing to a signed-in account without a role", async () => {
    const rows = await asUser(pg, "11111111-1111-4111-8111-111111111111", () => pg.query("select * from forecast_issuances"));
    expect(rows.rows).toHaveLength(0);
  });
  it("lets a viewer read evidence but not write", async () => {
    const rows = await asUser(pg, viewer, () => pg.query("select id from forecast_issuances"));
    expect(rows.rows.length).toBeGreaterThan(0);
    await fails(asUser(pg, viewer, () => pg.query(`insert into hazard_assessments (forecast_domain_id, assessment_kind, assessment_time, valid_from, valid_to, valid_date, status, version, created_by)
      values ($1,'hindsight',now(),'2027-01-15T07:00Z','2027-01-16T07:00Z','2027-01-15','draft',1,$2)`, [domain, viewer])), /row-level security/);
  });
  it("hides import diagnostics and audit history from viewers", async () => {
    expect((await asUser(pg, viewer, () => pg.query("select * from import_runs"))).rows).toHaveLength(0);
    expect((await asUser(pg, viewer, () => pg.query("select * from audit_events"))).rows).toHaveLength(0);
    expect((await asUser(pg, DEV_USERS.analyst.id, () => pg.query("select * from import_runs"))).rows.length).toBeGreaterThan(0);
  });
  it("lets a reviewer write their own hindsight, not someone else's or a forecast", async () => {
    await asUser(pg, reviewer, () => pg.query(`insert into hazard_assessments (forecast_domain_id, assessment_kind, assessment_time, valid_from, valid_to, valid_date, status, version, created_by)
      values ($1,'hindsight',now(),'2027-01-15T07:00Z','2027-01-16T07:00Z','2027-01-15','draft',1,$2)`, [domain, reviewer]));
    await fails(asUser(pg, reviewer, () => pg.query(`insert into hazard_assessments (forecast_domain_id, assessment_kind, assessment_time, valid_from, valid_to, valid_date, status, version, created_by)
      values ($1,'hindsight',now(),'2027-01-15T07:00Z','2027-01-16T07:00Z','2027-01-15','draft',1,$2)`, [domain, admin])), /row-level security/);
    await fails(asUser(pg, reviewer, () => pg.query(`insert into hazard_assessments (forecast_issuance_id, forecast_domain_id, assessment_kind, assessment_time, valid_from, valid_to, valid_date, status, version, created_by)
      values ($1,$2,'forecast',now(),'2027-01-15T07:00Z','2027-01-16T07:00Z','2027-01-15','draft',1,$3)`, [issuance, domain, reviewer])), /row-level security/);
  });
  it("lets only administrators insert source records", async () => {
    const sql = `insert into avalanche_events (forecast_domain_id, observed_at, location_confidence, observation_confidence, source_system, source_record_id, source_version, raw_payload, import_run_id)
      values ($1, now(), 'unknown', 'high', 'test', $2, 'v1', '{}', $3)`;
    await fails(asUser(pg, reviewer, () => pg.query(sql, [domain, "rls-1", run])), /row-level security/);
    await asUser(pg, admin, () => pg.query(sql, [domain, "rls-2", run]));
  });
  it("lets users see only their own user row unless administrator", async () => {
    expect((await asUser(pg, viewer, () => pg.query("select id from application_users"))).rows).toEqual([{ id: viewer }]);
    expect((await asUser(pg, admin, () => pg.query("select id from application_users"))).rows.length).toBe(4);
  });
});
