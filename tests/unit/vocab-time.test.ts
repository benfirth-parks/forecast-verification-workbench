import { AmbiguousLocalTimeError, localDate, localDayBounds, zonedToUtc, zoneDataPredatesAlbertaTime } from "../../src/domain/time";
import { parseLikelihoodRange, parseProblemType, parseRating, parseSize } from "../../src/domain/vocab";
import { canonicalJson } from "../../src/scoring/common";
import { DEFAULT_SCORING_CONFIG, scoringConfigKey } from "../../src/scoring/case";

describe("vocabularies", () => {
  it("parses ratings and keeps non-rated states distinct from Low", () => {
    expect(parseRating("considerable")).toEqual({ kind: "rated", level: 3 });
    expect(parseRating("3 - Considerable")).toEqual({ kind: "rated", level: 3 });
    expect(parseRating("earlyseason")).toEqual({ kind: "not_rated", state: "early_season" });
    expect(parseRating("No Rating")).toEqual({ kind: "not_rated", state: "no_rating" });
    expect(parseRating(null)).toEqual({ kind: "not_rated", state: "not_entered" });
    expect(parseRating("spicy")).toBeNull();
  });
  it("parses likelihood ranges in order", () => {
    expect(parseLikelihoodRange("possible_likely")).toEqual({ min: "possible", max: "likely" });
    expect(parseLikelihoodRange("very likely - possible")).toEqual({ min: "possible", max: "very_likely" });
    expect(parseLikelihoodRange("possible-very-likely")).toEqual({ min: "possible", max: "very_likely" });
    expect(parseLikelihoodRange("almost certain")).toEqual({ min: "almost_certain", max: "almost_certain" });
    expect(parseLikelihoodRange("maybe")).toBeNull();
  });
  it("parses problem spellings without merging types", () => {
    expect(parseProblemType("windSlab")).toBe("wind_slab");
    expect(parseProblemType("Deep Persistent Slab")).toBe("deep_persistent_slab");
    expect(parseProblemType("slush flow")).toBeNull();
  });
  it("accepts only half-class sizes 1–5", () => {
    expect(parseSize("2.5")).toBe(2.5);
    expect(parseSize("D3")).toBe(3);
    expect(parseSize("2.3")).toBeNull();
    expect(parseSize("6")).toBeNull();
  });
});

describe("time zones", () => {
  // Fixed to dates before November 2026: Alberta then moved to permanent UTC−6 (IANA tzdata 2026c),
  // so later winters have no clock changes and a different offset depending on the runtime's tz data.
  const Z = "America/Edmonton";
  it("converts wall time in winter and summer", () => {
    expect(zonedToUtc("2026-01-15", "07:00", Z)).toBe("2026-01-15T14:00:00.000Z");
    expect(zonedToUtc("2026-10-01", "17:00", Z)).toBe("2026-10-01T23:00:00.000Z");
  });
  it("refuses the repeated hour at fall-back unless told which", () => {
    expect(() => zonedToUtc("2025-11-02", "01:30", Z)).toThrow(AmbiguousLocalTimeError);
    expect(zonedToUtc("2025-11-02", "01:30", Z, "earlier")).toBe("2025-11-02T07:30:00.000Z");
    expect(zonedToUtc("2025-11-02", "01:30", Z, "later")).toBe("2025-11-02T08:30:00.000Z");
  });
  it("refuses the skipped hour at spring-forward", () => {
    expect(() => zonedToUtc("2026-03-08", "02:30", Z)).toThrow(AmbiguousLocalTimeError);
  });
  it("gives 25- and 23-hour local days around DST", () => {
    const fall = localDayBounds("2025-11-02", Z);
    expect((Date.parse(fall.end) - Date.parse(fall.start)) / 36e5).toBe(25);
    const spring = localDayBounds("2026-03-08", Z);
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / 36e5).toBe(23);
  });
  it("detects tz data that predates Alberta's permanent UTC−6 change", () => {
    expect(zoneDataPredatesAlbertaTime()).toBe((process.versions.tz ?? "") < "2026c");
  });
  it("computes the local date of a UTC instant", () => {
    expect(localDate("2026-10-02T05:30:00Z", Z)).toBe("2026-10-01");
  });
});

describe("scoring version identity", () => {
  it("hashes configuration independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    const changed = { ...DEFAULT_SCORING_CONFIG, kappa_minimum_sample: 40 };
    expect(scoringConfigKey(changed)).not.toBe(scoringConfigKey(DEFAULT_SCORING_CONFIG));
  });
});
