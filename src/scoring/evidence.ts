// Evidence classification. Runs before any occurrence-dependent metric.
// A missing observation is NEVER a supported negative: absence of reports
// becomes `supported_negative` only when the configured coverage rule is met.
import type { AvalancheEvent, DataCoverage, MitigationAction } from "../domain/types";
import { COVERAGE_CLASSES, type CoverageClass, type EvidenceClass } from "../domain/vocab";

export interface EvidenceRule {
  id: string;
  /** observation_confidence values that make an avalanche record count as evidence. */
  qualifying_observation_confidence: string[];
  /** Minimum size (inclusive) for an avalanche to count. null = any size. */
  minimum_size: number | null;
  /** Coverage needed before "nothing observed" may be read as a negative. */
  supported_negative: {
    minimum_overall_coverage: CoverageClass;
    /** At least this many of the listed coverage dimensions must meet the minimum. */
    minimum_dimensions: number;
    dimensions: ("visibility" | "patrol" | "mitigation" | "remote")[];
    dimension_minimum: CoverageClass;
  };
}

export const DEFAULT_EVIDENCE_RULE: EvidenceRule = {
  id: "evidence-v1-draft",
  qualifying_observation_confidence: ["high", "moderate"],
  minimum_size: null,
  supported_negative: {
    minimum_overall_coverage: "moderate",
    minimum_dimensions: 1,
    dimensions: ["visibility", "patrol", "mitigation", "remote"],
    dimension_minimum: "moderate",
  },
};

/** high > moderate > low > unknown */
const rank = (c: CoverageClass | null | undefined) => (c ? COVERAGE_CLASSES.length - 1 - COVERAGE_CLASSES.indexOf(c) : 0);
const meets = (c: CoverageClass | null | undefined, min: CoverageClass) => c !== "unknown" && rank(c) >= rank(min);

export interface EvidenceInput {
  avalanches: Pick<AvalancheEvent, "observation_confidence" | "size_max" | "size_min">[];
  mitigation: Pick<MitigationAction, "result_class">[];
  coverage: Pick<DataCoverage, "coverage_class" | "visibility_class" | "patrol_coverage_class" | "mitigation_sampling_class" | "remote_detection_status">[];
  /** Reviewer- or source-flagged unresolved conflicts. */
  conflicts: string[];
  notApplicable?: string | null;
}

export interface EvidenceResult {
  evidence_class: EvidenceClass;
  rationale: string;
  rule_id: string;
  qualifying_avalanches: number;
}

export function classifyEvidence(input: EvidenceInput, rule: EvidenceRule = DEFAULT_EVIDENCE_RULE): EvidenceResult {
  const base = { rule_id: rule.id };
  if (input.notApplicable) return { ...base, evidence_class: "not_applicable", rationale: input.notApplicable, qualifying_avalanches: 0 };
  const qualifying = input.avalanches.filter((a) =>
    rule.qualifying_observation_confidence.includes(a.observation_confidence)
    && (rule.minimum_size === null || (a.size_max ?? a.size_min ?? 0) >= rule.minimum_size));
  if (input.conflicts.length) {
    return { ...base, evidence_class: "conflicting_evidence", rationale: `Unresolved conflicts: ${input.conflicts.join("; ")}`, qualifying_avalanches: qualifying.length };
  }
  if (qualifying.length) {
    return { ...base, evidence_class: "observed_positive", rationale: `${qualifying.length} qualifying avalanche observation(s) under rule ${rule.id}.`, qualifying_avalanches: qualifying.length };
  }
  if (!input.coverage.length) {
    return { ...base, evidence_class: "unknown_due_to_coverage", rationale: "No qualifying avalanches and no coverage record: absence of reports is not evidence of absence.", qualifying_avalanches: 0 };
  }
  const sn = rule.supported_negative;
  const dimValue = (c: EvidenceInput["coverage"][number], d: EvidenceRule["supported_negative"]["dimensions"][number]): CoverageClass | null => {
    if (d === "visibility") return c.visibility_class;
    if (d === "patrol") return c.patrol_coverage_class;
    if (d === "mitigation") return c.mitigation_sampling_class;
    return c.remote_detection_status === "operational" ? "high" : null;
  };
  const best = input.coverage.find((c) =>
    meets(c.coverage_class, sn.minimum_overall_coverage)
    && sn.dimensions.filter((d) => meets(dimValue(c, d), sn.dimension_minimum)).length >= sn.minimum_dimensions);
  if (best) {
    const dims = sn.dimensions.filter((d) => meets(dimValue(best, d), sn.dimension_minimum));
    return { ...base, evidence_class: "supported_negative", rationale: `No qualifying avalanches; coverage ${best.coverage_class} with adequate ${dims.join(", ")}.`, qualifying_avalanches: 0 };
  }
  return { ...base, evidence_class: "unknown_due_to_coverage", rationale: `No qualifying avalanches, but coverage does not meet rule ${rule.id} (needs overall ≥ ${sn.minimum_overall_coverage} and ${sn.minimum_dimensions} of ${sn.dimensions.join("/")} ≥ ${sn.dimension_minimum}).`, qualifying_avalanches: 0 };
}

/** Evidence classes that give an adequate verification basis for danger and problem metrics. */
export const ADEQUATE_BASIS: EvidenceClass[] = ["observed_positive", "supported_negative"];
