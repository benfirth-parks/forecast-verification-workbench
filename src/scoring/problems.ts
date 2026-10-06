// Set-based avalanche-problem matching. Distinct problem types never match
// unless the scoring version names them in an explicit synonym group.
import type { AvalancheProblem } from "../domain/types";
import type { ProblemType } from "../domain/vocab";
import { rate, type Rate } from "./common";

export type SynonymGroups = ProblemType[][];

function canonicalizer(groups: SynonymGroups) {
  const map = new Map<ProblemType, ProblemType>();
  for (const g of groups) for (const t of g) map.set(t, g[0]);
  return (t: ProblemType) => map.get(t) ?? t;
}

export interface ProblemMatch {
  truePositives: ProblemType[];
  /** Hindsight problems the forecast did not include. */
  missed: ProblemType[];
  /** Forecast problems not supported by the hindsight assessment. */
  unsupported: ProblemType[];
  precision: Rate;
  recall: Rate;
  f1: number | null;
  primaryForecast: ProblemType | null;
  primaryHindsight: ProblemType | null;
  /** null when either side has no problems. */
  primaryCorrect: boolean | null;
  /** Pairs of matched problems, for spatial/likelihood/size comparison. */
  pairs: { forecast: AvalancheProblem; hindsight: AvalancheProblem; type: ProblemType }[];
}

const primary = (ps: AvalancheProblem[]) =>
  [...ps].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0] ?? null;

export function matchProblems(
  forecast: AvalancheProblem[], hindsight: AvalancheProblem[], synonyms: SynonymGroups = [],
): ProblemMatch {
  const canon = canonicalizer(synonyms);
  const byType = (ps: AvalancheProblem[]) => {
    const m = new Map<ProblemType, AvalancheProblem>();
    for (const p of [...ps].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))) {
      const t = canon(p.problem_type);
      if (!m.has(t)) m.set(t, p);
    }
    return m;
  };
  const F = byType(forecast), H = byType(hindsight);
  const tp = [...F.keys()].filter((t) => H.has(t));
  const missed = [...H.keys()].filter((t) => !F.has(t));
  const unsupported = [...F.keys()].filter((t) => !H.has(t));
  const precision = rate(tp.length, F.size);
  const recall = rate(tp.length, H.size);
  const f1 = precision.value !== null && recall.value !== null && precision.value + recall.value > 0
    ? (2 * precision.value * recall.value) / (precision.value + recall.value)
    : precision.value === 0 || recall.value === 0 ? 0 : null;
  const pf = primary(forecast), ph = primary(hindsight);
  return {
    truePositives: tp, missed, unsupported, precision, recall, f1,
    primaryForecast: pf ? canon(pf.problem_type) : null,
    primaryHindsight: ph ? canon(ph.problem_type) : null,
    primaryCorrect: pf && ph ? canon(pf.problem_type) === canon(ph.problem_type) : null,
    pairs: tp.map((t) => ({ forecast: F.get(t)!, hindsight: H.get(t)!, type: t })),
  };
}
