// The day's calls side by side: public bulletin (issued the evening before),
// morning meeting, afternoon meeting and hindsight review. Changes are marked
// against the previous recorded stage, in words as well as symbols.
import type { HazardAssessment } from "../../domain/types";
import { formatLocal } from "../../domain/time";
import { ELEVATION_BAND_LABEL, PROBLEM_LABEL, type ProblemType } from "../../domain/vocab";
import { STAGE_LABEL, STAGES, type Stage, type StageChange } from "../../scoring/stages";
import { BANDS_TOP_DOWN, RatingBadge } from "./assessment";

export interface StageMeta { issued_at: string | null; assessment_type?: string; horizon_days?: number | null; versions?: number; entries?: number; status?: string }
export interface DayStagesView {
  date: string;
  stages: Partial<Record<Stage, HazardAssessment>>;
  meta: Partial<Record<Stage, StageMeta>>;
  hindsightFinal: boolean;
  changes: StageChange[];
}

const ZONE = "America/Edmonton";
const MISSING: Record<Stage, string> = {
  bulletin: "No bulletin captured for this day",
  morning: "No morning meeting entry",
  afternoon: "No afternoon meeting entry",
  hindsight: "No hindsight review yet",
};

function stageNote(stage: Stage, m: StageMeta | undefined) {
  if (!m) return null;
  const at = m.issued_at ? formatLocal(m.issued_at, ZONE) : null;
  const parts = [at];
  if (stage === "bulletin") {
    if (m.assessment_type === "operational_forecast") parts.push("Avy FX feed");
    if (m.horizon_days !== null && m.horizon_days !== undefined) parts.push(m.horizon_days === 1 ? "issued the day before" : `${m.horizon_days} day(s) ahead`);
  }
  if (stage === "morning" && m.versions && m.versions > 1) parts.push(`first of ${m.versions} versions`);
  if (stage === "afternoon" && m.entries && m.entries > 1) parts.push(`latest of ${m.entries} entries`);
  if (stage === "hindsight" && m.status) parts.push(m.status);
  return parts.filter(Boolean).join(" · ");
}

function Delta({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined || delta === 0) return null;
  const up = delta > 0;
  return <span className="ml-1 whitespace-nowrap text-xs font-semibold">{up ? "▲ raised" : "▼ lowered"}{Math.abs(delta) > 1 ? ` ${Math.abs(delta)}` : ""}</span>;
}

export function DayStages({ day }: { day: DayStagesView }) {
  const present = STAGES.filter((s) => day.stages[s]);
  const changeInto = (s: Stage) => day.changes.find((c) => c.to === s);
  const label = (t: ProblemType) => PROBLEM_LABEL[t];
  return (
    <div className="card overflow-x-auto">
      <h2 className="h2">The day's calls for {day.date}</h2>
      <p className="mb-2 text-xs text-slate-700">The public bulletin issued the evening before, then the morning and afternoon meetings. Marks show what changed from the previous recorded call. These are the team's own revisions, not errors.</p>
      <table className="table">
        <thead><tr><th></th>{STAGES.map((s) => (
          <th key={s} scope="col">{STAGE_LABEL[s]}<div className="text-xs font-normal normal-case tracking-normal text-slate-600">{day.stages[s] ? stageNote(s, day.meta[s]) : MISSING[s]}</div></th>
        ))}</tr></thead>
        <tbody>
          {BANDS_TOP_DOWN.map((b) => (
            <tr key={b}><th scope="row">{ELEVATION_BAND_LABEL[b]}</th>{STAGES.map((s) => {
              const a = day.stages[s];
              return <td key={s}>{a ? <><RatingBadge cell={a.ratings[b]} />{present.indexOf(s) > 0 && <Delta delta={changeInto(s)?.bands[b].delta} />}</> : <span className="text-xs text-slate-500">—</span>}</td>;
            })}</tr>
          ))}
          <tr><th scope="row">Problems</th>{STAGES.map((s) => {
            const a = day.stages[s];
            if (!a) return <td key={s}><span className="text-xs text-slate-500">—</span></td>;
            const c = changeInto(s);
            return (
              <td key={s} className="align-top text-xs">
                {a.problems.length === 0 ? <span className="text-slate-600">None listed</span> : (
                  <ul>{a.problems.map((p, k) => <li key={k}>{p.rank ? `${p.rank}. ` : ""}{label(p.problem_type)}{c?.problemsAdded.includes(p.problem_type) && <strong> (added)</strong>}</li>)}</ul>
                )}
                {c && c.problemsRemoved.length > 0 && <p className="mt-1">Dropped: <s>{c.problemsRemoved.map(label).join(", ")}</s></p>}
              </td>
            );
          })}</tr>
        </tbody>
      </table>
    </div>
  );
}
