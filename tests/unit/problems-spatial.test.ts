import { matchProblems } from "../../src/scoring/problems";
import { aspectArcOverlap, compareSpatial, elevationRangeOverlap } from "../../src/scoring/spatial";
import { compareLikelihoodSize, sizeClasses } from "../../src/scoring/likelihood-size";
import { problem } from "./helpers";

describe("matchProblems", () => {
  const f = [problem({ problem_type: "wind_slab", rank: 1 }), problem({ problem_type: "storm_slab", rank: 2 })];
  const h = [problem({ problem_type: "persistent_slab", rank: 1 }), problem({ problem_type: "wind_slab", rank: 2 })];
  it("computes precision, recall and F1 on sets", () => {
    const m = matchProblems(f, h);
    expect(m.truePositives).toEqual(["wind_slab"]);
    expect(m.missed).toEqual(["persistent_slab"]);
    expect(m.unsupported).toEqual(["storm_slab"]);
    expect(m.precision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(m.recall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(m.f1).toBeCloseTo(0.5);
    expect(m.primaryCorrect).toBe(false);
  });
  it("does not equate distinct types without an explicit synonym group", () => {
    const m = matchProblems([problem({ problem_type: "persistent_slab" })], [problem({ problem_type: "deep_persistent_slab" })]);
    expect(m.truePositives).toEqual([]);
    const s = matchProblems([problem({ problem_type: "persistent_slab" })], [problem({ problem_type: "deep_persistent_slab" })], [["persistent_slab", "deep_persistent_slab"]]);
    expect(s.truePositives).toEqual(["persistent_slab"]);
  });
  it("handles empty sides", () => {
    const m = matchProblems([], []);
    expect(m.precision.value).toBeNull();
    expect(m.f1).toBeNull();
    expect(matchProblems([], h).f1).toBe(0);
  });
});

describe("spatial", () => {
  it("handles aspect arcs crossing north (0°)", () => {
    // NW→NE (315→45) vs N→E (0→90): intersection 0–45 = 45°, union 135° → 1/3
    expect(aspectArcOverlap({ from: 315, to: 45 }, { from: 0, to: 90 })).toBeCloseTo(1 / 3);
    expect(aspectArcOverlap({ from: 350, to: 10 }, { from: 340, to: 20 })).toBeCloseTo(20 / 40);
    expect(aspectArcOverlap({ from: 90, to: 180 }, { from: 270, to: 0 })).toBe(0);
  });
  it("computes elevation range overlap", () => {
    expect(elevationRangeOverlap([1800, 2400], [2100, 2700])).toBeCloseTo(300 / 900);
    expect(elevationRangeOverlap([1800, null], [2100, 2700])).toBeNull();
  });
  it("compares aspect × band cells", () => {
    const f = problem({ aspects: ["N", "NE"], elevation_bands: ["alp"] });
    const h = problem({ cells: ["N:alp", "N:tln"] });
    const s = compareSpatial(f, h);
    // cells F {N:alp, NE:alp}, H {N:alp, N:tln} → 1/3
    expect(s.combinedOverlap).toBeCloseTo(1 / 3);
    expect(s.aspectOverlap).toBeCloseTo(1 / 2);
    expect(s.elevationBandOverlap).toBeCloseTo(1 / 2);
    expect(s.forecastOnlyCells).toEqual(["NE:alp"]);
    expect(s.hindsightOnlyCells).toEqual(["N:tln"]);
  });
});

describe("likelihood and size", () => {
  it("expands half-size classes", () => {
    expect(sizeClasses(1.5, 2.5)).toEqual([1.5, 2, 2.5]);
    expect(sizeClasses(2, null)).toEqual([2]);
  });
  it("reports ordinal steps and direction", () => {
    const c = compareLikelihoodSize(
      problem({ likelihood_min: "possible", likelihood_max: "likely", expected_size_min: 1, expected_size_max: 2, sensitivity: "reactive" }),
      problem({ likelihood_min: "likely", likelihood_max: "very_likely", expected_size_min: 1.5, expected_size_max: 3, sensitivity: "touchy" }),
    );
    expect(c.likelihoodMinSteps).toBe(-1);
    expect(c.likelihoodMaxSteps).toBe(-1);
    expect(c.likelihoodDirection).toBe("under");
    expect(c.likelihoodOverlap).toBeCloseTo(1 / 3);
    expect(c.sizeMinDifference).toBe(-0.5);
    expect(c.sizeMaxDifference).toBe(-1);
    expect(c.sizeDirection).toBe("under");
    // F {1,1.5,2} H {1.5,2,2.5,3} → 2/5
    expect(c.sizeOverlap).toBeCloseTo(2 / 5);
    expect(c.sensitivitySteps).toBe(-1);
  });
  it("is not comparable when a side is missing", () => {
    const c = compareLikelihoodSize(problem({}), problem({ expected_size_max: 2 }));
    expect(c.sizeDirection).toBe("not_comparable");
    expect(c.likelihoodMaxSteps).toBeNull();
  });
});
