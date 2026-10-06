// Adapter: Parks Avy FX public feed (/.netlify/functions/feed?format=json).
// Each Live forecast carries three forecast days and nowcast problems
// (problems with day "nowcast"). Nowcast problems become a separate
// `nowcast` assessment for the issue date. The feed lists only unexpired
// Live forecasts, so like the avalanche.ca product it must be snapshotted.
import type { AvalancheProblem, ForecastIssuance, HazardAssessment } from "../domain/types";
import { daysBetween, localDate, localDayBounds } from "../domain/time";
import {
  ASPECTS, parseConfidence, parseDistribution, parseElevationBand, parseProblemType, parseRating, parseSensitivity,
  parseSize, type Aspect, type ElevationBand, type RatingCell,
} from "../domain/vocab";
import { finish, htmlToText, payloadHash, uuid, type ImportMessage, type ImportResult } from "./common";
import type { BulletinBundle } from "./avcan-bulletin";

export const AVYFX_ADAPTER = "avyfx-feed";
export const AVYFX_ADAPTER_VERSION = "1.0.0";
export const AVYFX_SOURCE_SYSTEM = "parks-avy-fx";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface AvyfxOptions {
  domainCode: string;
  capturedAt: string;
  importRunId: string;
  zone?: string;
}

export function importAvyfxFeed(payload: unknown, opts: AvyfxOptions): ImportResult<BulletinBundle> {
  const messages: ImportMessage[] = [];
  const records: BulletinBundle[] = [];
  const rejected: { row: number; raw: unknown }[] = [];
  const zone = opts.zone ?? "America/Edmonton";
  arr(obj(payload).forecasts).forEach((raw, row) => {
    const f = obj(raw);
    const before = messages.length;
    const err = (code: string, message: string, field?: string) => messages.push({ severity: "error", code, message, row, field });
    const warn = (code: string, message: string, field?: string) => messages.push({ severity: "warning", code, message, row, field });
    const id = String(f.id ?? "");
    const issued = String(f.issued ?? "");
    const validUntil = String(f.validUntil ?? "");
    if (!id) err("missing_field", "forecast id missing", "id");
    if (Number.isNaN(Date.parse(issued))) err("invalid_time", "issued is not a timestamp", "issued");
    if (Number.isNaN(Date.parse(validUntil))) err("invalid_time", "validUntil is not a timestamp", "validUntil");
    if (messages.slice(before).some((m) => m.severity === "error")) { rejected.push({ row, raw }); return; }
    const issuedIso = new Date(issued).toISOString();
    const issueDate = localDate(issuedIso, zone);
    const hash = payloadHash(raw);
    const issuance: ForecastIssuance = {
      id: uuid(), forecast_domain_code: opts.domainCode, assessment_type: "operational_forecast",
      issued_at: issuedIso, valid_from: issuedIso, valid_to: new Date(validUntil).toISOString(), time_zone: zone,
      source_system: AVYFX_SOURCE_SYSTEM, source_record_id: id, source_version: `${String(f.published ?? "")}:${hash.slice(0, 12)}`,
      raw_payload: raw, raw_payload_hash: hash, forecaster_team_code: null, status: "issued",
      import_run_id: opts.importRunId, captured_at: opts.capturedAt,
    };
    const confidence = parseConfidence(obj(f.confidence).rating);
    const allProblems = arr(f.problems).map((p, i) => ({ day: String(obj(p).day ?? ""), problem: parseProblem(obj(p), i, row, messages) }));
    const mk = (kind: "forecast" | "nowcast", validDate: string, ratings: Partial<Record<ElevationBand, RatingCell>>, problems: AvalancheProblem[]): HazardAssessment => {
      const b = localDayBounds(validDate, zone);
      return {
        id: uuid(), forecast_issuance_id: issuance.id, forecast_domain_code: opts.domainCode, assessment_kind: kind,
        assessment_time: issuedIso, valid_from: b.start, valid_to: b.end, valid_date: validDate,
        forecast_horizon_days: daysBetween(issueDate, validDate), ratings, problems, confidence,
        rationale: htmlToText(obj(f.headline).text ?? obj(f.headline).html) || null, status: "final", version: 1,
        created_by: "import", created_at: opts.capturedAt, supersedes_id: null, label: null,
      };
    };
    const assessments: HazardAssessment[] = arr(f.days).map((d, i) => {
      const day = obj(d);
      const date = String(day.date ?? "");
      const danger = obj(day.danger);
      const ratings: Partial<Record<ElevationBand, RatingCell>> = {};
      for (const [key, band] of [["alpine", "alp"], ["treeline", "tln"], ["belowTreeline", "btl"]] as const) {
        const cell = parseRating(danger[key]);
        if (!cell) err("invalid_code", `Unrecognised danger rating "${String(danger[key])}"`, `days[${i}].danger.${key}`);
        else ratings[band] = cell;
      }
      return mk("forecast", date, ratings, allProblems.filter((p) => p.day === date && p.problem).map((p) => p.problem!));
    });
    const nowcast = allProblems.filter((p) => p.day === "nowcast" && p.problem).map((p) => p.problem!);
    if (nowcast.length) assessments.push(mk("nowcast", issueDate, {}, nowcast));
    if (!arr(f.days).length) warn("no_days", "Forecast has no visible forecast days");
    if (messages.slice(before).some((m) => m.severity === "error")) { rejected.push({ row, raw }); return; }
    const areas = arr(f.areas).map((a) => String(obj(a).name ?? "")).filter(Boolean);
    records.push({ issuance, assessments, sub_area: { id: areas.join("|") || null, title: String(f.name ?? "") || null } });
  });
  return finish({
    adapter: AVYFX_ADAPTER, adapter_version: AVYFX_ADAPTER_VERSION, source_system: AVYFX_SOURCE_SYSTEM,
    source_identifier: "parks-avy-fx feed?format=json", checksum: payloadHash(payload), records, rejected, messages,
  });
}

function parseProblem(p: Obj, i: number, row: number, messages: ImportMessage[]): AvalancheProblem | null {
  const field = `problems[${i}]`;
  const type = parseProblemType(p.type);
  if (!type) {
    messages.push({ severity: "error", code: "invalid_code", message: `Unrecognised problem type "${String(p.type)}"`, row, field: `${field}.type` });
    return null;
  }
  const cells: string[] = [];
  for (const c of arr(p.aspectsElevations)) {
    const [a, r] = String(c).split(":");
    const band = parseElevationBand(r);
    if (!(ASPECTS as readonly string[]).includes(a) || !band) {
      messages.push({ severity: "warning", code: "invalid_code", message: `Unknown aspect/elevation cell "${String(c)}"`, row, field: `${field}.aspectsElevations` });
      continue;
    }
    cells.push(`${a}:${band}`);
  }
  const size = p.size === null || p.size === undefined || p.size === "" ? null : parseSize(p.size);
  if (p.size && size === null) messages.push({ severity: "warning", code: "invalid_code", message: `Unrecognised size "${String(p.size)}"`, row, field: `${field}.size` });
  const sensitivity = p.sensitivity ? parseSensitivity(p.sensitivity) : null;
  if (p.sensitivity && !sensitivity) messages.push({ severity: "warning", code: "invalid_code", message: `Unrecognised sensitivity "${String(p.sensitivity)}"`, row, field: `${field}.sensitivity` });
  const distribution = p.distribution ? parseDistribution(p.distribution) : null;
  if (p.distribution && !distribution) messages.push({ severity: "warning", code: "invalid_code", message: `Unrecognised distribution "${String(p.distribution)}"`, row, field: `${field}.distribution` });
  return {
    problem_type: type, rank: i + 1,
    elevation_bands: [...new Set(cells.map((c) => c.split(":")[1] as ElevationBand))],
    aspects: [...new Set(cells.map((c) => c.split(":")[0] as Aspect))],
    cells, minimum_elevation_m: null, maximum_elevation_m: null,
    likelihood_min: null, likelihood_max: null, sensitivity, distribution,
    // Avy FX records one "typical size"; it is stored as both min and max.
    expected_size_min: size, expected_size_max: size,
    trend: null, confidence: null, comments: String(p.description ?? "") || null,
  };
}
