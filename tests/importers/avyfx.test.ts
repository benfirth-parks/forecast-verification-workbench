import { readFileSync } from "node:fs";
import { importAvyfxFeed } from "../../src/importers/avyfx-feed";

const feed = JSON.parse(readFileSync(new URL("../fixtures/avyfx/SYNTHETIC-feed.json", import.meta.url), "utf8"));

describe("Parks Avy FX feed adapter", () => {
  const r = importAvyfxFeed(feed, { domainCode: "BYK", capturedAt: "2027-01-14T23:05:00Z", importRunId: "run-2" });
  const b = r.records[0];
  it("imports forecast days and a separate nowcast", () => {
    expect(r.summary.errors).toBe(0);
    const kinds = b.assessments.map((a) => `${a.assessment_kind}:${a.valid_date}`);
    expect(kinds).toEqual(["forecast:2027-01-15", "forecast:2027-01-16", "nowcast:2027-01-14"]);
    expect(b.assessments[1].ratings.btl).toEqual({ kind: "not_rated", state: "no_rating" });
  });
  it("maps rose cells (tl → tln) and Avy FX sensitivity/distribution", () => {
    const now = b.assessments.find((a) => a.assessment_kind === "nowcast")!;
    expect(now.problems[0]).toMatchObject({ problem_type: "storm_slab", cells: ["N:alp", "NE:alp", "N:tln"], sensitivity: "reactive", distribution: "widespread", expected_size_min: 1.5, expected_size_max: 1.5 });
    expect(b.assessments[0].problems[0].problem_type).toBe("wind_slab");
  });
});
