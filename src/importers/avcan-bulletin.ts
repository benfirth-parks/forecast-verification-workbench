// Adapter: avalanche.ca public forecast product (GET /forecasts/{lang}/products).
//
// avalanche.ca serves the CURRENT product and updates it in place, so the only
// way to freeze a bulletin "as issued" is to snapshot it when it appears. Each
// distinct payload (by hash) becomes its own issuance version.
//
// The problem shape below (`type`, `data.elevations`, `data.aspects`,
// `data.likelihood`, `data.expectedSize`) is UNVERIFIED against an in-season
// Parks BYK payload: on 2026-10-06 the live product had `problems: []`.
// Unrecognised shapes raise warnings and the raw payload is always kept.
import type { AvalancheProblem, ForecastIssuance, HazardAssessment } from "../domain/types";
import { addDays, daysBetween, localDate, localDayBounds } from "../domain/time";
import {
  ELEVATION_BANDS, parseAspect, parseConfidence, parseElevationBand, parseLikelihoodRange, parseProblemType,
  parseRating, parseSize, type ElevationBand, type RatingCell,
} from "../domain/vocab";
import { finish, htmlToText, payloadHash, uuid, type ImportMessage, type ImportResult } from "./common";

export const AVCAN_ADAPTER = "avcan-bulletin";
export const AVCAN_ADAPTER_VERSION = "1.0.0";
export const AVCAN_SOURCE_SYSTEM = "avalanche.ca";

/**
 * How a dangerRatings[] entry maps to a local calendar day.
 * - "evening_next_day" (default): a bulletin issued at or after the cutoff hour
 *   (local) covers the next day, so day one = issue date + 1; one issued before
 *   the cutoff covers its own issue day. Parks BYK confirmed on 2026-10-06 that
 *   the 17:00 bulletin represents the next day's hazard.
 * - "payload_date": the local date of `date.value` in the bulletin zone.
 * - "issue_date_plus_index": issue date + array index.
 * - "next_day_plus_index": day after issue + array index, whatever the issue time.
 */
export type DayOneRule = "evening_next_day" | "payload_date" | "issue_date_plus_index" | "next_day_plus_index";

export interface AvcanOptions {
  domainCode: string;
  capturedAt: string;
  importRunId: string;
  dayOneRule?: DayOneRule;
  /** Local hour at or after which "evening_next_day" maps day one to the next day (default 12). */
  dayOneCutoffHour?: number;
  /** Owner value(s) to accept, e.g. ["parks-byk"]. */
  owners?: string[];
  /** Warn when a snapshot was first captured this long after issue. */
  lateCaptureHours?: number;
  createdBy?: string;
}

export interface BulletinBundle {
  issuance: ForecastIssuance;
  assessments: HazardAssessment[];
  sub_area: { id: string | null; title: string | null };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const val = (v: unknown): unknown => (v && typeof v === "object" && "value" in (v as Obj) ? (v as Obj).value : v);

export function importAvcanProducts(payload: unknown, opts: AvcanOptions): ImportResult<BulletinBundle> {
  const messages: ImportMessage[] = [];
  const records: BulletinBundle[] = [];
  const rejected: { row: number; raw: unknown }[] = [];
  const products = Array.isArray(payload) ? payload : [payload];
  const owners = opts.owners ?? ["parks-byk"];
  products.forEach((p, row) => {
    const owner = String(val(obj(p).owner) ?? "");
    if (!owners.includes(owner)) return; // other forecast centres: ignored silently by design
    const before = messages.length;
    const bundle = parseProduct(p, row, opts, messages);
    const hasError = messages.slice(before).some((m) => m.severity === "error");
    if (bundle && !hasError) records.push(bundle);
    else rejected.push({ row, raw: p });
  });
  if (!records.length && !rejected.length) {
    messages.push({ severity: "warning", code: "no_products", message: `No products owned by ${owners.join(", ")} in payload.` });
  }
  return finish({
    adapter: AVCAN_ADAPTER, adapter_version: AVCAN_ADAPTER_VERSION, source_system: AVCAN_SOURCE_SYSTEM,
    source_identifier: "api.avalanche.ca/forecasts/en/products", checksum: payloadHash(payload),
    records, rejected, messages,
  });
}

function parseProduct(p: unknown, row: number, opts: AvcanOptions, messages: ImportMessage[]): BulletinBundle | null {
  const product = obj(p);
  const report = obj(product.report);
  const err = (code: string, message: string, field?: string) => messages.push({ severity: "error", code, message, row, field });
  const warn = (code: string, message: string, field?: string) => messages.push({ severity: "warning", code, message, row, field });
  const info = (code: string, message: string, field?: string) => messages.push({ severity: "info", code, message, row, field });

  const recordId = String(report.id ?? product.id ?? "");
  const issuedAt = String(report.dateIssued ?? "");
  const validUntil = String(report.validUntil ?? "");
  const zone = String(report.timezone ?? "");
  if (!recordId) err("missing_field", "report.id is missing", "report.id");
  if (!issuedAt || Number.isNaN(Date.parse(issuedAt))) err("invalid_time", `report.dateIssued is not a timestamp: ${issuedAt}`, "report.dateIssued");
  if (!validUntil || Number.isNaN(Date.parse(validUntil))) err("invalid_time", `report.validUntil is not a timestamp: ${validUntil}`, "report.validUntil");
  if (!zone) err("missing_field", "report.timezone is missing; local days cannot be computed safely", "report.timezone");
  else {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); }
    catch { err("invalid_zone", `Unknown time zone ${zone}`, "report.timezone"); }
  }
  if (messages.some((m) => m.row === row && m.severity === "error")) return null;

  const issuedIso = new Date(issuedAt).toISOString();
  const lateH = opts.lateCaptureHours ?? 6;
  if ((Date.parse(opts.capturedAt) - Date.parse(issuedIso)) / 36e5 > lateH) {
    warn("late_capture", `Snapshot captured ${((Date.parse(opts.capturedAt) - Date.parse(issuedIso)) / 36e5).toFixed(1)} h after issue; content may have been edited after issuance.`);
  }
  const hash = payloadHash(p);
  const issuance: ForecastIssuance = {
    id: uuid(),
    forecast_domain_code: opts.domainCode,
    assessment_type: "public_bulletin",
    issued_at: issuedIso,
    valid_from: issuedIso,
    valid_to: new Date(validUntil).toISOString(),
    time_zone: zone,
    source_system: AVCAN_SOURCE_SYSTEM,
    source_record_id: recordId,
    source_version: `${String(product.version ?? "")}:${hash.slice(0, 12)}`,
    raw_payload: p,
    raw_payload_hash: hash,
    forecaster_team_code: null,
    status: "issued",
    import_run_id: opts.importRunId,
    captured_at: opts.capturedAt,
  };

  const confidence = parseConfidence(val(obj(report.confidence).rating));
  const rule = opts.dayOneRule ?? "evening_next_day";
  const issueDate = localDate(issuedIso, zone);
  const cutoff = opts.dayOneCutoffHour ?? 12;
  const issuedHour = localHour(issuedIso, zone);
  const offset = rule === "next_day_plus_index" || (rule === "evening_next_day" && issuedHour >= cutoff) ? 1 : 0;
  if (rule === "evening_next_day") {
    info("day_one_rule", offset
      ? `Issued ${String(issuedHour).padStart(2, "0")}:00 local, so day one is ${addDays(issueDate, 1)} (the evening bulletin covers the next day).`
      : `Issued before ${cutoff}:00 local, so day one is the issue day ${issueDate}.`);
    if (!offset) warn("morning_issue", "Bulletin issued before the cutoff; treated as covering its own issue day. Check whether this was an update.");
  } else info("day_one_rule", `Danger-rating days mapped with rule "${rule}".`);
  const payloadDisagrees: string[] = [];
  const problems = parseProblems(report.problems, row, messages);

  const days = arr(report.dangerRatings);
  if (!days.length) warn("no_danger_ratings", "report.dangerRatings is empty");
  const assessments: HazardAssessment[] = days.map((d, i) => {
    const day = obj(d);
    const dateValue = String(val(day.date) ?? "");
    let validDate: string;
    if (rule === "payload_date") {
      if (!dateValue || Number.isNaN(Date.parse(dateValue))) {
        err("invalid_time", `dangerRatings[${i}].date.value is not a timestamp`, `dangerRatings[${i}].date`);
        validDate = addDays(issueDate, i);
      } else validDate = localDate(dateValue, zone);
    } else {
      validDate = addDays(issueDate, i + offset);
      if (dateValue && !Number.isNaN(Date.parse(dateValue)) && localDate(dateValue, zone) !== validDate) {
        payloadDisagrees.push(`day ${i + 1}: ${validDate} (payload says ${localDate(dateValue, zone)}${day.date && obj(day.date).display ? `, "${String(obj(day.date).display)}"` : ""})`);
      }
    }
    const ratings: Partial<Record<ElevationBand, RatingCell>> = {};
    const r = obj(day.ratings);
    for (const key of Object.keys(r)) {
      const band = parseElevationBand(key);
      if (!band) { warn("unknown_band", `Unknown elevation band "${key}" kept in raw payload only`, `dangerRatings[${i}].ratings.${key}`); continue; }
      const raw = val(obj(r[key]).rating);
      const cell = parseRating(raw);
      if (!cell) err("invalid_code", `Unrecognised danger rating "${String(raw)}"`, `dangerRatings[${i}].ratings.${key}`);
      else ratings[band] = cell;
    }
    for (const b of ELEVATION_BANDS) if (!ratings[b]) warn("missing_band", `No ${b} rating for day ${i + 1}`, `dangerRatings[${i}].ratings`);
    const bounds = localDayBounds(validDate, zone);
    return {
      id: uuid(),
      forecast_issuance_id: issuance.id,
      forecast_domain_code: opts.domainCode,
      assessment_kind: "forecast",
      assessment_time: issuedIso,
      valid_from: bounds.start,
      valid_to: bounds.end,
      valid_date: validDate,
      forecast_horizon_days: daysBetween(issueDate, validDate),
      ratings,
      // avalanche.ca problems are not split by day; attach them to the first rated day only.
      problems: i === 0 ? problems : [],
      confidence,
      rationale: htmlToText(report.highlights) || null,
      status: "final",
      version: 1,
      created_by: opts.createdBy ?? "import",
      created_at: opts.capturedAt,
      supersedes_id: null,
      label: null,
    };
  });
  if (payloadDisagrees.length) {
    warn("payload_date_mismatch", `The payload's own day labels differ from the rule used: ${payloadDisagrees.join("; ")}. The rule was applied; the payload is kept unchanged.`, "report.dangerRatings");
  }
  if (problems.length && days.length) info("problems_day_one", "Bulletin problems attached to the first rated day only.");
  return { issuance, assessments, sub_area: { id: String(obj(product.area).id ?? "") || null, title: String(report.title ?? "") || null } };
}

function localHour(isoUtc: string, zone: string): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date(isoUtc)));
}

function parseProblems(raw: unknown, row: number, messages: ImportMessage[]): AvalancheProblem[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    messages.push({ severity: "warning", code: "unexpected_shape", message: "report.problems is not an array; ignored", row, field: "report.problems" });
    return [];
  }
  const out: AvalancheProblem[] = [];
  raw.forEach((pr, i) => {
    const p = obj(pr);
    const data = obj(p.data);
    const f = `report.problems[${i}]`;
    const typeRaw = val(p.type);
    const type = parseProblemType(typeRaw);
    if (!type) {
      messages.push({ severity: "error", code: "invalid_code", message: `Unrecognised problem type "${String(typeRaw)}"`, row, field: `${f}.type` });
      return;
    }
    if (!Object.keys(data).length) {
      messages.push({ severity: "warning", code: "unexpected_shape", message: `${f} has no "data" object; spatial, likelihood and size not imported`, row, field: f });
    }
    const bands = arr(data.elevations).map((e) => parseElevationBand(val(e)));
    const aspects = arr(data.aspects).map((a) => parseAspect(val(a)));
    if (bands.includes(null)) messages.push({ severity: "warning", code: "invalid_code", message: `Unknown elevation in ${f}`, row, field: `${f}.data.elevations` });
    if (aspects.includes(null)) messages.push({ severity: "warning", code: "invalid_code", message: `Unknown aspect in ${f}`, row, field: `${f}.data.aspects` });
    const likeRaw = val(data.likelihood);
    const like = likeRaw === undefined || likeRaw === null ? null : parseLikelihoodRange(likeRaw);
    if (likeRaw !== undefined && likeRaw !== null && !like) {
      messages.push({ severity: "warning", code: "invalid_code", message: `Unrecognised likelihood "${String(likeRaw)}"`, row, field: `${f}.data.likelihood` });
    }
    const size = obj(data.expectedSize);
    const sMin = size.min === undefined ? null : parseSize(size.min);
    const sMax = size.max === undefined ? null : parseSize(size.max);
    if ((size.min !== undefined && sMin === null) || (size.max !== undefined && sMax === null)) {
      messages.push({ severity: "warning", code: "invalid_code", message: `Unrecognised expected size ${JSON.stringify(size)}`, row, field: `${f}.data.expectedSize` });
    }
    out.push({
      problem_type: type, rank: i + 1,
      elevation_bands: bands.filter((b): b is ElevationBand => b !== null),
      aspects: aspects.filter((a): a is NonNullable<typeof a> => a !== null),
      cells: null, minimum_elevation_m: null, maximum_elevation_m: null,
      likelihood_min: like?.min ?? null, likelihood_max: like?.max ?? null,
      sensitivity: null, distribution: null,
      expected_size_min: sMin, expected_size_max: sMax,
      trend: null, confidence: null, comments: htmlToText(p.comment) || null,
    });
  });
  return out;
}
