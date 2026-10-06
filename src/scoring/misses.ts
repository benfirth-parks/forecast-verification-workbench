// Seasonal aggregation and screening for systematic misses.
// Screening flags are prompts for review, not findings: each one shows its
// numerator, denominator and the cases behind it.
import type { Adjudication } from "../domain/types";
import { DISCREPANCY_CATEGORIES, ELEVATION_BANDS, PROBLEM_TYPES, type DiscrepancyCategory, type ElevationBand, type ProblemType } from "../domain/vocab";
import { mean, rate, type Rate } from "./common";
import type { CaseScore, ScoringConfig } from "./case";
import { summarizeDanger, type DangerSummary } from "./danger";

export interface ScoredCase {
  caseId: string;
  validDate: string;
  score: CaseScore;
  adjudications: Pick<Adjudication, "category" | "status">[];
}

export interface ProblemTypeStats {
  type: ProblemType;
  forecastCount: number;
  hindsightCount: number;
  matched: number;
  missed: Rate;       // missed / hindsight occurrences
  unsupported: Rate;  // unsupported / forecast occurrences
  meanCombinedOverlap: number | null;
  meanSizeMaxDifference: number | null;
  meanLikelihoodMaxSteps: number | null;
  meanSensitivitySteps: number | null;
  caseIds: { missed: string[]; unsupported: string[] };
}

export interface ScreeningFlag {
  dimension: "danger" | "problem_type" | "spatial" | "size" | "likelihood" | "sensitivity";
  subject: string;
  message: string;
  evidence: Rate | { mean: number; n: number };
  caseIds: string[];
}

export interface SeasonSummary {
  totalCases: number;
  includedCases: number;
  excludedCases: number;
  exclusionReasons: Record<string, number>;
  dangerByBand: Record<ElevationBand, DangerSummary>;
  problemTypes: ProblemTypeStats[];
  adjudicationCategories: Record<DiscrepancyCategory, Rate>;
  flags: ScreeningFlag[];
}

export function summarizeSeason(cases: ScoredCase[], config: ScoringConfig): SeasonSummary {
  const included = cases.filter((c) => !c.score.caseExclusion);
  const exclusionReasons: Record<string, number> = {};
  for (const c of cases) if (c.score.caseExclusion) exclusionReasons[c.score.caseExclusion] = (exclusionReasons[c.score.caseExclusion] ?? 0) + 1;

  const dangerByBand = Object.fromEntries(ELEVATION_BANDS.map((b) => [b, summarizeDanger(
    cases.map((c) => ({ comparison: c.score.danger[b], caseExclusion: c.score.caseExclusion })),
    config.kappa_minimum_sample,
  )])) as Record<ElevationBand, DangerSummary>;

  const problemTypes: ProblemTypeStats[] = PROBLEM_TYPES.map((type) => {
    const missedIds: string[] = [], unsupportedIds: string[] = [];
    let fc = 0, hc = 0, matched = 0;
    const overlaps: number[] = [], sizes: number[] = [], likes: number[] = [], sens: number[] = [];
    for (const c of included) {
      const p = c.score.problems;
      const inF = p.truePositives.includes(type) || p.unsupported.includes(type);
      const inH = p.truePositives.includes(type) || p.missed.includes(type);
      if (inF) fc++;
      if (inH) hc++;
      if (p.truePositives.includes(type)) matched++;
      if (p.missed.includes(type)) missedIds.push(c.caseId);
      if (p.unsupported.includes(type)) unsupportedIds.push(c.caseId);
      const pp = c.score.perProblem.find((x) => x.type === type);
      if (pp) {
        if (pp.spatial.combinedOverlap !== null) overlaps.push(pp.spatial.combinedOverlap);
        if (pp.likelihoodSize.sizeMaxDifference !== null) sizes.push(pp.likelihoodSize.sizeMaxDifference);
        if (pp.likelihoodSize.likelihoodMaxSteps !== null) likes.push(pp.likelihoodSize.likelihoodMaxSteps);
        if (pp.likelihoodSize.sensitivitySteps !== null) sens.push(pp.likelihoodSize.sensitivitySteps);
      }
    }
    return {
      type, forecastCount: fc, hindsightCount: hc, matched,
      missed: rate(missedIds.length, hc), unsupported: rate(unsupportedIds.length, fc),
      meanCombinedOverlap: mean(overlaps), meanSizeMaxDifference: mean(sizes),
      meanLikelihoodMaxSteps: mean(likes), meanSensitivitySteps: mean(sens),
      caseIds: { missed: missedIds, unsupported: unsupportedIds },
    };
  });

  const finalAdj = included.map((c) => new Set(c.adjudications.filter((a) => a.status === "final").map((a) => a.category)));
  const adjudicationCategories = Object.fromEntries(DISCREPANCY_CATEGORIES.map((cat) => [
    cat, rate(finalAdj.filter((s) => s.has(cat)).length, included.length),
  ])) as Record<DiscrepancyCategory, Rate>;

  return {
    totalCases: cases.length,
    includedCases: included.length,
    excludedCases: cases.length - included.length,
    exclusionReasons,
    dangerByBand,
    problemTypes,
    adjudicationCategories,
    flags: screen(included, dangerByBand, problemTypes, config),
  };
}

function screen(included: ScoredCase[], danger: Record<ElevationBand, DangerSummary>, problems: ProblemTypeStats[], config: ScoringConfig): ScreeningFlag[] {
  const { minimum_cases, rate_threshold, mean_steps_threshold } = config.screening;
  const flags: ScreeningFlag[] = [];
  for (const b of ELEVATION_BANDS) {
    const d = danger[b];
    for (const [key, word] of [["underforecast", "below"], ["overforecast", "above"]] as const) {
      const r = d[key];
      if (r.denominator >= minimum_cases && (r.value ?? 0) >= rate_threshold) {
        const ids = included.filter((c) => { const s = c.score.danger[b].signed; return s !== null && (key === "underforecast" ? s < 0 : s > 0); }).map((c) => c.caseId);
        flags.push({ dimension: "danger", subject: b, message: `Forecast rating ${word} hindsight in ${r.numerator} of ${r.denominator} ${b} cases`, evidence: r, caseIds: ids });
      }
    }
  }
  for (const p of problems) {
    if (p.missed.denominator >= minimum_cases && (p.missed.value ?? 0) >= rate_threshold) {
      flags.push({ dimension: "problem_type", subject: p.type, message: `${p.type} identified in hindsight but not forecast in ${p.missed.numerator} of ${p.missed.denominator} cases`, evidence: p.missed, caseIds: p.caseIds.missed });
    }
    if (p.unsupported.denominator >= minimum_cases && (p.unsupported.value ?? 0) >= rate_threshold) {
      flags.push({ dimension: "problem_type", subject: p.type, message: `${p.type} forecast but not supported in hindsight in ${p.unsupported.numerator} of ${p.unsupported.denominator} cases`, evidence: p.unsupported, caseIds: p.caseIds.unsupported });
    }
    const matchedIds = included.filter((c) => c.score.problems.truePositives.includes(p.type)).map((c) => c.caseId);
    if (p.matched >= minimum_cases) {
      if (p.meanSizeMaxDifference !== null && Math.abs(p.meanSizeMaxDifference) >= mean_steps_threshold) {
        flags.push({ dimension: "size", subject: p.type, message: `${p.type} expected size max ${p.meanSizeMaxDifference > 0 ? "above" : "below"} hindsight by ${Math.abs(p.meanSizeMaxDifference).toFixed(2)} on average`, evidence: { mean: p.meanSizeMaxDifference, n: p.matched }, caseIds: matchedIds });
      }
      if (p.meanLikelihoodMaxSteps !== null && Math.abs(p.meanLikelihoodMaxSteps) >= mean_steps_threshold) {
        flags.push({ dimension: "likelihood", subject: p.type, message: `${p.type} likelihood ${p.meanLikelihoodMaxSteps > 0 ? "above" : "below"} hindsight by ${Math.abs(p.meanLikelihoodMaxSteps).toFixed(2)} category steps on average`, evidence: { mean: p.meanLikelihoodMaxSteps, n: p.matched }, caseIds: matchedIds });
      }
      if (p.meanSensitivitySteps !== null && Math.abs(p.meanSensitivitySteps) >= mean_steps_threshold) {
        flags.push({ dimension: "sensitivity", subject: p.type, message: `${p.type} sensitivity ${p.meanSensitivitySteps > 0 ? "above" : "below"} hindsight by ${Math.abs(p.meanSensitivitySteps).toFixed(2)} category steps on average`, evidence: { mean: p.meanSensitivitySteps, n: p.matched }, caseIds: matchedIds });
      }
      if (p.meanCombinedOverlap !== null && p.meanCombinedOverlap < 1 - rate_threshold * 2) {
        flags.push({ dimension: "spatial", subject: p.type, message: `${p.type} aspect/elevation overlap averages ${(p.meanCombinedOverlap * 100).toFixed(0)}%`, evidence: { mean: p.meanCombinedOverlap, n: p.matched }, caseIds: matchedIds });
      }
    }
  }
  return flags;
}
