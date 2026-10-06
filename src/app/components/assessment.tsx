// Shared display and editing components for ratings and avalanche problems.
// Danger is always shown as number + word + pattern, never by colour alone.
import type { AvalancheProblem } from "../../domain/types";
import {
  ASPECTS, CONFIDENCE, DANGER_LABEL, DISTRIBUTION, ELEVATION_BAND_LABEL, LIKELIHOOD, NON_RATED_STATES, PROBLEM_LABEL,
  PROBLEM_TYPES, SENSITIVITY, type ElevationBand, type RatingCell,
} from "../../domain/vocab";

export const BANDS_TOP_DOWN: ElevationBand[] = ["alp", "tln", "btl"];
const COLOURS = ["", "bg-green-100 border-green-700", "bg-yellow-100 border-yellow-700", "bg-orange-100 border-orange-700", "bg-red-100 border-red-700", "bg-slate-800 text-white border-black"];
const PATTERN = ["", "▁", "▃", "▅", "▇", "█"];
const pretty = (s: string) => s.replace(/_/g, " ");

export function RatingBadge({ cell }: { cell: RatingCell | undefined }) {
  if (!cell) return <span className="inline-block rounded border border-dashed border-slate-400 px-1.5 text-xs text-slate-500">missing</span>;
  if (cell.kind === "not_rated") return <span className="inline-block rounded border border-slate-400 bg-slate-100 px-1.5 text-xs">{pretty(cell.state)}</span>;
  return (
    <span className={`inline-block whitespace-nowrap rounded border-l-4 border px-1.5 text-xs font-semibold ${COLOURS[cell.level]}`} title={DANGER_LABEL[cell.level]}>
      <span aria-hidden="true">{PATTERN[cell.level]} </span>{cell.level} {DANGER_LABEL[cell.level]}
    </span>
  );
}

export function RatingsTable({ ratings }: { ratings: Partial<Record<ElevationBand, RatingCell>> }) {
  return (
    <table className="table"><tbody>
      {BANDS_TOP_DOWN.map((b) => <tr key={b}><th scope="row">{ELEVATION_BAND_LABEL[b]}</th><td><RatingBadge cell={ratings[b]} /></td></tr>)}
    </tbody></table>
  );
}

export function cellsOf(p: AvalancheProblem): string[] {
  if (p.cells?.length) return p.cells;
  return p.aspects.flatMap((a) => p.elevation_bands.map((b) => `${a}:${b}`));
}

export function ProblemSummary({ p }: { p: AvalancheProblem }) {
  const cells = new Set(cellsOf(p));
  const range = (a: string | number | null, b: string | number | null) => (a === null && b === null ? "—" : a === b || b === null ? String(a ?? b) : `${a ?? "?"}–${b}`);
  return (
    <div className="mb-2 rounded border border-slate-200 p-2 text-sm">
      <div className="font-semibold">{p.rank ? `${p.rank}. ` : ""}{PROBLEM_LABEL[p.problem_type]}</div>
      <dl className="grid grid-cols-2 gap-x-2 text-xs">
        <dt className="text-slate-600">Likelihood</dt><dd>{range(p.likelihood_min && pretty(p.likelihood_min), p.likelihood_max && pretty(p.likelihood_max))}</dd>
        <dt className="text-slate-600">Sensitivity</dt><dd>{p.sensitivity ?? "—"}</dd>
        <dt className="text-slate-600">Distribution</dt><dd>{p.distribution ?? "—"}</dd>
        <dt className="text-slate-600">Size</dt><dd>{range(p.expected_size_min, p.expected_size_max)}</dd>
      </dl>
      <Rose cells={cells} />
      {p.comments && <p className="mt-1 whitespace-pre-line text-xs text-slate-700">{p.comments}</p>}
    </div>
  );
}

/** Aspect × elevation grid; accessible alternative to a rose diagram. */
export function Rose({ cells, onToggle, label = "Aspect and elevation" }: { cells: Set<string>; onToggle?: (key: string) => void; label?: string }) {
  return (
    <table className="mt-1 text-xs" aria-label={label}>
      <thead><tr><th></th>{ASPECTS.map((a) => <th key={a} className="px-1 font-normal">{a}</th>)}</tr></thead>
      <tbody>
        {BANDS_TOP_DOWN.map((b) => (
          <tr key={b}>
            <th scope="row" className="pr-1 text-left font-normal">{b}</th>
            {ASPECTS.map((a) => {
              const key = `${a}:${b}`, on = cells.has(key);
              return (
                <td key={key} className="p-0.5 text-center">
                  {onToggle
                    ? <input type="checkbox" aria-label={`${a} ${ELEVATION_BAND_LABEL[b]}`} checked={on} onChange={() => onToggle(key)} />
                    : <span aria-label={`${a} ${b} ${on ? "included" : "not included"}`} className={`inline-block h-3 w-3 border ${on ? "border-blue-900 bg-blue-700" : "border-slate-300 bg-white"}`}>{on ? "" : ""}</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface AssessmentDraft {
  ratings: Partial<Record<ElevationBand, RatingCell>>;
  problems: AvalancheProblem[];
  confidence: (typeof CONFIDENCE)[number] | null;
  rationale: string | null;
}
export const emptyDraft = (): AssessmentDraft => ({ ratings: {}, problems: [], confidence: null, rationale: null });
export const emptyProblem = (rank: number): AvalancheProblem => ({
  problem_type: "storm_slab", rank, elevation_bands: [], aspects: [], cells: [], minimum_elevation_m: null, maximum_elevation_m: null,
  likelihood_min: null, likelihood_max: null, sensitivity: null, distribution: null, expected_size_min: null, expected_size_max: null,
  trend: null, confidence: null, comments: null,
});

const encodeCell = (c: RatingCell | undefined) => (!c ? "" : c.kind === "rated" ? String(c.level) : c.state);
const decodeCell = (v: string): RatingCell | undefined =>
  !v ? undefined : /^[1-5]$/.test(v) ? { kind: "rated", level: Number(v) as 1 | 2 | 3 | 4 | 5 } : { kind: "not_rated", state: v as (typeof NON_RATED_STATES)[number] };

function Select<T extends string>({ label, value, options, onChange, allowEmpty = true }: { label: string; value: T | null; options: readonly T[]; onChange: (v: T | null) => void; allowEmpty?: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select className="input w-full" value={value ?? ""} onChange={(e) => onChange((e.target.value || null) as T | null)}>
        {allowEmpty && <option value="">—</option>}
        {options.map((o) => <option key={o} value={o}>{pretty(o)}</option>)}
      </select>
    </label>
  );
}
const SIZES = ["1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5"] as const;

export function AssessmentEditor({ value, onChange, idPrefix }: { value: AssessmentDraft; onChange: (v: AssessmentDraft) => void; idPrefix: string }) {
  const setProblem = (i: number, patch: Partial<AvalancheProblem>) =>
    onChange({ ...value, problems: value.problems.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="label">Danger ratings</legend>
        {BANDS_TOP_DOWN.map((b) => (
          <label key={b} className="mt-1 flex items-center justify-between gap-2 text-sm">
            <span>{ELEVATION_BAND_LABEL[b]}</span>
            <select id={`${idPrefix}-rating-${b}`} className="input" value={encodeCell(value.ratings[b])}
              onChange={(e) => onChange({ ...value, ratings: { ...value.ratings, [b]: decodeCell(e.target.value) } })}>
              <option value="">— not entered —</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} {DANGER_LABEL[n as 1]}</option>)}
              {NON_RATED_STATES.filter((s) => s !== "not_entered").map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
            </select>
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="label">Avalanche problems</legend>
        {value.problems.map((p, i) => (
          <div key={i} className="mt-2 rounded border border-slate-300 p-2">
            <div className="flex items-end gap-2">
              <div className="flex-1"><Select label={`Problem ${i + 1}`} value={p.problem_type} options={PROBLEM_TYPES} allowEmpty={false} onChange={(v) => setProblem(i, { problem_type: v! })} /></div>
              <button type="button" className="btn" onClick={() => onChange({ ...value, problems: value.problems.filter((_, j) => j !== i).map((x, j) => ({ ...x, rank: j + 1 })) })}>Remove</button>
            </div>
            <Rose cells={new Set(cellsOf(p))} label={`Problem ${i + 1} aspect and elevation`} onToggle={(key) => {
              const cur = new Set(cellsOf(p));
              if (cur.has(key)) cur.delete(key); else cur.add(key);
              const cells = [...cur].sort();
              setProblem(i, { cells, aspects: [...new Set(cells.map((c) => c.split(":")[0]))] as AvalancheProblem["aspects"], elevation_bands: [...new Set(cells.map((c) => c.split(":")[1]))] as ElevationBand[] });
            }} />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Select label="Likelihood min" value={p.likelihood_min} options={LIKELIHOOD} onChange={(v) => setProblem(i, { likelihood_min: v })} />
              <Select label="Likelihood max" value={p.likelihood_max} options={LIKELIHOOD} onChange={(v) => setProblem(i, { likelihood_max: v })} />
              <Select label="Sensitivity" value={p.sensitivity} options={SENSITIVITY} onChange={(v) => setProblem(i, { sensitivity: v })} />
              <Select label="Distribution" value={p.distribution} options={DISTRIBUTION} onChange={(v) => setProblem(i, { distribution: v })} />
              <Select label="Size min" value={p.expected_size_min === null ? null : (String(p.expected_size_min) as (typeof SIZES)[number])} options={SIZES} onChange={(v) => setProblem(i, { expected_size_min: v === null ? null : Number(v) })} />
              <Select label="Size max" value={p.expected_size_max === null ? null : (String(p.expected_size_max) as (typeof SIZES)[number])} options={SIZES} onChange={(v) => setProblem(i, { expected_size_max: v === null ? null : Number(v) })} />
            </div>
            <label className="mt-2 block"><span className="label">Comments</span>
              <textarea className="input w-full" rows={2} value={p.comments ?? ""} onChange={(e) => setProblem(i, { comments: e.target.value || null })} /></label>
          </div>
        ))}
        <button type="button" className="btn mt-2" disabled={value.problems.length >= 6} onClick={() => onChange({ ...value, problems: [...value.problems, emptyProblem(value.problems.length + 1)] })}>Add problem</button>
      </fieldset>
      <Select label="Confidence" value={value.confidence} options={CONFIDENCE} onChange={(v) => onChange({ ...value, confidence: v })} />
      <label className="block"><span className="label">Rationale</span>
        <textarea className="input w-full" rows={3} value={value.rationale ?? ""} onChange={(e) => onChange({ ...value, rationale: e.target.value || null })} /></label>
    </div>
  );
}

export function Rate({ r }: { r: { numerator: number; denominator: number; value: number | null } }) {
  return <span>{r.value === null ? "—" : `${Math.round(r.value * 100)}%`} <span className="text-xs text-slate-600">({r.numerator}/{r.denominator})</span></span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; issues?: { path: string; message: string }[] };
  return (
    <div role="alert" className="rounded border border-red-700 bg-red-50 p-2 text-sm text-red-900">
      {e.message ?? String(error)}
      {e.issues?.length ? <ul className="list-disc pl-5">{e.issues.map((i, k) => <li key={k}>{i.path}: {i.message}</li>)}</ul> : null}
    </div>
  );
}
