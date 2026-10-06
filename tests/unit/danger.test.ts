import { compareRating, quadraticWeightedKappa, summarizeDanger } from "../../src/scoring/danger";
import type { RatingCell } from "../../src/domain/vocab";

const r = (level: 1 | 2 | 3 | 4 | 5): RatingCell => ({ kind: "rated", level });

describe("compareRating", () => {
  it("signs error as forecast minus hindsight", () => {
    expect(compareRating(r(3), r(2))).toMatchObject({ eligible: true, signed: 1, absolute: 1, exact: false, withinOne: true });
    expect(compareRating(r(2), r(4))).toMatchObject({ signed: -2, absolute: 2, withinOne: false });
    expect(compareRating(r(3), r(3))).toMatchObject({ signed: 0, exact: true });
  });
  it("never treats a missing or non-rated cell as Low", () => {
    const early: RatingCell = { kind: "not_rated", state: "early_season" };
    const c = compareRating(early, r(1));
    expect(c.eligible).toBe(false);
    expect(c.signed).toBeNull();
    expect(c.exclusion).toContain("early_season");
    expect(compareRating(undefined, r(1)).exclusion).toContain("missing");
  });
});

describe("summarizeDanger", () => {
  // Hand-calculated: pairs (f,h) = (3,2) (2,2) (2,3) (4,2); one case excluded.
  const inputs = [
    { comparison: compareRating(r(3), r(2)) },
    { comparison: compareRating(r(2), r(2)) },
    { comparison: compareRating(r(2), r(3)) },
    { comparison: compareRating(r(4), r(2)) },
    { comparison: compareRating(r(3), r(3)), caseExclusion: "evidence class unknown_due_to_coverage" },
  ];
  const s = summarizeDanger(inputs, 30);
  it("counts denominators and exclusions", () => {
    expect(s.pairs).toBe(4);
    expect(s.excluded).toBe(1);
    expect(s.exclusionReasons).toEqual({ "evidence class unknown_due_to_coverage": 1 });
  });
  it("computes rates with numerators", () => {
    expect(s.exact).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
    expect(s.withinOne).toEqual({ numerator: 3, denominator: 4, value: 0.75 });
    expect(s.overforecast).toEqual({ numerator: 2, denominator: 4, value: 0.5 });
    expect(s.underforecast).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
  });
  it("computes MAE and mean signed error", () => {
    expect(s.meanAbsoluteError).toBe((1 + 0 + 1 + 2) / 4);
    expect(s.meanSignedError).toBe((1 + 0 - 1 + 2) / 4);
    expect(s.signedDistribution).toEqual({ "1": 1, "0": 1, "-1": 1, "2": 1 });
  });
  it("fills the confusion matrix forecast × hindsight", () => {
    expect(s.confusion[2][1]).toBe(1);
    expect(s.confusion[1][1]).toBe(1);
    expect(s.confusion[1][2]).toBe(1);
    expect(s.confusion[3][1]).toBe(1);
  });
  it("withholds kappa below the minimum sample", () => {
    expect(s.weightedKappa.value).toBeNull();
    expect(s.weightedKappa.reason).toContain("below 30");
  });
});

describe("quadraticWeightedKappa", () => {
  it("is 1 for perfect agreement", () => {
    expect(quadraticWeightedKappa([[2, 0, 0], [0, 3, 0], [0, 0, 1]])).toBeCloseTo(1);
  });
  it("matches a hand calculation", () => {
    // k=2, weights 0/1. observed = 1; rows [3,1], cols [2,2], n=4 → expected = 3·2/4 + 1·2/4 = 2 → κ = 0.5
    expect(quadraticWeightedKappa([[2, 1], [0, 1]])).toBeCloseTo(0.5);
  });
});
