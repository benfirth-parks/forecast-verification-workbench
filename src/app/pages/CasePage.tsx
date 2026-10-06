import { useCallback, useEffect, useState } from "react";
import type { HazardAssessment, VerificationCase } from "../../domain/types";
import { formatLocal } from "../../domain/time";
import {
  COVERAGE_CLASSES, DISCREPANCY_CATEGORIES, DISCREPANCY_LABEL, ELEVATION_BAND_LABEL, EVIDENCE_LABEL,
  PROBLEM_LABEL, type Role,
} from "../../domain/vocab";
import type { CaseScore } from "../../scoring/case";
import { api } from "../api";
import { AssessmentEditor, BANDS_TOP_DOWN, emptyDraft, ErrorText, ProblemSummary, Rate, RatingBadge, RatingsTable, type AssessmentDraft } from "../components/assessment";

type Row = Record<string, unknown>;
interface Detail {
  case: VerificationCase;
  issuance: Row & { issued_at: string; valid_from: string; valid_to: string; time_zone: string; source_system: string; source_record_id: string; source_version: string; raw_payload_hash: string; import_run_id: string; captured_at: string; assessment_type: string; sub_area_title: string | null; status: string };
  amendments: { id: string; captured_at: string; source_version: string }[];
  forecast: HazardAssessment;
  hindsight: HazardAssessment[];
  nowcasts: HazardAssessment[];
  evidence: { avalanches: Row[]; mitigation: Row[]; field: Row[]; weatherObs: Row[]; weatherExp: Row[]; coverage: Row[] };
  adjudications: Row[];
  history: Row[];
  comparison: CaseScore | null;
  comparison_basis: { assessment_id: string; status: string; version: number } | null;
}

const ZONE = "America/Edmonton";
const COVERAGE_LABEL = { coverage_class: "Overall coverage", visibility_class: "Visibility", patrol_coverage_class: "Patrol coverage", mitigation_sampling_class: "Mitigation sampling" } as const;
const t = (v: unknown) => (v ? formatLocal(String(v), ZONE) : "—");

export function CasePage({ id, role }: { id: string; role: Role }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<Detail>(`/cases/${id}`).then(setD).catch(setError), [id]);
  useEffect(() => { load(); }, [load]);
  const canReview = role === "reviewer" || role === "administrator";
  if (error && !d) return <ErrorText error={error} />;
  if (!d) return <p>Loading…</p>;
  const c = d.case;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">Case {c.valid_date} · {d.issuance.assessment_type.replace(/_/g, " ")}</h1>
        <span className="text-sm">Review: <strong>{c.review_status.replace("_", " ")}</strong></span>
        <span className="text-sm">Evidence: <strong>{c.outcome_evidence_class ? EVIDENCE_LABEL[c.outcome_evidence_class] : "not classified"}</strong></span>
        <button className="btn no-print ml-auto" onClick={() => window.print()}>Print summary</button>
      </div>
      <ErrorText error={error} />
      <div className="grid gap-3 lg:grid-cols-3">
        <ForecastColumn d={d} />
        <EvidenceColumn d={d} canReview={canReview} onChange={load} onError={setError} />
        <ReviewColumn d={d} canReview={canReview} onChange={load} onError={setError} />
      </div>
      <details className="card mt-3"><summary className="cursor-pointer text-sm font-semibold">Audit history ({d.history.length})</summary>
        <table className="table mt-2"><tbody>{d.history.map((h, i) => <tr key={i}><td className="whitespace-nowrap">{t(h.at)}</td><td>{String(h.action)}</td><td className="text-xs">{String(h.actor ?? "system").slice(0, 8)}</td><td className="text-xs">{JSON.stringify(h.details)}</td></tr>)}</tbody></table>
      </details>
    </section>
  );
}

function ForecastColumn({ d }: { d: Detail }) {
  const i = d.issuance;
  return (
    <div className="space-y-3">
      <div className="card">
        <h2 className="h2">Original forecast <span className="text-xs font-normal text-slate-600">(frozen as issued)</span></h2>
        <dl className="mb-2 grid grid-cols-[auto,1fr] gap-x-2 text-xs">
          <dt className="text-slate-600">Issued</dt><dd>{t(i.issued_at)}</dd>
          <dt className="text-slate-600">Valid day</dt><dd>{d.case.valid_date} ({t(d.case.period_start)} → {t(d.case.period_end)})</dd>
          <dt className="text-slate-600">Product valid</dt><dd>{t(i.valid_from)} → {t(i.valid_to)}</dd>
          {i.sub_area_title && <><dt className="text-slate-600">Area</dt><dd>{i.sub_area_title}</dd></>}
          <dt className="text-slate-600">Captured</dt><dd>{t(i.captured_at)}</dd>
          <dt className="text-slate-600">Horizon</dt><dd>{d.forecast.forecast_horizon_days ?? "—"} day(s)</dd>
          <dt className="text-slate-600">Confidence</dt><dd>{d.forecast.confidence ?? "—"}</dd>
        </dl>
        <RatingsTable ratings={d.forecast.ratings} />
        <h3 className="label mt-2">Problems</h3>
        {d.forecast.problems.length ? d.forecast.problems.map((p, k) => <ProblemSummary key={k} p={p} />) : <p className="text-sm text-slate-600">None listed</p>}
        {d.forecast.rationale && <><h3 className="label mt-2">Highlights / rationale</h3><p className="whitespace-pre-line text-sm">{d.forecast.rationale}</p></>}
      </div>
      <div className="card text-xs">
        <h2 className="h2">Source and version</h2>
        <dl className="grid grid-cols-[auto,1fr] gap-x-2 break-all">
          <dt className="text-slate-600">System</dt><dd>{i.source_system}</dd>
          <dt className="text-slate-600">Record</dt><dd>{i.source_record_id}</dd>
          <dt className="text-slate-600">Version</dt><dd>{i.source_version}</dd>
          <dt className="text-slate-600">Payload hash</dt><dd>{i.raw_payload_hash}</dd>
          <dt className="text-slate-600">Import run</dt><dd>{i.import_run_id}</dd>
          <dt className="text-slate-600">Status</dt><dd>{i.status}</dd>
        </dl>
        {d.amendments.length > 0 && <p className="mt-2 rounded border border-amber-600 bg-amber-50 p-1">{d.amendments.length} other version(s) of this product were captured. This case verifies the first captured version.</p>}
      </div>
      {d.nowcasts.map((n) => (
        <div key={n.id} className="card">
          <h2 className="h2">{n.label ?? "Nowcast"} <span className="text-xs font-normal text-slate-600">{t(n.assessment_time)}</span></h2>
          {Object.keys(n.ratings).length > 0 && <RatingsTable ratings={n.ratings} />}
          {n.problems.map((p, k) => <ProblemSummary key={k} p={p} />)}
          {n.rationale && <p className="whitespace-pre-line text-sm">{n.rationale}</p>}
        </div>
      ))}
    </div>
  );
}

function EvidenceColumn({ d, canReview, onChange, onError }: { d: Detail; canReview: boolean; onChange: () => void; onError: (e: unknown) => void }) {
  const e = d.evidence;
  const [cov, setCov] = useState({ coverage_type: "combined", coverage_class: "unknown", visibility_class: "", patrol_coverage_class: "", mitigation_sampling_class: "", remote_detection_status: "", rationale: "" });
  const [conflicts, setConflicts] = useState("");
  const [result, setResult] = useState<{ evidence_class: string; rationale: string } | null>(null);
  const nul = (v: string) => v || null;
  const timeline = [
    ...e.avalanches.map((a) => ({ at: String(a.observed_at), kind: "Avalanche", text: `${a.size_max ? `Size ${a.size_max}` : "Size ?"} ${a.trigger_type ?? ""} ${a.aspect ?? ""} ${a.elevation_m ? `${a.elevation_m} m` : ""} ${a.location_name ?? ""} · confidence ${a.observation_confidence}${a.occurred_from ? "" : " · occurrence time unknown"}` })),
    ...e.mitigation.map((m) => ({ at: String(m.action_time), kind: "Mitigation", text: `${m.method}: ${m.result_class} ${m.location_name ?? ""}` })),
    ...e.field.map((f) => ({ at: String(f.observed_at), kind: "Field obs", text: `${f.observation_type} ${f.location_name ?? ""}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="space-y-3">
      <div className="card">
        <h2 className="h2">Evidence timeline</h2>
        {timeline.length === 0
          ? <p className="text-sm text-slate-700">No avalanche, mitigation or field records imported for this period. This is <strong>not</strong> evidence that nothing happened.</p>
          : <ul className="space-y-1 text-sm">{timeline.map((x, k) => <li key={k}><span className="text-xs text-slate-600">{t(x.at)}</span> <strong>{x.kind}</strong> {x.text}</li>)}</ul>}
      </div>
      <div className="card">
        <h2 className="h2">Weather: forecast vs observed</h2>
        {e.weatherExp.length === 0 && e.weatherObs.length === 0 ? <p className="text-sm text-slate-700">No weather expectations or observations for this period.</p> : (
          <table className="table"><thead><tr><th>Variable</th><th>Where</th><th>Expected</th><th>Observed</th></tr></thead><tbody>
            {e.weatherExp.map((w, k) => {
              const obs = e.weatherObs.filter((o) => o.station_code === w.location_reference && o.variable === w.variable).at(-1);
              return <tr key={k}><td>{String(w.variable)}</td><td>{String(w.location_reference)}</td><td>{String(w.expected_min ?? "?")}–{String(w.expected_max ?? "?")} {String(w.unit)}</td><td>{obs ? `${obs.value ?? "missing"} ${obs.unit}` : "no observation"}</td></tr>;
            })}
            {e.weatherObs.filter((o) => !e.weatherExp.some((w) => w.location_reference === o.station_code && w.variable === o.variable)).map((o, k) => (
              <tr key={`o${k}`}><td>{String(o.variable)}</td><td>{String(o.station_code)}</td><td className="text-slate-500">not forecast</td><td>{o.value === null ? "missing" : String(o.value)} {String(o.unit)}</td></tr>
            ))}
          </tbody></table>
        )}
      </div>
      <div className="card">
        <h2 className="h2">Observation coverage</h2>
        {e.coverage.length === 0 ? <p className="text-sm">No coverage statement yet. Without one, the outcome stays "unknown due to coverage".</p>
          : <ul className="text-sm">{e.coverage.map((c, k) => <li key={k}><strong>{String(c.coverage_class)}</strong> overall · visibility {String(c.visibility_class ?? "—")} · patrol {String(c.patrol_coverage_class ?? "—")} · mitigation {String(c.mitigation_sampling_class ?? "—")} · remote {String(c.remote_detection_status ?? "—")}<br /><span className="text-xs">{String(c.rationale)}</span></li>)}</ul>}
        {canReview && (
          <form className="no-print mt-2 space-y-2" onSubmit={async (ev) => {
            ev.preventDefault();
            try {
              await api(`/cases/${d.case.id}/coverage`, { method: "POST", body: { ...cov, visibility_class: nul(cov.visibility_class), patrol_coverage_class: nul(cov.patrol_coverage_class), mitigation_sampling_class: nul(cov.mitigation_sampling_class), remote_detection_status: nul(cov.remote_detection_status) } });
              setCov({ ...cov, rationale: "" }); onChange();
            } catch (err) { onError(err); }
          }}>
            <div className="grid grid-cols-2 gap-2">
              {(["coverage_class", "visibility_class", "patrol_coverage_class", "mitigation_sampling_class"] as const).map((k) => (
                <label key={k}><span className="label">{COVERAGE_LABEL[k]}</span>
                  <select className="input w-full" value={cov[k]} onChange={(x) => setCov({ ...cov, [k]: x.target.value })}>
                    {k !== "coverage_class" && <option value="">—</option>}{COVERAGE_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select></label>
              ))}
              <label><span className="label">Remote detection</span>
                <select className="input w-full" value={cov.remote_detection_status} onChange={(x) => setCov({ ...cov, remote_detection_status: x.target.value })}>
                  <option value="">—</option>{["operational", "partial", "none"].map((c) => <option key={c} value={c}>{c}</option>)}
                </select></label>
            </div>
            <label className="block"><span className="label">Rationale (required)</span><textarea className="input w-full" rows={2} required minLength={3} value={cov.rationale} onChange={(x) => setCov({ ...cov, rationale: x.target.value })} /></label>
            <button className="btn" type="submit">Add coverage statement</button>
          </form>
        )}
      </div>
      <div className="card">
        <h2 className="h2">Evidence class</h2>
        <p className="text-sm"><strong>{d.case.outcome_evidence_class ? EVIDENCE_LABEL[d.case.outcome_evidence_class] : "Not classified"}</strong></p>
        {d.case.evidence_rationale && <p className="text-xs">{d.case.evidence_rationale}</p>}
        {result && <p className="mt-1 text-xs text-slate-700">Last run: {result.evidence_class} · {result.rationale}</p>}
        {canReview && (
          <div className="no-print mt-2 space-y-2">
            <label className="block"><span className="label">Unresolved conflicts (one per line)</span><textarea className="input w-full" rows={2} value={conflicts} onChange={(x) => setConflicts(x.target.value)} /></label>
            <button className="btn" onClick={async () => {
              try { setResult(await api(`/cases/${d.case.id}/evidence`, { method: "POST", body: { conflicts: conflicts.split("\n").map((s) => s.trim()).filter(Boolean) } })); onChange(); }
              catch (err) { onError(err); }
            }}>Classify evidence</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewColumn({ d, canReview, onChange, onError }: { d: Detail; canReview: boolean; onChange: () => void; onError: (e: unknown) => void }) {
  const latest = d.hindsight.filter((h) => h.status !== "superseded").at(-1) ?? null;
  const [draft, setDraft] = useState<AssessmentDraft>(() => (latest ? { ratings: latest.ratings, problems: latest.problems, confidence: latest.confidence, rationale: latest.rationale } : emptyDraft()));
  const [adj, setAdj] = useState({ category: "problem_type", severity: "", reviewer_confidence: "moderate", comments: "", contributing_factors: "" });
  const editable = canReview && d.case.review_status !== "final";
  return (
    <div className="space-y-3">
      <div className="card">
        <h2 className="h2">Independent hindsight assessment</h2>
        {latest && <p className="mb-2 text-xs">Version {latest.version} · <strong>{latest.status}</strong>{latest.label ? ` · ${latest.label}` : ""}</p>}
        {!latest && <p className="mb-2 text-xs text-slate-700">Enter your own assessment from the evidence first. Calculated differences appear after you save it.</p>}
        {editable ? (
          <>
            <AssessmentEditor idPrefix="hindsight" value={draft} onChange={setDraft} />
            <div className="no-print mt-3 flex gap-2">
              <button className="btn" onClick={async () => { try { await api(`/cases/${d.case.id}/hindsight`, { method: "POST", body: draft }); onChange(); } catch (e) { onError(e); } }}>
                {latest?.status === "final" ? "Start revision" : "Save draft"}</button>
              <button className="btn btn-primary" disabled={latest?.status !== "draft"} onClick={async () => { try { await api(`/cases/${d.case.id}/hindsight/finalize`, { method: "POST", body: {} }); onChange(); } catch (e) { onError(e); } }}>Finalize hindsight</button>
            </div>
          </>
        ) : latest ? (<><RatingsTable ratings={latest.ratings} />{latest.problems.map((p, k) => <ProblemSummary key={k} p={p} />)}</>) : <p className="text-sm">No hindsight yet.</p>}
      </div>
      {d.comparison ? <Comparison s={d.comparison} basis={d.comparison_basis!} /> : <div className="card text-sm text-slate-600">Differences are locked until a hindsight assessment is saved.</div>}
      {d.comparison && (
        <div className="card">
          <h2 className="h2">Adjudication</h2>
          {d.adjudications.length > 0 && (
            <ul className="mb-2 space-y-1 text-sm">{d.adjudications.map((a) => (
              <li key={String(a.id)}><strong>{DISCREPANCY_LABEL[a.category as keyof typeof DISCREPANCY_LABEL]}</strong> · {String(a.severity ?? "—")} · confidence {String(a.reviewer_confidence)} · v{String(a.version)} <em>{String(a.status)}</em>
                {a.comments ? <div className="text-xs">{String(a.comments)}</div> : null}
                {editable && a.status === "draft" && <button className="btn ml-2" onClick={async () => { try { await api(`/cases/${d.case.id}/adjudications/finalize`, { method: "POST", body: { id: a.id } }); onChange(); } catch (e) { onError(e); } }}>Finalize</button>}
              </li>))}</ul>
          )}
          {editable && (
            <form className="no-print space-y-2" onSubmit={async (ev) => {
              ev.preventDefault();
              try {
                await api(`/cases/${d.case.id}/adjudications`, { method: "POST", body: { category: adj.category, severity: adj.severity || null, reviewer_confidence: adj.reviewer_confidence, comments: adj.comments || null, contributing_factors: adj.contributing_factors.split(",").map((s) => s.trim()).filter(Boolean) } });
                setAdj({ ...adj, comments: "", contributing_factors: "" }); onChange();
              } catch (e) { onError(e); }
            }}>
              <label className="block"><span className="label">Discrepancy category</span>
                <select className="input w-full" value={adj.category} onChange={(x) => setAdj({ ...adj, category: x.target.value })}>{DISCREPANCY_CATEGORIES.map((c) => <option key={c} value={c}>{DISCREPANCY_LABEL[c]}</option>)}</select></label>
              <div className="grid grid-cols-2 gap-2">
                <label><span className="label">Severity</span><select className="input w-full" value={adj.severity} onChange={(x) => setAdj({ ...adj, severity: x.target.value })}><option value="">—</option>{["minor", "moderate", "major"].map((s) => <option key={s}>{s}</option>)}</select></label>
                <label><span className="label">Reviewer confidence</span><select className="input w-full" value={adj.reviewer_confidence} onChange={(x) => setAdj({ ...adj, reviewer_confidence: x.target.value })}>{["low", "moderate", "high"].map((s) => <option key={s}>{s}</option>)}</select></label>
              </div>
              <label className="block"><span className="label">Contributing factors (comma separated)</span><input className="input w-full" value={adj.contributing_factors} onChange={(x) => setAdj({ ...adj, contributing_factors: x.target.value })} /></label>
              <label className="block"><span className="label">Comments</span><textarea className="input w-full" rows={2} value={adj.comments} onChange={(x) => setAdj({ ...adj, comments: x.target.value })} /></label>
              <button className="btn" type="submit">Save adjudication draft</button>
            </form>
          )}
        </div>
      )}
      {canReview && (
        <div className="card no-print flex flex-wrap gap-2">
          {d.case.review_status !== "final"
            ? <button className="btn btn-primary" onClick={async () => { try { await api(`/cases/${d.case.id}/finalize`, { method: "POST", body: {} }); onChange(); } catch (e) { onError(e); } }}>Finalize case</button>
            : <button className="btn" onClick={async () => { const reason = window.prompt("Reason for reopening"); if (!reason) return; try { await api(`/cases/${d.case.id}/reopen`, { method: "POST", body: { reason } }); onChange(); } catch (e) { onError(e); } }}>Reopen case</button>}
          {!d.case.assigned_reviewer && <button className="btn" onClick={async () => { try { await api(`/cases/${d.case.id}/assign`, { method: "POST", body: {} }); onChange(); } catch (e) { onError(e); } }}>Assign to me</button>}
        </div>
      )}
    </div>
  );
}

function Comparison({ s, basis }: { s: CaseScore; basis: { status: string; version: number } }) {
  const steps = (n: number | null) => (n === null ? "—" : n === 0 ? "match" : `${n > 0 ? "+" : ""}${n}`);
  const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
  return (
    <div className="card">
      <h2 className="h2">Forecast vs hindsight</h2>
      <p className="mb-2 text-xs">Against hindsight v{basis.version} ({basis.status}). {s.caseExclusion ? <strong>Excluded from season metrics: {s.caseExclusion}.</strong> : "Included in season metrics."} Positive = forecast higher than hindsight.</p>
      <table className="table"><thead><tr><th>Band</th><th>Forecast</th><th>Hindsight</th><th>Error</th></tr></thead><tbody>
        {BANDS_TOP_DOWN.map((b) => {
          const x = s.danger[b];
          return <tr key={b}><td>{ELEVATION_BAND_LABEL[b]}</td>
            <td>{x.forecast ? <RatingBadge cell={{ kind: "rated", level: x.forecast }} /> : "—"}</td>
            <td>{x.hindsight ? <RatingBadge cell={{ kind: "rated", level: x.hindsight }} /> : "—"}</td>
            <td>{x.eligible ? (x.signed! > 0 ? `+${x.signed} over` : x.signed! < 0 ? `${x.signed} under` : "exact") : <span className="text-xs">{x.exclusion}</span>}</td></tr>;
        })}
      </tbody></table>
      <h3 className="label mt-2">Problems</h3>
      <p className="text-sm">Precision <Rate r={s.problems.precision} /> · Recall <Rate r={s.problems.recall} /> · Primary {s.problems.primaryCorrect === null ? "—" : s.problems.primaryCorrect ? "matched" : "different"}</p>
      {s.problems.missed.length > 0 && <p className="text-sm">Missed: {s.problems.missed.map((t) => PROBLEM_LABEL[t]).join(", ")}</p>}
      {s.problems.unsupported.length > 0 && <p className="text-sm">Not supported: {s.problems.unsupported.map((t) => PROBLEM_LABEL[t]).join(", ")}</p>}
      {s.perProblem.length > 0 && (
        <table className="table mt-2"><thead><tr><th>Problem</th><th>Aspect×elev</th><th>Likelihood</th><th>Sensitivity</th><th>Size max</th></tr></thead><tbody>
          {s.perProblem.map((p) => <tr key={p.type}><td>{PROBLEM_LABEL[p.type]}</td><td>{pct(p.spatial.combinedOverlap)}</td><td>{steps(p.likelihoodSize.likelihoodMaxSteps)}</td><td>{steps(p.likelihoodSize.sensitivitySteps)}</td><td>{steps(p.likelihoodSize.sizeMaxDifference)}</td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}
