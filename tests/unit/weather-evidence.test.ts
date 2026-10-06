import { classifyEvidence, DEFAULT_EVIDENCE_RULE } from "../../src/scoring/evidence";
import { peirceSkillScore, summarizeWeather, timingErrorHours } from "../../src/scoring/weather";

describe("weather", () => {
  const pairs = [
    { variable: "hn24" as const, expected: { expected_min: 10, expected_max: 20, expected_value: null }, observed: 25 },
    { variable: "hn24" as const, expected: { expected_min: 0, expected_max: 5, expected_value: null }, observed: 2 },
    { variable: "hn24" as const, expected: { expected_min: null, expected_max: null, expected_value: 30 }, observed: 10 },
    { variable: "hn24" as const, expected: { expected_min: 5, expected_max: 10, expected_value: null }, observed: null },
  ];
  const s = summarizeWeather(pairs, "hn24", 20);
  it("computes bias and MAE from point forecasts (range midpoint)", () => {
    // errors: 15−25=−10, 2.5−2=0.5, 30−10=20
    expect(s.pairs).toBe(3);
    expect(s.excludedMissingObservation).toBe(1);
    expect(s.bias).toBeCloseTo((-10 + 0.5 + 20) / 3);
    expect(s.meanAbsoluteError).toBeCloseTo((10 + 0.5 + 20) / 3);
  });
  it("computes range coverage only where a range was forecast", () => {
    expect(s.rangeCoverage).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
  it("computes threshold agreement", () => {
    // ≥20: f(15)=no o(25)=yes miss; f(2.5) no o(2) no CN; f(30) yes o(10) no FA
    expect(s.threshold).toMatchObject({ hits: 0, misses: 1, falseAlarms: 1, correctNegatives: 1 });
    expect(s.threshold!.agreement).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
  });
  it("computes timing error and Peirce skill", () => {
    expect(timingErrorHours("2027-01-15T12:00:00Z", "2027-01-15T06:00:00Z")).toBe(6);
    expect(peirceSkillScore({ hits: 8, misses: 2, falseAlarms: 3, correctNegatives: 87 })).toBeCloseTo(0.8 - 3 / 90);
  });
});

describe("classifyEvidence", () => {
  const none = { avalanches: [], mitigation: [], coverage: [], conflicts: [] };
  it("treats no reports and no coverage as unknown, never negative", () => {
    expect(classifyEvidence(none).evidence_class).toBe("unknown_due_to_coverage");
  });
  it("stays unknown when coverage is too weak", () => {
    const c = classifyEvidence({ ...none, coverage: [{ coverage_class: "low", visibility_class: "low", patrol_coverage_class: null, mitigation_sampling_class: null, remote_detection_status: null }] });
    expect(c.evidence_class).toBe("unknown_due_to_coverage");
  });
  it("gives a supported negative only when the coverage rule is met", () => {
    const c = classifyEvidence({ ...none, coverage: [{ coverage_class: "moderate", visibility_class: "high", patrol_coverage_class: null, mitigation_sampling_class: null, remote_detection_status: null }] });
    expect(c.evidence_class).toBe("supported_negative");
    expect(c.rationale).toContain("visibility");
  });
  it("needs a qualifying-confidence avalanche for observed positive", () => {
    expect(classifyEvidence({ ...none, avalanches: [{ observation_confidence: "low", size_min: 2, size_max: 2 }] }).evidence_class).toBe("unknown_due_to_coverage");
    expect(classifyEvidence({ ...none, avalanches: [{ observation_confidence: "high", size_min: 2, size_max: 2 }] }).evidence_class).toBe("observed_positive");
  });
  it("applies a minimum size when the rule has one", () => {
    const rule = { ...DEFAULT_EVIDENCE_RULE, id: "min2", minimum_size: 2 };
    expect(classifyEvidence({ ...none, avalanches: [{ observation_confidence: "high", size_min: 1, size_max: 1.5 }] }, rule).evidence_class).toBe("unknown_due_to_coverage");
  });
  it("reports conflicts and not-applicable explicitly", () => {
    expect(classifyEvidence({ ...none, conflicts: ["two reports disagree on date"] }).evidence_class).toBe("conflicting_evidence");
    expect(classifyEvidence({ ...none, notApplicable: "no below-treeline terrain observed" }).evidence_class).toBe("not_applicable");
  });
});
