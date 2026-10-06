import { compareStages, dayChanges, summarizeTransitions, type StageDay } from "../../src/scoring/stages";
import { assessment, problem } from "./helpers";

const r = (alp: number, tln: number, btl: number) => ({
  alp: { kind: "rated" as const, level: alp as 1 }, tln: { kind: "rated" as const, level: tln as 1 }, btl: { kind: "rated" as const, level: btl as 1 },
});

describe("compareStages", () => {
  it("reports rating deltas as later − earlier and problem additions and removals", () => {
    const morning = assessment({ ratings: r(3, 2, 1), problems: [problem({ problem_type: "wind_slab" }), problem({ problem_type: "persistent_slab", rank: 2 })] });
    const afternoon = assessment({ ratings: r(4, 2, 1), problems: [problem({ problem_type: "wind_slab" }), problem({ problem_type: "storm_slab", rank: 2 })] });
    const c = compareStages("morning", "afternoon", morning, afternoon);
    expect(c.bands.alp).toEqual({ from: 3, to: 4, delta: 1 });
    expect(c.bands.tln.delta).toBe(0);
    expect(c.problemsAdded).toEqual(["storm_slab"]);
    expect(c.problemsRemoved).toEqual(["persistent_slab"]);
    expect(c.problemsKept).toEqual(["wind_slab"]);
    expect(c.changed).toBe(true);
  });
  it("does not compare a band that either stage left unrated", () => {
    const a = assessment({ ratings: { alp: { kind: "not_rated", state: "early_season" } } });
    const b = assessment({ ratings: r(2, 2, 2) });
    const c = compareStages("bulletin", "morning", a, b);
    expect(c.bands.alp.delta).toBeNull();
    expect(c.changed).toBe(false);
  });
  it("chains only the stages recorded for the day", () => {
    const changes = dayChanges({ bulletin: assessment({ ratings: r(3, 2, 1) }), afternoon: assessment({ ratings: r(2, 2, 1) }) });
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(["bulletin>afternoon"]);
    expect(changes[0].bands.alp.delta).toBe(-1);
  });
});

describe("summarizeTransitions", () => {
  const day = (date: string, morning: number, afternoon: number, hindsight: number | null, final = true, extra: Partial<StageDay["stages"]> = {}): StageDay => ({
    date, hindsightFinal: hindsight !== null && final,
    stages: {
      morning: assessment({ ratings: r(morning, 2, 1), problems: [problem({ problem_type: "wind_slab" })] }),
      afternoon: assessment({ ratings: r(afternoon, 2, 1), problems: [problem({ problem_type: "wind_slab" }), problem({ problem_type: "storm_slab", rank: 2 })] }),
      ...(hindsight === null ? {} : { hindsight: assessment({ assessment_kind: "hindsight", status: final ? "final" : "draft", ratings: r(hindsight, 2, 1), problems: [problem({ problem_type: "storm_slab" })] }) }),
      ...extra,
    },
  });
  const [bm, ma] = summarizeTransitions([
    day("2027-01-10", 3, 4, 4),        // raised, toward hindsight
    day("2027-01-11", 3, 4, 3),        // raised, away from hindsight
    day("2027-01-12", 3, 3, null),     // unchanged rating, no hindsight
    day("2027-01-13", 2, 3, 3, false), // draft hindsight is not a reference
  ]);
  it("counts days with both stages and how often the call changed", () => {
    expect(bm.days).toBe(0);
    expect(ma.days).toBe(4);
    expect(ma.daysChanged).toEqual({ numerator: 4, denominator: 4, value: 1 }); // storm slab added every day
  });
  it("splits rating changes by direction with denominators", () => {
    expect(ma.bands.alp.compared).toBe(4);
    expect(ma.bands.alp.raised).toMatchObject({ numerator: 3, denominator: 4 });
    expect(ma.bands.alp.unchanged).toMatchObject({ numerator: 1, denominator: 4 });
    expect(ma.bands.tln.raised.numerator).toBe(0);
  });
  it("uses only finalized hindsight to say whether a change moved toward it", () => {
    expect(ma.bands.alp.towardHindsight).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(ma.bands.alp.awayFromHindsight).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
  it("counts problems the later meeting added and whether hindsight kept them", () => {
    expect(ma.problemsAdded).toEqual({ storm_slab: 4 });
    expect(ma.addedConfirmed).toEqual({ numerator: 2, denominator: 2, value: 1 });
  });
});
