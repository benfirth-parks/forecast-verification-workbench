// Builds a SYNTHETIC InfoEx-style workbook in memory so no binary fixture is committed.
import ExcelJS from "exceljs";

const wall = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

export async function syntheticWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Avalanches");
  ws.getCell("A1").value = "SYNTHETIC TEST FIXTURE - invented values, not real observations";
  ws.getRow(3).values = ["ID", "Date observed", "Confidence", "Location", "Size", "Trigger", "Aspect", "Elevation", "Problem", "Notes"];
  ws.getRow(4).values = ["XL-1", wall(2027, 1, 15, 10, 30), "high", "Synthetic slope A", 2, "Na", "NE", 2450, "wind slab", { richText: [{ text: "Synthetic " }, { text: "note", font: { bold: true } }] }];
  ws.getRow(5).values = ["XL-2", wall(2027, 1, 15, 13, 0), "moderate", "Synthetic slope B", { formula: "1+0.5", result: 1.5 }, "Sa", "N", 2300, "storm slab", ""];
  // row 6 left blank on purpose
  ws.getRow(7).values = ["XL-3", wall(2027, 1, 16), "low", "Synthetic slope C", { error: "#N/A" }, "Na", "E", 2200, "dry loose", ""];
  for (const r of [4, 5]) ws.getCell(`B${r}`).numFmt = "yyyy-mm-dd hh:mm";
  ws.getCell("B7").numFmt = "yyyy-mm-dd";
  wb.addWorksheet("Weather").getRow(1).values = ["Station", "Time", "HN24"];
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
