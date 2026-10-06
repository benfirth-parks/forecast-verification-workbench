import { readFileSync } from "node:fs";
import { importAvcanProducts } from "../../src/importers/avcan-bulletin";

const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/avcan/${f}`, import.meta.url), "utf8"));
const opts = { domainCode: "BYK", capturedAt: "2026-10-01T23:10:00Z", importRunId: "run-1" };

describe("avalanche.ca adapter — live BYK product (2026-10-01)", () => {
  const r = importAvcanProducts(load("byk-2026-10-01-live.json"), opts);
  const b = r.records[0];
  it("imports one issuance with source provenance", () => {
    expect(r.records).toHaveLength(1);
    expect(r.summary.errors).toBe(0);
    expect(b.issuance).toMatchObject({
      source_system: "avalanche.ca", assessment_type: "public_bulletin", issued_at: "2026-10-01T23:00:00.000Z",
      valid_to: "2026-10-15T23:00:00.000Z", time_zone: "America/Edmonton", import_run_id: "run-1",
    });
    expect(b.issuance.source_record_id).toMatch(/^13d6edf8-/);
    expect(b.issuance.raw_payload_hash).toHaveLength(64);
    expect(b.sub_area.title).toContain("Lake Louise");
  });
  it("keeps early-season and no-rating states distinct from numeric ratings", () => {
    expect(b.assessments).toHaveLength(3);
    expect(b.assessments[0].ratings.alp).toEqual({ kind: "not_rated", state: "early_season" });
    expect(b.assessments[0].ratings.btl).toEqual({ kind: "not_rated", state: "no_rating" });
  });
  it("maps days with the payload-date rule and flags it as unconfirmed", () => {
    expect(b.assessments.map((a) => a.valid_date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(b.assessments.map((a) => a.forecast_horizon_days)).toEqual([0, 1, 2]);
    expect(r.messages.some((m) => m.code === "day_one_rule" && m.severity === "info")).toBe(true);
  });
  it("can apply the next-day rule instead", () => {
    const n = importAvcanProducts(load("byk-2026-10-01-live.json"), { ...opts, dayOneRule: "next_day_plus_index" });
    expect(n.records[0].assessments[0].valid_date).toBe("2026-10-02");
  });
  it("produces the same hash for the same payload (idempotent re-import key)", () => {
    const again = importAvcanProducts(load("byk-2026-10-01-live.json"), { ...opts, capturedAt: "2026-10-02T00:00:00Z" });
    expect(again.records[0].issuance.raw_payload_hash).toBe(b.issuance.raw_payload_hash);
    expect(again.checksum).toBe(r.checksum);
  });
  it("warns when a snapshot was captured long after issue", () => {
    const late = importAvcanProducts(load("byk-2026-10-01-live.json"), { ...opts, capturedAt: "2026-10-06T15:00:00Z" });
    expect(late.messages.some((m) => m.code === "late_capture")).toBe(true);
  });
});

describe("avalanche.ca adapter — synthetic in-season shape", () => {
  const r = importAvcanProducts(load("SYNTHETIC-in-season.json"), { ...opts, capturedAt: "2027-01-14T23:05:00Z" });
  it("ignores other forecast centres", () => {
    expect(r.records).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
  });
  it("parses ratings, problems, aspects, likelihood ranges and sizes", () => {
    const a = r.records[0].assessments[0];
    expect(a.ratings).toEqual({ alp: { kind: "rated", level: 3 }, tln: { kind: "rated", level: 2 }, btl: { kind: "rated", level: 1 } });
    expect(a.problems).toHaveLength(2);
    expect(a.problems[0]).toMatchObject({ problem_type: "wind_slab", elevation_bands: ["alp", "tln"], aspects: ["N", "NE", "E"], likelihood_min: "possible", likelihood_max: "likely", expected_size_min: 1, expected_size_max: 2 });
    expect(a.problems[1]).toMatchObject({ problem_type: "persistent_slab", likelihood_min: "unlikely", expected_size_min: 1.5, expected_size_max: 2.5 });
    expect(r.records[0].assessments[1].problems).toEqual([]);
    expect(a.confidence).toBe("moderate");
  });
  it("uses the local date for a 00:00Z date value (17:00 the day before in Mountain time)", () => {
    expect(r.records[0].assessments[0].valid_date).toBe("2027-01-14");
  });
});

describe("avalanche.ca adapter — invalid input", () => {
  const base = load("SYNTHETIC-in-season.json")[1];
  it("rejects an unknown danger rating code", () => {
    const bad = structuredClone(base);
    bad.report.dangerRatings[0].ratings.alp.rating.value = "spicy";
    const r = importAvcanProducts([bad], opts);
    expect(r.records).toHaveLength(0);
    expect(r.messages.find((m) => m.severity === "error")?.code).toBe("invalid_code");
  });
  it("rejects a product without a time zone instead of guessing", () => {
    const bad = structuredClone(base);
    delete bad.report.timezone;
    const r = importAvcanProducts([bad], opts);
    expect(r.records).toHaveLength(0);
    expect(r.messages.some((m) => m.field === "report.timezone")).toBe(true);
  });
  it("warns, not fails, when a problem lacks the expected data object", () => {
    const odd = structuredClone(base);
    odd.report.problems = [{ type: { value: "stormSlab" } }];
    const r = importAvcanProducts([odd], opts);
    expect(r.records).toHaveLength(1);
    expect(r.messages.some((m) => m.code === "unexpected_shape")).toBe(true);
  });
});
