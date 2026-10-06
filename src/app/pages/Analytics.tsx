// Seasonal analytics. Every percentage shows numerator/denominator and every
// table states its exclusion rule. Screening flags are prompts for review.
import { useEffect, useState } from "react";
import { DANGER_LABEL, DISCREPANCY_LABEL, ELEVATION_BAND_LABEL, EVIDENCE_LABEL, PROBLEM_LABEL, type DiscrepancyCategory } from "../../domain/vocab";
import type { SeasonSummary } from "../../scoring/misses";
import { STAGE_LABEL, type TransitionSummary } from "../../scoring/stages";
import type { WeatherSummary } from "../../scoring/weather";
import { api } from "../api";
import { BANDS_TOP_DOWN, ErrorText, Rate } from "../components/assessment";
import { navigate } from "../router";

interface Summary { scoring_version: string; exclusion_rule: string; season: SeasonSummary; weather: WeatherSummary[]; evidence: Record<string, number>; stages: TransitionSummary[]; stage_rule: string }
const f2 = (n: number | null) => (n === null ? "—" : n.toFixed(2));

export function Analytics({ query }: { query: URLSearchParams }) {
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const from = query.get("from") ?? "", to = query.get("to") ?? "", type = query.get("type") ?? "";
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries({ from, to, type }).filter(([, v]) => v)).toString();
    setS(null);
    api<Summary>(`/analytics/summary${qs ? `?${qs}` : ""}`).then(setS).catch(setError);
  }, [from, to, type]);
  const set = (k: string, v: string) => navigate("/analytics", { from, to, type, [k]: v || undefined });
  return (
    <section className="space-y-3">
      <h1 className="text-lg font-semibold">Season analytics</h1>
      <div className="card no-print flex flex-wrap items-end gap-3">
        <label><span className="label">From</span><input className="input" type="date" value={from} onChange={(e) => set("from", e.target.value)} /></label>
        <label><span className="label">To</span><input className="input" type="date" value={to} onChange={(e) => set("to", e.target.value)} /></label>
        <label><span className="label">Product</span><select className="input" value={type} onChange={(e) => set("type", e.target.value)}>
          <option value="">All</option><option value="public_bulletin">Public bulletin</option><option value="morning_hazard">Morning meeting</option><option value="operational_forecast">Avy FX forecast</option></select></label>
      </div>
      <ErrorText error={error} />
      {!s ? <p>Loading…</p> : <>
        <div className="card text-sm">
          <p><strong>{s.season.includedCases}</strong> of {s.season.totalCases} cases included · scoring {s.scoring_version}</p>
          <p className="text-xs text-slate-700">{s.exclusion_rule}</p>
          {Object.entries(s.season.exclusionReasons).length > 0 && <p className="text-xs">Excluded: {Object.entries(s.season.exclusionReasons).map(([k, v]) => `${k} (${v})`).join(" · ")}</p>}
          <p className="mt-1 text-xs">Evidence classes: {Object.entries(s.evidence).map(([k, v]) => `${k in EVIDENCE_LABEL ? EVIDENCE_LABEL[k as keyof typeof EVIDENCE_LABEL] : k} ${v}`).join(" · ")}</p>
        </div>

        <div className="card">
          <h2 className="h2">Possible systematic misses</h2>
          <p className="mb-2 text-xs text-slate-700">Screening prompts only. A flag means a pattern is large enough to look at, not that a forecast was wrong. Thresholds are part of the scoring version.</p>
          {s.season.flags.length === 0 ? <p className="text-sm">No pattern meets the screening thresholds yet.</p> : (
            <ul className="space-y-1 text-sm">{s.season.flags.map((f, i) => (
              <li key={i}><strong>{f.dimension.replace("_", " ")}</strong> · {f.message}{" "}
                <span className="text-xs">({f.caseIds.length} cases: {f.caseIds.slice(0, 8).map((id) => <a key={id} className="mr-1 text-blue-800 underline" href={`#/case/${id}`}>{id.slice(0, 6)}</a>)}{f.caseIds.length > 8 ? "…" : ""})</span></li>
            ))}</ul>
          )}
        </div>

        <div className="card overflow-x-auto">
          <h2 className="h2">Danger rating by elevation band</h2>
          <table className="table"><thead><tr><th>Band</th><th>Pairs</th><th>Exact</th><th>Within one</th><th>Over</th><th>Under</th><th>MAE</th><th>Mean signed</th><th>Weighted κ</th></tr></thead><tbody>
            {BANDS_TOP_DOWN.map((b) => { const d = s.season.dangerByBand[b]; return (
              <tr key={b}><td>{ELEVATION_BAND_LABEL[b]}</td><td>{d.pairs} <span className="text-xs">(+{d.excluded} excl.)</span></td><td><Rate r={d.exact} /></td><td><Rate r={d.withinOne} /></td><td><Rate r={d.overforecast} /></td><td><Rate r={d.underforecast} /></td><td>{f2(d.meanAbsoluteError)}</td><td>{f2(d.meanSignedError)}</td><td>{d.weightedKappa.value === null ? <span className="text-xs">{d.weightedKappa.reason}</span> : f2(d.weightedKappa.value)}</td></tr>
            ); })}
          </tbody></table>
          <div className="mt-3 flex flex-wrap gap-4">
            {BANDS_TOP_DOWN.map((b) => (
              <table key={b} className="text-xs" aria-label={`${ELEVATION_BAND_LABEL[b]} confusion matrix`}>
                <caption className="text-left font-semibold">{ELEVATION_BAND_LABEL[b]}: forecast (rows) × hindsight (columns)</caption>
                <thead><tr><th></th>{[1, 2, 3, 4, 5].map((h) => <th key={h} className="px-1" title={DANGER_LABEL[h as 1]}>{h}</th>)}</tr></thead>
                <tbody>{s.season.dangerByBand[b].confusion.map((row, i) => <tr key={i}><th className="pr-1" title={DANGER_LABEL[(i + 1) as 1]}>{i + 1}</th>{row.map((n, j) => <td key={j} className={`border px-2 text-center ${i === j ? "font-semibold" : ""}`}>{n || ""}</td>)}</tr>)}</tbody>
              </table>
            ))}
          </div>
        </div>

        <div className="card overflow-x-auto">
          <h2 className="h2">Avalanche problems</h2>
          <p className="mb-1 text-xs text-slate-700">Steps are ordinal category differences (forecast − hindsight), not physical quantities. Matched pairs only for overlap, likelihood, sensitivity and size.</p>
          <table className="table"><thead><tr><th>Problem</th><th>Forecast</th><th>Hindsight</th><th>Missed</th><th>Not supported</th><th>Aspect×elev overlap</th><th>Likelihood steps</th><th>Sensitivity steps</th><th>Size max diff</th></tr></thead><tbody>
            {s.season.problemTypes.filter((p) => p.forecastCount + p.hindsightCount > 0).map((p) => (
              <tr key={p.type}><td>{PROBLEM_LABEL[p.type]}</td><td>{p.forecastCount}</td><td>{p.hindsightCount}</td><td><Rate r={p.missed} /></td><td><Rate r={p.unsupported} /></td>
                <td>{p.meanCombinedOverlap === null ? "—" : `${Math.round(p.meanCombinedOverlap * 100)}%`}</td><td>{f2(p.meanLikelihoodMaxSteps)}</td><td>{f2(p.meanSensitivitySteps)}</td><td>{f2(p.meanSizeMaxDifference)}</td></tr>
            ))}
          </tbody></table>
        </div>

        <div className="card overflow-x-auto">
          <h2 className="h2">How the call changed through the day</h2>
          <p className="mb-2 text-xs text-slate-700">{s.stage_rule}</p>
          {s.stages.every((t) => t.days === 0) ? <p className="text-sm">No day has two recorded calls yet.</p> : s.stages.filter((t) => t.days > 0).map((t) => (
            <div key={`${t.from}-${t.to}`} className="mb-3">
              <h3 className="font-semibold">{STAGE_LABEL[t.from]} → {STAGE_LABEL[t.to]}</h3>
              <p className="text-sm">{t.days} day(s) with both · changed on <Rate r={t.daysChanged} /></p>
              <table className="table"><thead><tr><th>Band</th><th>Compared</th><th>Raised</th><th>Lowered</th><th>Unchanged</th><th>Moved toward hindsight</th><th>Moved away</th></tr></thead><tbody>
                {BANDS_TOP_DOWN.map((b) => { const x = t.bands[b]; return (
                  <tr key={b}><td>{ELEVATION_BAND_LABEL[b]}</td><td>{x.compared}</td><td><Rate r={x.raised} /></td><td><Rate r={x.lowered} /></td><td><Rate r={x.unchanged} /></td><td><Rate r={x.towardHindsight} /></td><td><Rate r={x.awayFromHindsight} /></td></tr>
                ); })}
              </tbody></table>
              <p className="mt-1 text-xs">Problems added: {Object.entries(t.problemsAdded).map(([k, n]) => `${PROBLEM_LABEL[k as keyof typeof PROBLEM_LABEL]} ${n}`).join(" · ") || "none"}
                {t.addedConfirmed.denominator > 0 && <> (kept by hindsight <Rate r={t.addedConfirmed} />)</>}</p>
              <p className="text-xs">Problems dropped: {Object.entries(t.problemsRemoved).map(([k, n]) => `${PROBLEM_LABEL[k as keyof typeof PROBLEM_LABEL]} ${n}`).join(" · ") || "none"}
                {t.removedConfirmed.denominator > 0 && <> (also absent in hindsight <Rate r={t.removedConfirmed} />)</>}</p>
            </div>
          ))}
        </div>

        <div className="card overflow-x-auto">
          <h2 className="h2">Weather expectations vs observations</h2>
          {s.weather.length === 0 ? <p className="text-sm">No paired weather expectations and observations yet.</p> : (
            <table className="table"><thead><tr><th>Variable</th><th>Pairs</th><th>Missing obs</th><th>Bias</th><th>MAE</th><th>Inside forecast range</th><th>Threshold agreement</th></tr></thead><tbody>
              {s.weather.map((w) => <tr key={w.variable}><td>{w.variable}</td><td>{w.pairs}</td><td>{w.excludedMissingObservation}</td><td>{f2(w.bias)}</td><td>{f2(w.meanAbsoluteError)}</td><td><Rate r={w.rangeCoverage} /></td><td>{w.threshold ? <>≥{w.threshold.value}: <Rate r={w.threshold.agreement} /></> : "—"}</td></tr>)}
            </tbody></table>
          )}
        </div>

        <div className="card">
          <h2 className="h2">Adjudicated discrepancy categories</h2>
          <table className="table"><tbody>
            {Object.entries(s.season.adjudicationCategories).filter(([, r]) => r.numerator > 0).map(([k, r]) => <tr key={k}><td>{DISCREPANCY_LABEL[k as DiscrepancyCategory]}</td><td><Rate r={r} /></td></tr>)}
          </tbody></table>
          {Object.values(s.season.adjudicationCategories).every((r) => r.numerator === 0) && <p className="text-sm">No finalized adjudications yet.</p>}
        </div>
      </>}
    </section>
  );
}
