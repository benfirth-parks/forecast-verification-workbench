// Adapter: CSV (or JSON rows) of avalanche observations, mitigation results,
// field observations or weather-station readings, driven by a field mapping.
// Every source column is preserved in raw_payload; nothing is silently repaired.
import Papa from "papaparse";
import type { AvalancheEvent, FieldObservation, MitigationAction, Provenance, WeatherObservation, WeatherVariable } from "../domain/types";
import { AmbiguousLocalTimeError, zonedToUtc } from "../domain/time";
import { parseAspect, parseElevationBand, parseProblemType, parseSize } from "../domain/vocab";
import { finish, payloadHash, sha256, uuid, type ImportMessage, type ImportResult } from "./common";

export const CSV_ADAPTER = "csv-observations";
export const CSV_ADAPTER_VERSION = "1.0.0";

export type CsvTarget = "avalanche_event" | "mitigation_action" | "field_observation" | "weather_observation";

export interface CsvMapping {
  target: CsvTarget;
  source_system: string;
  domain_code: string;
  /** canonical field → source column header. Keys starting "payload." go to standardized_payload. */
  columns: Record<string, string>;
  /** Zone for timestamps without an explicit offset. */
  time_zone: string;
  /** Unit of elevation values without a suffix. */
  elevation_unit?: "m" | "ft";
  /** weather_observation, wide format: variable → { column, unit }. */
  variables?: Partial<Record<WeatherVariable, { column: string; unit: string }>>;
}

const REQUIRED: Record<CsvTarget, string[]> = {
  avalanche_event: ["source_record_id", "observed_at", "observation_confidence"],
  mitigation_action: ["source_record_id", "action_time", "method", "result_class", "observation_confidence"],
  field_observation: ["source_record_id", "observed_at", "observation_type"],
  weather_observation: ["station_code", "observed_at"],
};

export type ObservationRecord =
  | { kind: "avalanche_event"; record: AvalancheEvent }
  | { kind: "mitigation_action"; record: MitigationAction }
  | { kind: "field_observation"; record: FieldObservation }
  | { kind: "weather_observation"; record: WeatherObservation };

export interface CsvInput {
  /** CSV text, or an array of row objects (JSON or spreadsheet adapter). */
  data: string | Record<string, unknown>[];
  file_name: string;
  import_run_id: string;
  /** Source row number of each entry in `data` rows (spreadsheets); defaults to header on line 1. */
  row_numbers?: number[];
  /** Checksum of the original file when `data` was decoded from it (spreadsheets). */
  checksum?: string;
  /** Messages from decoding the file, reported with the import's own. */
  messages?: ImportMessage[];
}

export function importObservations(input: CsvInput, mapping: CsvMapping): ImportResult<ObservationRecord> {
  const messages: ImportMessage[] = [...(input.messages ?? [])];
  const records: ObservationRecord[] = [];
  const rejected: { row: number; raw: unknown }[] = [];
  const rowNumber = (i: number) => input.row_numbers?.[i] ?? i + 2; // header is line 1
  let rows: Record<string, string>[] = [];
  let headers: string[] = [];
  if (typeof input.data === "string") {
    const parsed = Papa.parse<Record<string, string>>(input.data.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy" });
    headers = parsed.meta.fields ?? [];
    rows = parsed.data;
    for (const e of parsed.errors) {
      messages.push({ severity: "error", code: e.code === "TooFewFields" ? "partial_row" : "csv_parse", message: e.message, row: (e.row ?? 0) + 2 });
    }
  } else {
    rows = input.data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])));
    headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  }
  const checksum = input.checksum ?? sha256(typeof input.data === "string" ? input.data : JSON.stringify(input.data));
  const rowsWithParseError = new Set(messages.filter((m) => m.code === "partial_row" || m.code === "csv_parse").map((m) => m.row));

  const mapped = new Set([...Object.values(mapping.columns), ...Object.values(mapping.variables ?? {}).map((v) => v!.column)]);
  const missingHeaders = [...mapped].filter((h) => !headers.includes(h));
  for (const h of missingHeaders) messages.push({ severity: "error", code: "missing_column", message: `Mapped column "${h}" is not in the file`, field: h });
  for (const k of REQUIRED[mapping.target]) {
    if (!mapping.columns[k]) messages.push({ severity: "error", code: "missing_mapping", message: `Required field "${k}" has no mapped column`, field: k });
  }
  if (mapping.target === "weather_observation" && !mapping.variables && !(mapping.columns.variable && mapping.columns.value && mapping.columns.unit)) {
    messages.push({ severity: "error", code: "missing_mapping", message: "Weather import needs `variables` (wide) or variable/value/unit columns (long)" });
  }
  const unknown = headers.filter((h) => !mapped.has(h));
  if (unknown.length) messages.push({ severity: "info", code: "unmapped_columns", message: `Unmapped columns preserved in raw_payload only: ${unknown.join(", ")}` });
  if (messages.some((m) => m.severity === "error" && !m.row)) {
    return finish({ adapter: CSV_ADAPTER, adapter_version: CSV_ADAPTER_VERSION, source_system: mapping.source_system, source_identifier: input.file_name, checksum, records, rejected: rows.map((raw, i) => ({ row: rowNumber(i), raw })), messages });
  }

  const seen = new Set<string>();
  const elevationUnits = new Set<string>();
  rows.forEach((raw, i) => {
    const rowNo = rowNumber(i);
    const rowMsgs: ImportMessage[] = [];
    const push = (severity: ImportMessage["severity"], code: string, message: string, field?: string) => rowMsgs.push({ severity, code, message, row: rowNo, field });
    const get = (field: string) => {
      const col = mapping.columns[field];
      return col ? String(raw[col] ?? "").trim() : "";
    };
    for (const k of REQUIRED[mapping.target]) if (!get(k)) push("error", "missing_value", `Required field "${k}" is empty`, k);

    const time = (field: string, required: boolean): { iso: string | null; flags: string[] } => {
      const v = get(field);
      if (!v) return { iso: null, flags: [] };
      if (/[zZ]|[+-]\d\d:?\d\d$/.test(v) && !Number.isNaN(Date.parse(v))) return { iso: new Date(v).toISOString(), flags: [] };
      const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?$/);
      if (!m) { push("error", "invalid_time", `Cannot parse time "${v}"`, field); return { iso: null, flags: [] }; }
      if (!m[2]) {
        if (required) push("warning", "date_only", `"${v}" has no time; stored as local noon and flagged time_estimated`, field);
        return { iso: zonedToUtc(m[1], "12:00", mapping.time_zone), flags: ["time_estimated"] };
      }
      try { return { iso: zonedToUtc(m[1], m[2], mapping.time_zone), flags: [] }; }
      catch (e) {
        if (e instanceof AmbiguousLocalTimeError) push("error", "ambiguous_time", `${e.message}; add an explicit UTC offset`, field);
        else throw e;
        return { iso: null, flags: [] };
      }
    };
    const num = (field: string): number | null => {
      const v = get(field);
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) { push("error", "invalid_number", `"${v}" is not a number`, field); return null; }
      return n;
    };
    const elevation = (): number | null => {
      const v = get("elevation_m");
      if (!v) return null;
      const m = v.match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|feet)?$/i);
      if (!m) { push("error", "invalid_number", `Cannot parse elevation "${v}"`, "elevation_m"); return null; }
      const unit = (m[2]?.toLowerCase().startsWith("f") ? "ft" : m[2] ? "m" : mapping.elevation_unit ?? "m");
      elevationUnits.add(unit);
      if (unit === "ft") { push("info", "unit_converted", `Elevation ${v} converted from feet`, "elevation_m"); return Math.round(Number(m[1]) * 0.3048); }
      return Math.round(Number(m[1]));
    };
    const vocab = <T>(field: string, parse: (x: unknown) => T | null, label: string): T | null => {
      const v = get(field);
      if (!v) return null;
      const p = parse(v);
      if (p === null) push("error", "invalid_code", `Unrecognised ${label} "${v}"`, field);
      return p;
    };

    const provenance = (recordId: string): Provenance => ({
      source_system: mapping.source_system, source_record_id: recordId, source_version: payloadHash(raw).slice(0, 12),
      import_run_id: input.import_run_id, transformation_version: `${CSV_ADAPTER}@${CSV_ADAPTER_VERSION}`,
    });
    const recordId = get("source_record_id");
    const out: ObservationRecord[] = [];

    if (mapping.target === "avalanche_event") {
      const observed = time("observed_at", true);
      const sizeMin = vocab("size_min", parseSize, "size") ?? vocab("size", parseSize, "size");
      const sizeMax = vocab("size_max", parseSize, "size") ?? vocab("size", parseSize, "size");
      if (!mapping.columns.location_confidence) push("info", "default_applied", "location_confidence not mapped; recorded as unknown", "location_confidence");
      out.push({ kind: "avalanche_event", record: {
        id: uuid(), forecast_domain_code: mapping.domain_code,
        occurred_from: time("occurred_from", false).iso, occurred_to: time("occurred_to", false).iso,
        observed_at: observed.iso ?? "", location_name: get("location_name") || null,
        latitude: num("latitude"), longitude: num("longitude"),
        location_confidence: get("location_confidence") || "unknown",
        trigger_type: get("trigger_type") || null, avalanche_type: get("avalanche_type") || null,
        problem_type: vocab("problem_type", parseProblemType, "problem type"),
        size_min: sizeMin, size_max: sizeMax, failure_layer: get("failure_layer") || null,
        aspect: vocab("aspect", parseAspect, "aspect"), elevation_m: elevation(),
        elevation_band: vocab("elevation_band", parseElevationBand, "elevation band"),
        observation_confidence: get("observation_confidence").toLowerCase(),
        raw_payload: { ...raw, _quality_flags: observed.flags }, provenance: provenance(recordId),
      } });
    } else if (mapping.target === "mitigation_action") {
      const t = time("action_time", true);
      out.push({ kind: "mitigation_action", record: {
        id: uuid(), forecast_domain_code: mapping.domain_code, action_time: t.iso ?? "",
        location_name: get("location_name") || null, method: get("method"), result_class: get("result_class"),
        result_summary: payloadFields(mapping, raw), linked_avalanche_event_ids: [],
        observation_confidence: get("observation_confidence").toLowerCase(),
        raw_payload: { ...raw, _quality_flags: t.flags }, provenance: provenance(recordId),
      } });
    } else if (mapping.target === "field_observation") {
      const t = time("observed_at", true);
      out.push({ kind: "field_observation", record: {
        id: uuid(), forecast_domain_code: mapping.domain_code, observation_type: get("observation_type"),
        observed_at: t.iso ?? "", location_name: get("location_name") || null,
        standardized_payload: payloadFields(mapping, raw), raw_payload: raw,
        quality_status: t.flags.length ? "flagged" : "unreviewed", provenance: provenance(recordId),
      } });
    } else {
      const t = time("observed_at", true);
      const station = get("station_code");
      const vars = mapping.variables
        ? Object.entries(mapping.variables).map(([variable, spec]) => ({ variable: variable as WeatherVariable, value: String(raw[spec!.column] ?? "").trim(), unit: spec!.unit }))
        : [{ variable: get("variable") as WeatherVariable, value: get("value"), unit: get("unit") }];
      for (const v of vars) {
        const n = v.value === "" ? null : Number(v.value);
        const flags = [...t.flags];
        if (v.value !== "" && !Number.isFinite(n)) { flags.push("non_numeric"); push("warning", "non_numeric", `${v.variable} "${v.value}" is not numeric; stored as missing`, v.variable); }
        const id = `${station}|${t.iso}|${v.variable}`;
        out.push({ kind: "weather_observation", record: {
          id: uuid(), station_code: station, observed_at: t.iso ?? "", variable: v.variable,
          value: Number.isFinite(n) ? n : null, unit: v.unit, quality_status: flags.length ? "flagged" : "unreviewed",
          quality_flags: flags, provenance: provenance(id),
        } });
      }
    }

    const keys = out.map((o) => `${o.kind}|${o.record.provenance.source_record_id}`);
    for (const k of keys) {
      if (seen.has(k)) push("error", "duplicate_in_file", `Duplicate source record ${k.split("|").slice(1).join("|")} in this file`, "source_record_id");
    }
    messages.push(...rowMsgs);
    if (rowMsgs.some((m) => m.severity === "error") || rowsWithParseError.has(rowNo)) rejected.push({ row: rowNo, raw });
    else { keys.forEach((k) => seen.add(k)); records.push(...out); }
  });
  if (elevationUnits.size > 1) messages.push({ severity: "warning", code: "mixed_units", message: `Elevations use mixed units (${[...elevationUnits].join(", ")}); converted to metres`, field: "elevation_m" });

  return finish({ adapter: CSV_ADAPTER, adapter_version: CSV_ADAPTER_VERSION, source_system: mapping.source_system, source_identifier: input.file_name, checksum, records, rejected, messages });
}

function payloadFields(mapping: CsvMapping, raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(mapping.columns)) if (k.startsWith("payload.")) out[k.slice(8)] = raw[col] ?? null;
  return out;
}
