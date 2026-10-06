import { useEffect, useState } from "react";
import type { HazardAssessment, VerificationCase } from "../../domain/types";
import { EVIDENCE_CLASSES, EVIDENCE_LABEL, PROBLEM_LABEL, PROBLEM_TYPES } from "../../domain/vocab";
import { api } from "../api";
import { BANDS_TOP_DOWN, ErrorText, RatingBadge } from "../components/assessment";
import { navigate } from "../router";

type Row = VerificationCase & { assessment_type: string; sub_area_title: string | null; issued_at: string; amendments: number; forecast: HazardAssessment | null };

export function TodayReview({ query }: { query: URLSearchParams }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const f = Object.fromEntries(["from", "to", "status", "evidence", "type", "problem"].map((k) => [k, query.get(k) ?? ""]));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  useEffect(() => {
    setRows(null);
    api<{ cases: Row[] }>(`/cases${qs ? `?${qs}` : ""}`).then((d) => setRows(d.cases)).catch(setError);
  }, [qs]);
  const set = (k: string, v: string) => navigate("/today-review", { ...f, [k]: v || undefined });
  return (
    <section>
      <h1 className="mb-3 text-lg font-semibold">Review queue</h1>
      <div className="mb-3 flex flex-wrap items-end gap-3 card no-print">
        <label><span className="label">From</span><input className="input" type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></label>
        <label><span className="label">To</span><input className="input" type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></label>
        <label><span className="label">Review status</span>
          <select className="input" value={f.status} onChange={(e) => set("status", e.target.value)}>
            <option value="">Any</option>{["unassigned", "in_review", "final", "reopened"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select></label>
        <label><span className="label">Evidence</span>
          <select className="input" value={f.evidence} onChange={(e) => set("evidence", e.target.value)}>
            <option value="">Any</option>{EVIDENCE_CLASSES.map((s) => <option key={s} value={s}>{EVIDENCE_LABEL[s]}</option>)}
          </select></label>
        <label><span className="label">Product</span>
          <select className="input" value={f.type} onChange={(e) => set("type", e.target.value)}>
            <option value="">Any</option><option value="public_bulletin">Public bulletin</option><option value="morning_hazard">Morning meeting</option><option value="operational_forecast">Avy FX forecast</option>
          </select></label>
        <label><span className="label">Problem type</span>
          <select className="input" value={f.problem} onChange={(e) => set("problem", e.target.value)}>
            <option value="">Any</option>{PROBLEM_TYPES.map((p) => <option key={p} value={p}>{PROBLEM_LABEL[p]}</option>)}
          </select></label>
      </div>
      <ErrorText error={error} />
      {!rows ? <p>Loading…</p> : rows.length === 0 ? (
        <p className="card text-sm">No cases match. Cases appear when a bulletin is imported or a morning assessment is entered.</p>
      ) : (
        <table className="table card">
          <thead><tr><th>Date</th><th>Product</th><th>Area</th><th>Alp</th><th>Tln</th><th>Btl</th><th>Evidence</th><th>Review</th><th>Reviewer</th><th>Warnings</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/case/${r.id}`)}>
                <td><a className="text-blue-800 underline" href={`#/case/${r.id}`}>{r.valid_date}</a></td>
                <td>{r.assessment_type.replace(/_/g, " ")}</td>
                <td className="max-w-48 truncate" title={r.sub_area_title ?? ""}>{r.sub_area_title ?? "BYK"}</td>
                {BANDS_TOP_DOWN.map((b) => <td key={b}><RatingBadge cell={r.forecast?.ratings[b]} /></td>)}
                <td>{r.outcome_evidence_class ? EVIDENCE_LABEL[r.outcome_evidence_class] : <span className="text-slate-500">not classified</span>}</td>
                <td>{r.review_status.replace("_", " ")}</td>
                <td className="text-xs">{r.assigned_reviewer ? r.assigned_reviewer.slice(0, 8) : "—"}</td>
                <td className="text-xs">{r.amendments ? `${r.amendments} later version(s)` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
