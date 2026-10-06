// Scores one verification case: forecast vs. independent hindsight.
// Produces separate metric families; there is deliberately no master score.
import type { HazardAssessment, VerificationCase } from "../domain/types";
import { ELEVATION_BANDS, type ElevationBand, type ProblemType } from "../domain/vocab";
import { canonicalJson } from "./common";
import { compareRating, type BandComparison } from "./danger";
import { ADEQUATE_BASIS, DEFAULT_EVIDENCE_RULE, type EvidenceRule } from "./evidence";
import { compareLikelihoodSize, type LikelihoodSizeComparison } from "./likelihood-size";
import { matchProblems, type ProblemMatch, type SynonymGroups } from "./problems";
import { compareSpatial, SPATIAL_METHOD_VERSION, type SpatialComparison } from "./spatial";

export interface ScoringConfig {
  name: string;
  synonyms: SynonymGroups;
  evidence_rule: EvidenceRule;
  kappa_minimum_sample: number;
  spatial_method: string;
  /** Screening thresholds for flagging possible systematic misses. */
  screening: { minimum_cases: number; rate_threshold: number; mean_steps_threshold: number };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  name: "v1-draft",
  synonyms: [],
  evidence_rule: DEFAULT_EVIDENCE_RULE,
  kappa_minimum_sample: 30,
  spatial_method: SPATIAL_METHOD_VERSION,
  screening: { minimum_cases: 10, rate_threshold: 0.25, mean_steps_threshold: 0.5 },
};

/** Stable identity of a scoring configuration: same config → same id. */
export const scoringConfigKey = (c: ScoringConfig) => canonicalJson(c);

export interface CaseScore {
  caseExclusion: string | null;
  danger: Record<ElevationBand, BandComparison>;
  problems: ProblemMatch;
  perProblem: { type: ProblemType; spatial: SpatialComparison; likelihoodSize: LikelihoodSizeComparison }[];
}

export function caseExclusionReason(c: Pick<VerificationCase, "outcome_evidence_class">, hindsight: HazardAssessment | null): string | null {
  if (!hindsight) return "no hindsight assessment";
  if (hindsight.status !== "final") return "hindsight not finalized";
  if (!c.outcome_evidence_class) return "evidence not classified";
  if (!ADEQUATE_BASIS.includes(c.outcome_evidence_class)) return `evidence class ${c.outcome_evidence_class}`;
  return null;
}

export function scoreCase(
  c: Pick<VerificationCase, "outcome_evidence_class">,
  forecast: HazardAssessment, hindsight: HazardAssessment, config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): CaseScore {
  const danger = Object.fromEntries(
    ELEVATION_BANDS.map((b) => [b, compareRating(forecast.ratings[b], hindsight.ratings[b])]),
  ) as Record<ElevationBand, BandComparison>;
  const problems = matchProblems(forecast.problems, hindsight.problems, config.synonyms);
  return {
    caseExclusion: caseExclusionReason(c, hindsight),
    danger,
    problems,
    perProblem: problems.pairs.map((p) => ({
      type: p.type,
      spatial: compareSpatial(p.forecast, p.hindsight),
      likelihoodSize: compareLikelihoodSize(p.forecast, p.hindsight),
    })),
  };
}

/** Flatten a case score into verification_scores rows. */
export function scoreRows(s: CaseScore) {
  const rows: { metric_family: string; metric_name: string; metric_value: number | null; metric_payload: Record<string, unknown> }[] = [];
  for (const b of ELEVATION_BANDS) {
    const d = s.danger[b];
    rows.push({ metric_family: "danger", metric_name: `signed_error_${b}`, metric_value: d.signed, metric_payload: { ...d } });
  }
  rows.push({ metric_family: "problems", metric_name: "precision", metric_value: s.problems.precision.value, metric_payload: { ...s.problems.precision } });
  rows.push({ metric_family: "problems", metric_name: "recall", metric_value: s.problems.recall.value, metric_payload: { ...s.problems.recall } });
  rows.push({ metric_family: "problems", metric_name: "f1", metric_value: s.problems.f1, metric_payload: { missed: s.problems.missed, unsupported: s.problems.unsupported, primaryCorrect: s.problems.primaryCorrect } });
  for (const p of s.perProblem) {
    rows.push({ metric_family: "spatial", metric_name: `combined_overlap_${p.type}`, metric_value: p.spatial.combinedOverlap, metric_payload: { ...p.spatial } });
    rows.push({ metric_family: "size", metric_name: `size_max_difference_${p.type}`, metric_value: p.likelihoodSize.sizeMaxDifference, metric_payload: { ...p.likelihoodSize } });
  }
  return rows.map((r) => ({ ...r, metric_payload: { ...r.metric_payload, case_exclusion: s.caseExclusion } }));
}
