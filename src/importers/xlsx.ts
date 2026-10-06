// Reads one worksheet of an .xlsx export (for example from CAA InfoEx) into
// header-keyed text rows for the observation mapping engine. Values are
// converted to text exactly as stored; nothing is repaired.
//
// Excel stores no time zone: date/time cells are read as wall-clock values and
// the mapping's `time_zone` decides the instant, as for CSV.
import ExcelJS from "exceljs";
import type { ImportMessage } from "./common";

export const XLSX_ADAPTER = "xlsx-observations";
export const XLSX_ADAPTER_VERSION = "1.0.0";

export interface SheetRows {
  sheet: string;
  sheets: string[];
  /** 1-based spreadsheet row holding the column headers. */
  header_row: number;
  headers: string[];
  rows: Record<string, string>[];
  /** Spreadsheet row number of each entry in `rows` (blank rows are skipped). */
  row_numbers: number[];
  messages: ImportMessage[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Number formats that show a time part (ignoring quoted text and [colour]/[locale] blocks). */
const formatHasTime = (fmt: string | undefined) => /[hs]/i.test((fmt ?? "").replace(/\[[^\]]*\]|"[^"]*"/g, ""));

function dateText(d: Date, numFmt: string | undefined): string {
  // exceljs maps the serial number to a Date as if it were UTC, so the UTC
  // getters give back the wall-clock value typed into the sheet.
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hasClock = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
  if (!formatHasTime(numFmt) && !hasClock) return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ""}`;
}

type Push = (severity: ImportMessage["severity"], code: string, message: string) => void;

function cellText(value: ExcelJS.CellValue, numFmt: string | undefined, push: Push): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return dateText(value, numFmt);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("error" in value) { push("warning", "cell_error", `Cell holds the spreadsheet error ${value.error}; read as empty`); return ""; }
    if ("formula" in value || "sharedFormula" in value) {
      const result = (value as { result?: ExcelJS.CellValue }).result;
      if (result === undefined) { push("warning", "formula_without_result", "Formula cell has no saved result; read as empty. Re-save the file in Excel."); return ""; }
      return cellText(result as ExcelJS.CellValue, numFmt, push);
    }
    if ("text" in value) return String((value as { text: unknown }).text ?? "");
  }
  return String(value);
}

export async function readXlsx(bytes: Uint8Array, opts: { sheet?: string } = {}): Promise<SheetRows> {
  const messages: ImportMessage[] = [];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch (e) {
    messages.push({ severity: "error", code: "xlsx_parse", message: `Not a readable .xlsx file: ${(e as Error).message}` });
    return { sheet: "", sheets: [], header_row: 0, headers: [], rows: [], row_numbers: [], messages };
  }
  const sheets = wb.worksheets.map((w) => w.name);
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  if (!ws) {
    messages.push({ severity: "error", code: "missing_sheet", message: opts.sheet ? `No sheet named "${opts.sheet}". Sheets: ${sheets.join(", ")}` : "Workbook has no sheets" });
    return { sheet: opts.sheet ?? "", sheets, header_row: 0, headers: [], rows: [], row_numbers: [], messages };
  }
  if (sheets.length > 1 && !opts.sheet) messages.push({ severity: "info", code: "first_sheet", message: `Read the first sheet "${ws.name}" of ${sheets.length}: ${sheets.join(", ")}` });

  // Header row = first row with two or more values; exports often start with a
  // one-cell title row or two. A one-column sheet falls back to its first row.
  let headerRow = 0, firstRow = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (!firstRow) firstRow = n;
    if (!headerRow && row.actualCellCount >= 2) headerRow = n;
  });
  headerRow ||= firstRow;
  if (!headerRow) {
    messages.push({ severity: "error", code: "empty_sheet", message: `Sheet "${ws.name}" is empty` });
    return { sheet: ws.name, sheets, header_row: 0, headers: [], rows: [], row_numbers: [], messages };
  }
  const header = ws.getRow(headerRow);
  const byColumn = new Map<number, string>();
  const seen = new Map<string, number>();
  header.eachCell({ includeEmpty: false }, (cell, col) => {
    const name = cellText(cell.value, cell.numFmt, () => {}).trim();
    if (!name) return;
    if (seen.has(name)) messages.push({ severity: "error", code: "duplicate_header", message: `Column header "${name}" appears more than once (columns ${seen.get(name)} and ${col})`, row: headerRow });
    seen.set(name, col);
    byColumn.set(col, name);
  });
  if (headerRow > 1) messages.push({ severity: "info", code: "header_row", message: `Column headers read from spreadsheet row ${headerRow}` });

  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  for (let n = headerRow + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const out: Record<string, string> = Object.fromEntries([...byColumn.values()].map((h) => [h, ""]));
    let any = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const push: Push = (severity, code, message) => messages.push({ severity, code, message, row: n, field: byColumn.get(col) ?? cell.address });
      const text = cellText(cell.value, cell.numFmt, push);
      if (text === "") return;
      let name = byColumn.get(col);
      if (!name) {
        name = `(column ${cell.address.replace(/\d+$/, "")})`;
        push("warning", "unlabelled_column", `A value sits under a column with no header; kept as "${name}"`);
      }
      out[name] = text;
      any = true;
    });
    // Blank rows are skipped; row numbers stay aligned with the spreadsheet.
    if (any) { rows.push(out); rowNumbers.push(n); }
  }
  return { sheet: ws.name, sheets, header_row: headerRow, headers: [...byColumn.values()], rows, row_numbers: rowNumbers, messages };
}
