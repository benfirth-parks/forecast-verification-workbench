// End-to-end workflow through the API router against embedded Postgres.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { handle } from "../../src/server/api";
import { devAuthenticator } from "../../src/server/auth";
import { openLocalDb } from "../../src/server/local-db";
import type { Db } from "../../src/server/db";
import { DEFAULT_SCORING_CONFIG } from "../../src/scoring/case";
import { syntheticWorkbook } from "../importers/xlsx-fixture";

const fixture = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");
let db: Db;
const auth = devAuthenticator();
async function call(role: string, method: string, path: string, body?: unknown, scoring = DEFAULT_SCORING_CONFIG) {
  const res = await handle(new Request(`http://t/api/v1${path}`, {
    method, headers: { "x-dev-role": role, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { db, authenticate: auth, scoring });
  return { status: res.status, body: await res.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const bulletin = JSON.parse(fixture("avcan/SYNTHETIC-in-season.json"));
const obsMapping = {
  target: "avalanche_event", source_system: "synthetic-obs", domain_code: "BYK", time_zone: "America/Edmonton",
  columns: { source_record_id: "ID", observed_at: "Date observed", occurred_from: "Occurred from", observation_confidence: "Confidence",
    location_name: "Location", size: "Size", trigger_type: "Trigger", aspect: "Aspect", elevation_m: "Elevation", problem_type: "Problem" },
};
// The synthetic 16:00 bulletin on 2027-01-14 covers 2027-01-15, the day the synthetic avalanches occurred.
const obsCsv = fixture("csv/SYNTHETIC-avalanches.csv");

beforeAll(async () => { ({ db } = await openLocalDb()); });

describe("bulletin → case → hindsight → adjudication → analytics", () => {
  let caseId = "";

  it("requires sign-in and the right role", async () => {
    const res = await handle(new Request("http://t/api/v1/cases"), { db, authenticate: auth });
    expect(res.status).toBe(401);
    expect((await call("reviewer", "POST", "/imports/validate", { adapter: "avcan-bulletin", file_name: "b.json", payload: bulletin })).status).toBe(403);
  });

  it("validates, then commits, a bulletin and creates one case", async () => {
    const v = await call("administrator", "POST", "/imports/validate", { adapter: "avcan-bulletin", file_name: "b.json", payload: bulletin, captured_at: "2027-01-14T23:05:00Z" });
    expect(v.status).toBe(200);
    const outdated = (await call("viewer", "GET", "/me")).body.zone_data_outdated;
    expect(outdated).toBe((process.versions.tz ?? "") < "2026c");
    expect(v.body.messages.some((m: { code: string }) => m.code === "outdated_zone_data")).toBe(outdated);
    expect(v.body.summary.accepted).toBe(1);
    const c = await call("administrator", "POST", "/imports/commit", { adapter: "avcan-bulletin", file_name: "b.json", payload: bulletin, captured_at: "2027-01-14T23:05:00Z", expected_checksum: v.body.checksum });
    expect(c.body).toMatchObject({ inserted: 1, duplicates: 0, casesCreated: 1 });
    const list = await call("viewer", "GET", "/cases");
    expect(list.body.cases).toHaveLength(1);
    caseId = list.body.cases[0].id;
  });

  it("re-importing the identical payload creates no duplicates", async () => {
    const c = await call("administrator", "POST", "/imports/commit", { adapter: "avcan-bulletin", file_name: "b.json", payload: bulletin, captured_at: "2027-01-14T23:35:00Z" });
    expect(c.body).toMatchObject({ inserted: 0, duplicates: 1, casesCreated: 0 });
    expect((await call("viewer", "GET", "/cases")).body.cases).toHaveLength(1);
  });

  it("an edited bulletin becomes an amendment; the case keeps the as-issued version", async () => {
    const edited = structuredClone(bulletin);
    edited[1].report.dangerRatings[0].ratings.alp.rating.value = "high";
    const c = await call("administrator", "POST", "/imports/commit", { adapter: "avcan-bulletin", file_name: "b2.json", payload: edited, captured_at: "2027-01-15T02:00:00Z" });
    expect(c.body).toMatchObject({ inserted: 0, amended: 1, casesCreated: 0 });
    const d = await call("viewer", "GET", `/cases/${caseId}`);
    expect(d.body.amendments).toHaveLength(1);
    expect(d.body.forecast.ratings.alp).toEqual({ kind: "rated", level: 3 });
  });

  it("rejects a commit whose payload differs from the validated checksum", async () => {
    const c = await call("administrator", "POST", "/imports/commit", { adapter: "avcan-bulletin", file_name: "b.json", payload: bulletin, expected_checksum: "0".repeat(64) });
    expect(c.status).toBe(409);
  });

  it("imports observations idempotently", async () => {
    const body = { adapter: "csv-observations", file_name: "obs.csv", payload: obsCsv, mapping: obsMapping };
    expect((await call("administrator", "POST", "/imports/commit", body)).body).toMatchObject({ inserted: 3, duplicates: 0 });
    expect((await call("administrator", "POST", "/imports/commit", body)).body).toMatchObject({ inserted: 0, duplicates: 3 });
  });

  it("keeps differences locked until an independent hindsight is saved", async () => {
    const d = await call("viewer", "GET", `/cases/${caseId}`);
    expect(d.body.comparison).toBeNull();
    expect(d.body.evidence.avalanches.length).toBeGreaterThan(0);
    expect(d.body.issuance.raw_payload).toBeUndefined(); // viewers don't get raw source payloads
    expect(d.body.evidence.avalanches[0].raw_payload).toBeUndefined();
    expect(d.body.evidence.avalanches[0].geometry_geojson).toBeUndefined();
    const r = await call("reviewer", "GET", `/cases/${caseId}`);
    expect(r.body.evidence.avalanches[0].raw_payload).toBeDefined();
    expect((await call("reviewer", "POST", `/cases/${caseId}/adjudications`, { category: "problem_type", severity: null, contributing_factors: [], reviewer_confidence: "high", comments: null })).status).toBe(409);
  });

  it("a viewer cannot enter hindsight", async () => {
    expect((await call("viewer", "POST", `/cases/${caseId}/hindsight`, { ratings: {}, problems: [], confidence: null, rationale: null })).status).toBe(403);
  });

  it("classifies evidence with an observed avalanche as positive", async () => {
    const e = await call("reviewer", "POST", `/cases/${caseId}/evidence`, {});
    expect(e.body.evidence_class).toBe("observed_positive");
  });

  it("saves, compares, finalizes and versions hindsight", async () => {
    const hindsight = {
      ratings: { alp: { kind: "rated", level: 4 }, tln: { kind: "rated", level: 3 }, btl: { kind: "rated", level: 1 } },
      problems: [
        { problem_type: "wind_slab", rank: 1, elevation_bands: ["alp", "tln"], aspects: ["N", "NE", "E"], cells: null, minimum_elevation_m: null, maximum_elevation_m: null, likelihood_min: "likely", likelihood_max: "likely", sensitivity: null, distribution: null, expected_size_min: 1.5, expected_size_max: 2.5, trend: null, confidence: null, comments: null },
        { problem_type: "storm_slab", rank: 2, elevation_bands: ["alp"], aspects: ["N"], cells: null, minimum_elevation_m: null, maximum_elevation_m: null, likelihood_min: null, likelihood_max: null, sensitivity: null, distribution: null, expected_size_min: null, expected_size_max: null, trend: null, confidence: null, comments: null },
      ],
      confidence: "moderate", rationale: "Synthetic hindsight",
    };
    expect((await call("reviewer", "POST", `/cases/${caseId}/hindsight`, hindsight)).status).toBe(200);
    const d = await call("viewer", "GET", `/cases/${caseId}`);
    expect(d.body.comparison.danger.alp).toMatchObject({ signed: -1 });
    expect(d.body.comparison.problems.missed).toEqual(["storm_slab"]);
    expect(d.body.comparison.problems.unsupported).toEqual(["persistent_slab"]);
    expect(d.body.comparison.caseExclusion).toBe("hindsight not finalized");
    const f = await call("reviewer", "POST", `/cases/${caseId}/hindsight/finalize`, {});
    expect(f.body.version).toBe(1);
    // A revision is a new version; v1 stays until v2 is finalized, then becomes superseded.
    const rev = await call("reviewer", "POST", `/cases/${caseId}/hindsight`, { ...hindsight, rationale: "Revised" });
    expect(rev.body.version).toBe(2);
    await call("reviewer", "POST", `/cases/${caseId}/hindsight/finalize`, {});
    const h = await call("viewer", "GET", `/cases/${caseId}/hindsight/history`);
    expect(h.body.versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`)).toEqual(["1:superseded", "2:final"]);
  });

  it("records adjudications and finalizes the case", async () => {
    const a = await call("reviewer", "POST", `/cases/${caseId}/adjudications`, { category: "problem_type", severity: "moderate", contributing_factors: ["new snow underestimated"], reviewer_confidence: "moderate", comments: null });
    expect((await call("reviewer", "POST", `/cases/${caseId}/adjudications/finalize`, { id: a.body.id })).status).toBe(200);
    expect((await call("reviewer", "POST", `/cases/${caseId}/finalize`, {})).status).toBe(200);
  });

  it("includes the case in season analytics with denominators", async () => {
    const s = await call("viewer", "GET", "/analytics/summary");
    expect(s.body.season.includedCases).toBe(1);
    expect(s.body.season.dangerByBand.alp.underforecast).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(s.body.season.adjudicationCategories.problem_type.numerator).toBe(1);
  });

  it("a scoring change adds a new scoring version without replacing old scores", async () => {
    const changed = { ...DEFAULT_SCORING_CONFIG, name: "v1-draft-k40", kappa_minimum_sample: 40 };
    await call("reviewer", "POST", `/cases/${caseId}/hindsight`, { ratings: {}, problems: [], confidence: null, rationale: "v3" });
    await call("reviewer", "POST", `/cases/${caseId}/hindsight/finalize`, {}, changed);
    const versions = await db.query<{ n: number }>("select count(*)::int as n from scoring_versions");
    expect(versions.rows[0].n).toBe(2);
    const scores = await db.query<{ n: number }>("select count(distinct scoring_version_id)::int as n from verification_scores");
    expect(scores.rows[0].n).toBe(2);
  });

  it("writes an audit trail for imports and review actions", async () => {
    const a = await call("analyst", "GET", `/audit?entity_id=${caseId}`);
    const actions = a.body.events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["evidence.classify", "hindsight.create", "hindsight.finalize", "hindsight.revise", "adjudication.finalize", "case.final"]));
  });

  it("superseding an import hides its records without deleting them", async () => {
    const runs = (await call("administrator", "GET", "/imports")).body.runs as { id: string; adapter: string; status: string; dry_run: boolean }[];
    const bulletinRun = runs.filter((r) => r.adapter === "avcan-bulletin" && r.status === "committed" && !r.dry_run).at(-1)!;
    expect((await call("administrator", "POST", `/imports/${bulletinRun.id}/supersede`, { reason: "test supersession" })).status).toBe(200);
    expect((await call("viewer", "GET", "/cases")).body.cases).toHaveLength(0);
    const kept = await db.query<{ n: number }>("select count(*)::int as n from forecast_issuances");
    expect(kept.rows[0].n).toBe(2);
  });
});

describe("morning meeting workflow", () => {
  const morning = {
    date: "2027-01-20", issued_at: "2027-01-20T14:30:00Z",
    ratings: { alp: { kind: "rated", level: 3 }, tln: { kind: "rated", level: 3 }, btl: { kind: "rated", level: 2 } },
    problems: [], confidence: "moderate", rationale: "Synthetic morning",
    weather: [{ variable: "hn24", unit: "cm", location_reference: "Bow Summit", expected_min: 10, expected_max: 20 }],
  };
  it("creates a frozen morning assessment and a case; a resubmission is an amendment", async () => {
    const first = await call("reviewer", "POST", "/morning", morning);
    expect(first.body.amended).toBe(false);
    const again = await call("reviewer", "POST", "/morning", { ...morning, rationale: "Corrected" });
    expect(again.body.amended).toBe(true);
    const cases = (await call("viewer", "GET", "/cases?type=morning_hazard")).body.cases;
    expect(cases).toHaveLength(1);
    expect(cases[0].forecast.rationale).toBe("Synthetic morning");
  });
  it("attaches the afternoon nowcast and weather expectations to the case", async () => {
    await call("reviewer", "POST", "/nowcast", { date: "2027-01-20", issued_at: "2027-01-21T00:30:00Z", ratings: { alp: { kind: "rated", level: 4 } }, problems: [], confidence: "low", rationale: "Afternoon" });
    const id = (await call("viewer", "GET", "/cases?type=morning_hazard")).body.cases[0].id;
    const d = await call("viewer", "GET", `/cases/${id}`);
    expect(d.body.nowcasts).toHaveLength(1);
    expect(d.body.evidence.weatherExp[0]).toMatchObject({ variable: "hn24", location_reference: "Bow Summit" });
  });
  it("validates morning input", async () => {
    const bad = await call("reviewer", "POST", "/morning", { ...morning, ratings: { alp: { kind: "rated", level: 7 } } });
    expect(bad.status).toBe(400);
  });
  it("treats no reports and no coverage as unknown, then supported negative once coverage is stated", async () => {
    const id = (await call("viewer", "GET", "/cases?type=morning_hazard")).body.cases[0].id;
    expect((await call("reviewer", "POST", `/cases/${id}/evidence`, {})).body.evidence_class).toBe("unknown_due_to_coverage");
    await call("reviewer", "POST", `/cases/${id}/coverage`, { coverage_type: "combined", coverage_class: "high", visibility_class: "high", patrol_coverage_class: "moderate", mitigation_sampling_class: null, remote_detection_status: null, rationale: "Clear skies, two field teams" });
    expect((await call("reviewer", "POST", `/cases/${id}/evidence`, {})).body.evidence_class).toBe("supported_negative");
  });
});

describe("the day's calls: bulletin, morning meeting, afternoon meeting", () => {
  const rated = (alp: number, tln: number, btl: number) => ({ alp: { kind: "rated", level: alp }, tln: { kind: "rated", level: tln }, btl: { kind: "rated", level: btl } });
  const wind = { problem_type: "wind_slab", rank: 1, elevation_bands: ["alp"], aspects: ["NE"], cells: null, minimum_elevation_m: null, maximum_elevation_m: null, likelihood_min: null, likelihood_max: null, sensitivity: null, distribution: null, expected_size_min: null, expected_size_max: null, trend: null, confidence: null, comments: null };
  const storm = { ...wind, problem_type: "storm_slab", rank: 2 };
  let bulletinCase = "", morningCase = "";

  it("lines up the 17:00 bulletin with the next day's morning and afternoon meetings", async () => {
    const b = structuredClone(bulletin);
    b[1].id = b[1].report.id = "synthetic-byk-0002";
    b[1].report.dateIssued = "2027-02-01T00:00:00.000Z"; // 17:00 MST on 2027-01-31
    b[1].report.validUntil = "2027-02-02T00:00:00.000Z";
    b[1].report.dangerRatings[0].date.value = "2027-02-01T07:00:00Z";
    b[1].report.dangerRatings[1].date.value = "2027-02-02T07:00:00Z";
    expect((await call("administrator", "POST", "/imports/commit", { adapter: "avcan-bulletin", file_name: "b3.json", payload: b, captured_at: "2027-02-01T00:05:00Z" })).body.casesCreated).toBe(1);
    await call("reviewer", "POST", "/morning", { date: "2027-02-01", issued_at: "2027-02-01T15:00:00Z", ratings: rated(3, 2, 1), problems: [wind], confidence: "moderate", rationale: null, weather: [] });
    await call("reviewer", "POST", "/nowcast", { date: "2027-02-01", issued_at: "2027-02-01T23:00:00Z", ratings: rated(4, 3, 1), problems: [wind, storm], confidence: "moderate", rationale: null });
    const cases = (await call("viewer", "GET", "/cases?from=2027-02-01&to=2027-02-01")).body.cases as { id: string; assessment_type: string }[];
    bulletinCase = cases.find((c) => c.assessment_type === "public_bulletin")!.id;
    morningCase = cases.find((c) => c.assessment_type === "morning_hazard")!.id;
    const d = (await call("viewer", "GET", `/cases/${bulletinCase}`)).body;
    expect(Object.keys(d.stages.stages)).toEqual(["bulletin", "morning", "afternoon"]);
    expect(d.stages.meta.bulletin).toMatchObject({ horizon_days: 1, issued_at: "2027-02-01T00:00:00.000Z" });
    const [bm, ma] = d.stages.changes;
    expect(bm).toMatchObject({ from: "bulletin", to: "morning", problemsRemoved: ["persistent_slab"] });
    expect(bm.bands.alp.delta).toBe(0);
    expect(ma).toMatchObject({ from: "morning", to: "afternoon", problemsAdded: ["storm_slab"] });
    expect(ma.bands.alp.delta).toBe(1);
    expect(ma.bands.tln.delta).toBe(1);
  });

  it("never shows one case's hindsight on another case", async () => {
    await call("reviewer", "POST", `/cases/${bulletinCase}/hindsight`, { ratings: rated(4, 3, 1), problems: [storm], confidence: "moderate", rationale: "Synthetic" });
    await call("reviewer", "POST", `/cases/${bulletinCase}/hindsight/finalize`, {});
    expect((await call("viewer", "GET", `/cases/${bulletinCase}`)).body.stages.stages.hindsight).toBeDefined();
    expect((await call("viewer", "GET", `/cases/${morningCase}`)).body.stages.stages.hindsight).toBeUndefined();
  });

  it("summarizes how the call changed through the day in analytics", async () => {
    const s = (await call("viewer", "GET", "/analytics/summary?from=2027-02-01&to=2027-02-01")).body;
    const ma = s.stages.find((t: { from: string; to: string }) => t.from === "morning" && t.to === "afternoon");
    expect(ma.days).toBe(1);
    expect(ma.bands.alp.raised).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(ma.bands.alp.towardHindsight).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(ma.problemsAdded).toEqual({ storm_slab: 1 });
    expect(ma.addedConfirmed).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });
});

describe("spreadsheet (InfoEx-style) observations", () => {
  const mapping = {
    target: "avalanche_event", source_system: "synthetic-infoex", domain_code: "BYK", time_zone: "America/Edmonton",
    columns: { source_record_id: "ID", observed_at: "Date observed", observation_confidence: "Confidence", location_name: "Location", size: "Size", aspect: "Aspect", elevation_m: "Elevation", problem_type: "Problem" },
  };
  it("validates and commits an .xlsx upload idempotently, keyed by the file's own checksum", async () => {
    const bytes = await syntheticWorkbook();
    const body = { adapter: "xlsx-observations", file_name: "synthetic.xlsx", payload: Buffer.from(bytes).toString("base64"), mapping };
    const v = await call("administrator", "POST", "/imports/validate", body);
    expect(v.status).toBe(200);
    expect(v.body.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(v.body.summary.accepted).toBe(3);
    const c = await call("administrator", "POST", "/imports/commit", { ...body, expected_checksum: v.body.checksum });
    expect(c.body).toMatchObject({ inserted: 3, duplicates: 0 });
    expect((await call("administrator", "POST", "/imports/commit", body)).body).toMatchObject({ inserted: 0, duplicates: 3 });
    const runs = (await call("administrator", "GET", "/imports")).body.runs as { adapter: string; dry_run: boolean }[];
    expect(runs.some((r) => r.adapter === "xlsx-observations" && !r.dry_run)).toBe(true);
  });
  it("rejects a payload that is not base64 text", async () => {
    expect((await call("administrator", "POST", "/imports/validate", { adapter: "xlsx-observations", file_name: "x.xlsx", payload: [1, 2], mapping })).status).toBe(400);
  });
});
