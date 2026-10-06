import { readFileSync } from "node:fs";
import { importObservations, type CsvMapping } from "../../src/importers/csv-observations";
import { zonedToUtc } from "../../src/domain/time";

const read = (f: string) => readFileSync(new URL(`../fixtures/csv/${f}`, import.meta.url), "utf8");
const mapping: CsvMapping = {
  target: "avalanche_event", source_system: "synthetic-obs", domain_code: "BYK", time_zone: "America/Edmonton",
  columns: { source_record_id: "ID", observed_at: "Date observed", occurred_from: "Occurred from", observation_confidence: "Confidence",
    location_name: "Location", size: "Size", trigger_type: "Trigger", aspect: "Aspect", elevation_m: "Elevation", problem_type: "Problem" },
};

describe("CSV observations — valid file", () => {
  const r = importObservations({ data: read("SYNTHETIC-avalanches.csv"), file_name: "a.csv", import_run_id: "run" }, mapping);
  it("imports every row with normalized fields", () => {
    expect(r.summary.errors).toBe(0);
    expect(r.records).toHaveLength(3);
    const [a, b] = r.records.map((x) => x.record) as never[] as { observed_at: string; elevation_m: number; problem_type: string; size_max: number; aspect: string }[];
    // 2027 offsets depend on the runtime's tz data (Alberta moved to permanent UTC−6 in November 2026),
    // so local times are checked against zonedToUtc, which is pinned to fixed offsets in vocab-time.test.ts.
    expect(a).toMatchObject({ observed_at: zonedToUtc("2027-01-15", "10:30", "America/Edmonton"), elevation_m: 2450, problem_type: "wind_slab", size_max: 2, aspect: "NE" });
    expect(b).toMatchObject({ observed_at: "2027-01-15T18:00:00.000Z", elevation_m: 2408, problem_type: "storm_slab" });
  });
  it("normalizes mixed units with info and warning messages", () => {
    expect(r.messages.some((m) => m.code === "unit_converted" && m.severity === "info")).toBe(true);
    expect(r.messages.some((m) => m.code === "mixed_units" && m.severity === "warning")).toBe(true);
  });
  it("preserves unknown columns in the raw payload", () => {
    expect(r.messages.some((m) => m.code === "unmapped_columns" && m.message.includes("Observer notes"))).toBe(true);
    expect((r.records[0].record as { raw_payload: Record<string, string> }).raw_payload["Observer notes"]).toBe("synthetic");
  });
  it("is deterministic for idempotent re-import", () => {
    const again = importObservations({ data: read("SYNTHETIC-avalanches.csv"), file_name: "a.csv", import_run_id: "run2" }, mapping);
    expect(again.checksum).toBe(r.checksum);
    expect(again.records.map((x) => x.record.provenance.source_version)).toEqual(r.records.map((x) => x.record.provenance.source_version));
  });
});

describe("CSV observations — errors", () => {
  const r = importObservations({ data: read("SYNTHETIC-avalanches-errors.csv"), file_name: "e.csv", import_run_id: "run" }, mapping);
  const at = (row: number) => r.messages.filter((m) => m.row === row);
  it("rejects a missing required field", () => expect(at(2).some((m) => m.code === "missing_value" && m.field === "observed_at")).toBe(true));
  it("rejects invalid codes without repairing them", () => {
    const codes = at(3).filter((m) => m.code === "invalid_code").map((m) => m.field);
    expect(codes).toEqual(expect.arrayContaining(["size", "aspect", "problem_type"]));
  });
  it("rejects a local time repeated at the DST change", () => expect(at(4).some((m) => m.code === "ambiguous_time")).toBe(true));
  it("rejects a duplicate record in the same file", () => expect(at(6).some((m) => m.code === "duplicate_in_file")).toBe(true));
  it("flags date-only times instead of inventing precision", () => {
    expect(at(7).some((m) => m.code === "date_only" && m.severity === "warning")).toBe(true);
  });
  it("rejects a partial row", () => expect(at(8).some((m) => m.code === "partial_row")).toBe(true));
  it("accepts only the clean rows", () => {
    expect(r.records.map((x) => x.record.provenance.source_record_id)).toEqual(["E-4", "E-5"]);
    expect(r.rejected.map((x) => x.row)).toEqual([2, 3, 4, 6, 8]);
  });
  it("rejects a mapping that names a missing column", () => {
    const bad = importObservations({ data: read("SYNTHETIC-avalanches.csv"), file_name: "a.csv", import_run_id: "run" }, { ...mapping, columns: { ...mapping.columns, aspect: "Aspekt" } });
    expect(bad.records).toHaveLength(0);
    expect(bad.messages[0]).toMatchObject({ code: "missing_column", severity: "error" });
  });
});

describe("CSV observations — weather (wide format)", () => {
  const r = importObservations({ data: read("SYNTHETIC-weather.csv"), file_name: "w.csv", import_run_id: "run" }, {
    target: "weather_observation", source_system: "synthetic-wx", domain_code: "BYK", time_zone: "America/Edmonton",
    columns: { station_code: "Station", observed_at: "Time" },
    variables: { hn24: { column: "HN24 (cm)", unit: "cm" }, hw24: { column: "HW24 (mm)", unit: "mm" } },
  });
  it("splits wide rows into one observation per variable", () => {
    expect(r.records).toHaveLength(4);
    expect(r.records[0].record).toMatchObject({ station_code: "Bow Summit", variable: "hn24", value: 24, observed_at: zonedToUtc("2027-01-16", "07:00", "America/Edmonton") });
  });
  it("stores non-numeric readings as missing with a flag, never as 0", () => {
    const broken = r.records.find((x) => x.record.provenance.source_record_id.startsWith("Sunshine") && (x.record as { variable: string }).variable === "hn24")!.record as { value: number | null; quality_flags: string[] };
    expect(broken.value).toBeNull();
    expect(broken.quality_flags).toContain("non_numeric");
  });
});
