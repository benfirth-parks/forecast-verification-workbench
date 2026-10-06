// Versioned API router (/api/v1/*). Pure Request → Response so it runs in a
// Netlify Function, the local dev server, and integration tests alike.
import { ZodError, type ZodTypeAny, type z } from "zod";
import type { HazardAssessment } from "../domain/types";
import { importAvcanProducts } from "../importers/avcan-bulletin";
import { importAvyfxFeed } from "../importers/avyfx-feed";
import { importObservations, type CsvMapping } from "../importers/csv-observations";
import { readXlsx, XLSX_ADAPTER, XLSX_ADAPTER_VERSION } from "../importers/xlsx";
import type { ImportResult } from "../importers/common";
import { sha256 } from "../importers/common";
import { canonicalJson } from "../scoring/common";
import { DEFAULT_SCORING_CONFIG, scoreCase, scoreRows, type ScoringConfig } from "../scoring/case";
import { classifyEvidence } from "../scoring/evidence";
import { summarizeSeason, type ScoredCase } from "../scoring/misses";
import { dayChanges, summarizeTransitions } from "../scoring/stages";
import { summarizeWeather, type WeatherPair } from "../scoring/weather";
import type { WeatherVariable } from "../domain/types";
import { AuthError, requireRole, type Authenticator } from "./auth";
import type { Db } from "./db";
import * as repo from "./repo";
import * as S from "./schemas";

export interface ApiDeps {
  db: Db;
  authenticate: Authenticator;
  scoring?: ScoringConfig;
  now?: () => Date;
  commit?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

class BadRequest extends Error {}

async function parse<T extends ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try { body = await req.json(); } catch { throw new ZodError([{ code: "custom", path: [], message: "Body must be JSON" }]); }
  return schema.parse(body);
}

type Handler = (ctx: { req: Request; actor: repo.Actor; params: string[]; url: URL; deps: ApiDeps }) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp("^" + pattern.replace(/:id/g, "([0-9a-f-]{36})") + "$"), h]);

export async function handle(req: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/v1/, "").replace(/\/$/, "") || "/";
  try {
    const actor = await deps.authenticate(req);
    for (const [method, re, h] of routes) {
      const m = path.match(re);
      if (m && req.method === method) return await h({ req, actor, params: m.slice(1), url, deps });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof ZodError) return json({ error: "Invalid request", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof repo.NotFoundError) return json({ error: e.message }, 404);
    if (e instanceof repo.ConflictError) return json({ error: e.message }, 409);
    // Never echo payloads or stack traces; log only the message.
    console.error("api error:", e instanceof Error ? e.message : "unknown");
    return json({ error: "Server error" }, 500);
  }
}

// ---------- session ----------

route("GET", "/me", async ({ actor }) => json({ id: actor.id, role: actor.role }));

// ---------- cases ----------

route("GET", "/cases", async ({ actor, url, deps }) => {
  requireRole(actor, "viewer");
  const q = url.searchParams;
  const cases = await repo.listCases(deps.db, {
    from: q.get("from") ?? undefined, to: q.get("to") ?? undefined, status: q.get("status") ?? undefined,
    evidence: q.get("evidence") ?? undefined, type: q.get("type") ?? undefined,
  });
  const problem = q.get("problem");
  return json({ cases: problem ? cases.filter((c) => c.forecast?.problems.some((p) => p.problem_type === problem)) : cases });
});

route("GET", "/cases/:id", async ({ actor, params, deps }) => {
  requireRole(actor, "viewer");
  const d = await repo.caseDetail(deps.db, params[0]);
  const config = deps.scoring ?? DEFAULT_SCORING_CONFIG;
  const [day = null] = await repo.loadDayStages(deps.db, { from: d.case.valid_date, to: d.case.valid_date, domainCode: d.case.forecast_domain_code, hindsightCaseId: d.case.id });
  const latestHindsight = d.hindsight.filter((h) => h.status !== "superseded").at(-1) ?? null;
  // Differences unlock only after an independent hindsight has been saved.
  const comparison = latestHindsight && d.forecast
    ? scoreCase(d.case, d.forecast, latestHindsight, config)
    : null;
  const { raw_payload, ...issuance } = d.issuance as Record<string, unknown>;
  const rawVisible = repoCanSeeRaw(actor.role);
  // Viewers see evidence without raw source payloads or exact geometry.
  const redact = (rows: Record<string, unknown>[]) => rawVisible ? rows : rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "raw_payload" && k !== "geometry_geojson")));
  const evidence = { ...d.evidence, avalanches: redact(d.evidence.avalanches), mitigation: redact(d.evidence.mitigation), field: redact(d.evidence.field) };
  const stages = day ? { ...day, changes: dayChanges(day.stages, config.synonyms) } : null;
  return json({ ...d, evidence, stages, issuance: { ...issuance, raw_payload: rawVisible ? raw_payload : undefined }, comparison, comparison_basis: latestHindsight ? { assessment_id: latestHindsight.id, status: latestHindsight.status, version: latestHindsight.version } : null });
});
const repoCanSeeRaw = (role: string) => role === "analyst" || role === "reviewer" || role === "administrator";

route("POST", "/cases/:id/assign", async ({ req, actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const body = (await req.json().catch(() => ({}))) as { reviewer?: string | null };
  await deps.db.tx((db) => repo.assignCase(db, params[0], body.reviewer ?? actor.id, actor));
  return json({ ok: true });
});

route("POST", "/cases/:id/reopen", async ({ req, actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  if (!body.reason || body.reason.length < 5) return json({ error: "A reason is required to reopen a case" }, 400);
  await deps.db.tx((db) => repo.setReviewStatus(db, params[0], "reopened", actor, body.reason));
  return json({ ok: true });
});

route("POST", "/cases/:id/finalize", async ({ actor, params, deps }) => {
  requireRole(actor, "reviewer");
  await deps.db.tx(async (db) => {
    const c = await repo.getCase(db, params[0]);
    if (!c.outcome_evidence_class) throw new repo.ConflictError("Classify the evidence before finalizing the case");
    const d = await repo.caseDetail(db, params[0]);
    if (!d.hindsight.some((h) => h.status === "final")) throw new repo.ConflictError("Finalize the hindsight assessment first");
    await repo.setReviewStatus(db, params[0], "final", actor);
  });
  return json({ ok: true });
});

// ---------- hindsight ----------

route("POST", "/cases/:id/hindsight", async ({ req, actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const body = await parse(req, S.assessmentBody);
  return json(await deps.db.tx((db) => repo.saveHindsightDraft(db, params[0], body as Pick<HazardAssessment, "ratings" | "problems" | "confidence" | "rationale">, actor)));
});

route("POST", "/cases/:id/hindsight/finalize", async ({ actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const config = deps.scoring ?? DEFAULT_SCORING_CONFIG;
  return json(await deps.db.tx(async (db) => {
    const out = await repo.finalizeHindsight(db, params[0], actor);
    const d = await repo.caseDetail(db, params[0]);
    const h = d.hindsight.find((x) => x.id === out.assessmentId)!;
    const score = scoreCase(d.case, d.forecast, h, config);
    const versionId = await repo.ensureScoringVersion(db, config.name, config, actor);
    const inputHash = sha256(canonicalJson({ forecast: d.forecast, hindsight: h, evidence: d.case.outcome_evidence_class }));
    await repo.storeScores(db, params[0], versionId, inputHash, scoreRows(score));
    return { ...out, scoring_version_id: versionId };
  }));
});

route("GET", "/cases/:id/hindsight/history", async ({ actor, params, deps }) => {
  requireRole(actor, "viewer");
  const d = await repo.caseDetail(deps.db, params[0]);
  return json({ versions: d.hindsight });
});

// ---------- evidence ----------

route("POST", "/cases/:id/coverage", async ({ req, actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const body = await parse(req, S.coverageBody);
  return json({ id: await deps.db.tx((db) => repo.addCoverage(db, params[0], body, actor)) });
});

route("POST", "/cases/:id/evidence", async ({ req, actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const body = await parse(req, S.evidenceBody);
  const rule = (deps.scoring ?? DEFAULT_SCORING_CONFIG).evidence_rule;
  return json(await deps.db.tx(async (db) => {
    const d = await repo.caseDetail(db, params[0]);
    const auto = classifyEvidence({
      avalanches: d.evidence.avalanches as never, mitigation: d.evidence.mitigation as never,
      coverage: d.evidence.coverage as never, conflicts: body.conflicts, notApplicable: body.not_applicable,
    }, rule);
    const result = body.override
      ? { evidence_class: body.override.evidence_class, rationale: `Reviewer override of "${auto.evidence_class}": ${body.override.rationale}`, rule_id: `${rule.id}+override` }
      : auto;
    await repo.setEvidence(db, params[0], result, actor);
    return { ...result, automatic: auto };
  }));
});

// ---------- adjudication ----------

route("POST", "/cases/:id/adjudications", async ({ req, actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const body = await parse(req, S.adjudicationBody);
  const d = await repo.caseDetail(deps.db, params[0]);
  if (!d.hindsight.length) return json({ error: "Enter the independent hindsight assessment before adjudicating" }, 409);
  return json({ id: await deps.db.tx((db) => repo.saveAdjudication(db, params[0], body, actor)) });
});

route("POST", "/cases/:id/adjudications/finalize", async ({ req, actor, params, deps }) => {
  requireRole(actor, "reviewer");
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  if (!body.id) return json({ error: "id is required" }, 400);
  await deps.db.tx((db) => repo.finalizeAdjudication(db, params[0], body.id!, actor));
  return json({ ok: true });
});

route("GET", "/cases/:id/adjudications/history", async ({ actor, params, deps }) => {
  requireRole(actor, "viewer");
  return json({ adjudications: (await repo.caseDetail(deps.db, params[0])).adjudications });
});

// ---------- morning meeting ----------

route("POST", "/morning", async ({ req, actor, deps }) => {
  requireRole(actor, "reviewer");
  const body = await parse(req, S.morningBody);
  return json(await deps.db.tx((db) => repo.createMorningAssessment(db, body as repo.MorningInput, actor)));
});

route("POST", "/nowcast", async ({ req, actor, deps }) => {
  requireRole(actor, "reviewer");
  const body = await parse(req, S.nowcastBody);
  return json(await deps.db.tx((db) => repo.createNowcast(db, body as Omit<repo.MorningInput, "weather">, actor)));
});

// ---------- imports ----------

/** Base64 length of a ~6 MB file: Netlify Functions reject larger request bodies. */
const MAX_XLSX_BASE64 = 8_000_000;
const OBSERVATION_ADAPTERS = new Set(["csv-observations", "xlsx-observations"]);

async function runImporter(body: z.infer<typeof S.importBody>, runId: string, now: Date): Promise<ImportResult<unknown>> {
  const capturedAt = body.captured_at ?? now.toISOString();
  if (body.adapter === "avcan-bulletin") return importAvcanProducts(body.payload, { domainCode: "BYK", capturedAt, importRunId: runId });
  if (body.adapter === "avyfx-feed") return importAvyfxFeed(body.payload, { domainCode: "BYK", capturedAt, importRunId: runId });
  if (body.adapter === "xlsx-observations") {
    if (typeof body.payload !== "string") throw new BadRequest("Spreadsheet payload must be the file as base64 text");
    if (body.payload.length > MAX_XLSX_BASE64) throw new BadRequest("Spreadsheet is larger than about 6 MB; export a shorter date range");
    const bytes = Buffer.from(body.payload, "base64");
    const sheet = await readXlsx(bytes, { sheet: body.sheet });
    const result = importObservations({
      data: sheet.rows, row_numbers: sheet.row_numbers, file_name: body.sheet ? `${body.file_name} [${sheet.sheet}]` : body.file_name,
      import_run_id: runId, checksum: sha256(bytes), messages: sheet.messages,
    }, body.mapping as CsvMapping);
    return { ...result, adapter: XLSX_ADAPTER, adapter_version: XLSX_ADAPTER_VERSION };
  }
  return importObservations({ data: body.payload as string, file_name: body.file_name, import_run_id: runId }, body.mapping as CsvMapping);
}

route("POST", "/imports/validate", async ({ req, actor, deps }) => {
  requireRole(actor, "administrator");
  const body = await parse(req, S.importBody);
  const result = await runImporter(body, "dry-run", (deps.now ?? (() => new Date()))());
  const id = await deps.db.tx(async (db) => {
    await repo.ensureDomain(db);
    const runId = await repo.recordImportRun(db, result, actor, { dryRun: true, mapping: body.mapping, fileName: body.file_name });
    await repo.audit(db, actor, "import.validate", "import_run", runId, { adapter: body.adapter, checksum: result.checksum, summary: result.summary });
    return runId;
  });
  const prior = await deps.db.query("select id from import_runs where checksum=$1 and dry_run=false and status='committed'", [result.checksum]);
  return json({
    import_run_id: id, checksum: result.checksum, summary: result.summary, messages: result.messages,
    already_committed: prior.rows.length > 0, preview: result.records.slice(0, 20), rejected: result.rejected.slice(0, 20),
  });
});

route("POST", "/imports/commit", async ({ req, actor, deps }) => {
  requireRole(actor, "administrator");
  const body = await parse(req, S.importBody);
  return json(await deps.db.tx(async (db) => {
    await repo.ensureDomain(db);
    const placeholder = await runImporter(body, "pending", (deps.now ?? (() => new Date()))());
    if (body.expected_checksum && body.expected_checksum !== placeholder.checksum) throw new repo.ConflictError("Payload changed since validation; validate again");
    if (placeholder.summary.errors > 0 && placeholder.records.length === 0) throw new repo.ConflictError("Nothing importable: every record has errors");
    const runId = await repo.recordImportRun(db, placeholder, actor, { dryRun: false, mapping: body.mapping, fileName: body.file_name });
    // Re-run with the real run id so every record carries its provenance.
    const result = await runImporter(body, runId, (deps.now ?? (() => new Date()))());
    const summary = OBSERVATION_ADAPTERS.has(body.adapter)
      ? await repo.commitObservations(db, result as never, runId)
      : await repo.commitBulletins(db, result as never, actor, runId);
    await repo.audit(db, actor, "import.commit", "import_run", runId, { adapter: body.adapter, checksum: result.checksum, ...summary });
    return { ...summary, messages: result.messages, summary_counts: result.summary };
  }));
});

route("GET", "/imports", async ({ actor, deps }) => {
  requireRole(actor, "analyst");
  return json({ runs: (await deps.db.query("select * from import_runs order by started_at desc limit 200")).rows });
});

route("GET", "/imports/:id", async ({ actor, params, deps }) => {
  requireRole(actor, "analyst");
  const run = (await deps.db.query("select * from import_runs where id=$1", [params[0]])).rows[0];
  if (!run) return json({ error: "Not found" }, 404);
  return json({ run });
});

route("GET", "/imports/:id/errors", async ({ actor, params, deps }) => {
  requireRole(actor, "analyst");
  return json({ errors: (await deps.db.query("select severity, code, message, row_number, field from import_errors where import_run_id=$1 order by row_number nulls first", [params[0]])).rows });
});

route("POST", "/imports/:id/supersede", async ({ req, actor, params, deps }) => {
  requireRole(actor, "administrator");
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  if (!body.reason || body.reason.length < 5) return json({ error: "A reason is required" }, 400);
  await deps.db.tx((db) => repo.supersedeImportRun(db, params[0], body.reason!, actor));
  return json({ ok: true });
});

// ---------- analytics ----------

route("GET", "/analytics/summary", async ({ actor, url, deps }) => {
  requireRole(actor, "viewer");
  const config = deps.scoring ?? DEFAULT_SCORING_CONFIG;
  const from = url.searchParams.get("from") ?? undefined, to = url.searchParams.get("to") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const cases = await repo.listCases(deps.db, { from, to, type });
  const scored: ScoredCase[] = [];
  const weatherPairs: WeatherPair[] = [];
  for (const c of cases) {
    const d = await repo.caseDetail(deps.db, c.id);
    const final = d.hindsight.filter((h) => h.status === "final").at(-1) ?? null;
    const score = final
      ? scoreCase(d.case, d.forecast, final, config)
      : { ...scoreCase(d.case, d.forecast, { ...d.forecast, problems: [], ratings: {} }, config), caseExclusion: d.hindsight.length ? "hindsight not finalized" : "no hindsight assessment" };
    scored.push({ caseId: c.id, validDate: c.valid_date, score, adjudications: d.adjudications as never });
    for (const e of d.evidence.weatherExp as { location_reference: string; variable: WeatherVariable; expected_min: string | null; expected_max: string | null; expected_value: string | null }[]) {
      const obs = (d.evidence.weatherObs as { station_code: string; variable: string; value: string | null }[])
        .filter((o) => o.station_code === e.location_reference && o.variable === e.variable).at(-1);
      const n = (v: string | null) => (v === null ? null : Number(v));
      weatherPairs.push({ variable: e.variable, expected: { expected_min: n(e.expected_min), expected_max: n(e.expected_max), expected_value: n(e.expected_value) }, observed: obs ? n(obs.value) : null });
    }
  }
  const season = summarizeSeason(scored, config);
  const stages = summarizeTransitions(await repo.loadDayStages(deps.db, { from, to }), config.synonyms);
  const weather = (["hn24", "hw24", "wind_speed_max", "air_temp_max", "freezing_level", "precip_24"] as WeatherVariable[])
    .map((v) => summarizeWeather(weatherPairs, v, v === "hn24" ? 20 : undefined))
    .filter((w) => w.pairs + w.excludedMissingObservation > 0);
  return json({
    scoring_version: config.name, filters: { from, to, type }, generated_at: new Date().toISOString(),
    exclusion_rule: "Cases count only with a finalized hindsight and evidence class observed_positive or supported_negative.",
    season, weather, stages,
    stage_rule: "Changes between the team's own calls for the same day. Toward/away counts use only days with a finalized hindsight review.",
    evidence: Object.fromEntries(["observed_positive", "supported_negative", "unknown_due_to_coverage", "conflicting_evidence", "not_applicable", "unclassified"]
      .map((k) => [k, cases.filter((c) => (c.outcome_evidence_class ?? "unclassified") === k).length])),
  });
});

route("GET", "/audit", async ({ actor, url, deps }) => {
  requireRole(actor, "analyst");
  const id = url.searchParams.get("entity_id");
  const rows = id
    ? (await deps.db.query("select * from audit_events where entity_id=$1 order by at desc limit 500", [id])).rows
    : (await deps.db.query("select * from audit_events order by at desc limit 200")).rows;
  return json({ events: rows });
});
