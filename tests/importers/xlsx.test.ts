// Spreadsheets are built in memory so no binary fixture is committed.
// Every value is SYNTHETIC test data.
import { createHash } from "node:crypto";
import { importObservations, type CsvMapping } from "../../src/importers/csv-observations";
import { readXlsx } from "../../src/importers/xlsx";
import { syntheticWorkbook } from "./xlsx-fixture";

const mapping: CsvMapping = {
  target: "avalanche_event", source_system: "synthetic-infoex", domain_code: "BYK", time_zone: "America/Edmonton",
  columns: { source_record_id: "ID", observed_at: "Date observed", observation_confidence: "Confidence", location_name: "Location",
    size: "Size", trigger_type: "Trigger", aspect: "Aspect", elevation_m: "Elevation", problem_type: "Problem" },
};

describe("xlsx reader", () => {
  it("finds the header row under a title row and keeps spreadsheet row numbers", async () => {
    const s = await readXlsx(await syntheticWorkbook());
    expect(s.sheet).toBe("Avalanches");
    expect(s.sheets).toEqual(["Avalanches", "Weather"]);
    expect(s.header_row).toBe(3);
    expect(s.row_numbers).toEqual([4, 5, 7]);
    expect(s.messages.map((m) => m.code)).toEqual(expect.arrayContaining(["first_sheet", "header_row", "cell_error"]));
  });
  it("reads dates as wall-clock text, formulas by their result, rich text as plain text", async () => {
    const [a, b, c] = (await readXlsx(await syntheticWorkbook())).rows;
    expect(a["Date observed"]).toBe("2027-01-15 10:30");
    expect(a.Notes).toBe("Synthetic note");
    expect(a.Size).toBe("2");
    expect(b.Size).toBe("1.5");
    expect(c["Date observed"]).toBe("2027-01-16");
    expect(c.Size).toBe("");
  });
  it("reports a missing sheet and an unreadable file instead of guessing", async () => {
    expect((await readXlsx(await syntheticWorkbook(), { sheet: "Nope" })).messages[0].code).toBe("missing_sheet");
    expect((await readXlsx(new TextEncoder().encode("ID,Date\n1,2027-01-15"))).messages[0].code).toBe("xlsx_parse");
  });
  it("feeds the mapping engine with the zone applied and row numbers from the sheet", async () => {
    const bytes = await syntheticWorkbook();
    const s = await readXlsx(bytes);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const r = importObservations({ data: s.rows, row_numbers: s.row_numbers, file_name: "synthetic.xlsx", import_run_id: "run-x", checksum, messages: s.messages }, mapping);
    expect(r.checksum).toBe(checksum);
    expect(r.records).toHaveLength(3);
    expect(r.records[0].record).toMatchObject({ observed_at: "2027-01-15T17:30:00.000Z", size_max: 2, aspect: "NE", problem_type: "wind_slab" });
    expect(r.records[1].record).toMatchObject({ size_max: 1.5, problem_type: "storm_slab" });
    const dateOnly = r.messages.find((m) => m.code === "date_only");
    expect(dateOnly?.row).toBe(7);
    expect(r.messages.find((m) => m.code === "unmapped_columns")?.message).toContain("Notes");
  });
});
