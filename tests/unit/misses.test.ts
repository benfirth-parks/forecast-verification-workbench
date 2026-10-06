import { DEFAULT_SCORING_CONFIG, scoreCase } from "../../src/scoring/case";
import { summarizeSeason, type ScoredCase } from "../../src/scoring/misses";
import { assessment, problem } from "./helpers";

// 10 synthetic cases: hindsight always has a persistent slab the forecast missed,
// alpine forecast one level low in 6 of them.
function cases(): ScoredCase[] {
  return Array.from({ length: 10 }, (_, i) => {
    const f = assessment({ ratings: { alp: { kind: "rated", level: 2 } }, problems: [problem({ problem_type: "wind_slab", expected_size_max: 1.5, cells: ["N:alp"] })] });
    const h = assessment({
      assessment_kind: "hindsight", forecast_issuance_id: null,
      ratings: { alp: { kind: "rated", level: i < 6 ? 3 : 2 } },
      problems: [problem({ problem_type: "wind_slab", expected_size_max: 2.5, cells: ["N:alp", "NE:alp"] }), problem({ problem_type: "persistent_slab", rank: 2 })],
    });
    return { caseId: `c${i}`, validDate: "2027-01-15", score: scoreCase({ outcome_evidence_class: "observed_positive" }, f, h), adjudications: [{ category: "problem_type", status: "final" }] };
  });
}

describe("summarizeSeason", () => {
  const all = [...cases(), { caseId: "excluded", validDate: "2027-01-16", score: scoreCase({ outcome_evidence_class: "unknown_due_to_coverage" }, assessment({}), assessment({ assessment_kind: "hindsight" })), adjudications: [] }];
  const s = summarizeSeason(all, DEFAULT_SCORING_CONFIG);
  it("reports included and excluded cases", () => {
    expect(s.totalCases).toBe(11);
    expect(s.includedCases).toBe(10);
    expect(s.exclusionReasons).toEqual({ "evidence class unknown_due_to_coverage": 1 });
  });
  it("finds the underforecast pattern with its denominator", () => {
    expect(s.dangerByBand.alp.underforecast).toEqual({ numerator: 6, denominator: 10, value: 0.6 });
    const flag = s.flags.find((f) => f.dimension === "danger" && f.subject === "alp");
    expect(flag?.message).toContain("6 of 10");
    expect(flag?.caseIds).toHaveLength(6);
  });
  it("finds the missed problem type and size bias", () => {
    const ps = s.problemTypes.find((p) => p.type === "persistent_slab")!;
    expect(ps.missed).toEqual({ numerator: 10, denominator: 10, value: 1 });
    expect(s.flags.some((f) => f.dimension === "problem_type" && f.subject === "persistent_slab")).toBe(true);
    const ws = s.problemTypes.find((p) => p.type === "wind_slab")!;
    expect(ws.meanSizeMaxDifference).toBe(-1);
    expect(ws.meanCombinedOverlap).toBe(0.5);
    expect(s.flags.some((f) => f.dimension === "size" && f.subject === "wind_slab")).toBe(true);
  });
  it("counts adjudication categories over included cases", () => {
    expect(s.adjudicationCategories.problem_type).toEqual({ numerator: 10, denominator: 10, value: 1 });
  });
  it("does not flag below the minimum case count", () => {
    const few = summarizeSeason(cases().slice(0, 5), DEFAULT_SCORING_CONFIG);
    expect(few.flags).toEqual([]);
  });
});
