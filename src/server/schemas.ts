// Request schemas shared by the API and the UI.
import { z } from "zod";
import {
  ASPECTS, CONFIDENCE, COVERAGE_CLASSES, DISCREPANCY_CATEGORIES, DISTRIBUTION, ELEVATION_BANDS, EVIDENCE_CLASSES,
  LIKELIHOOD, NON_RATED_STATES, PROBLEM_TYPES, SENSITIVITY,
} from "../domain/vocab";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });
const size = z.number().min(1).max(5).refine((n) => Number.isInteger(n * 2), "sizes are in half classes");

export const ratingCell = z.union([
  z.object({ kind: z.literal("rated"), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]) }),
  z.object({ kind: z.literal("not_rated"), state: z.enum(NON_RATED_STATES) }),
]);

export const problem = z.object({
  problem_type: z.enum(PROBLEM_TYPES),
  rank: z.number().int().min(1).nullable(),
  elevation_bands: z.array(z.enum(ELEVATION_BANDS)),
  aspects: z.array(z.enum(ASPECTS)),
  cells: z.array(z.string().regex(/^(N|NE|E|SE|S|SW|W|NW):(alp|tln|btl)$/)).nullable(),
  minimum_elevation_m: z.number().int().nullable(),
  maximum_elevation_m: z.number().int().nullable(),
  likelihood_min: z.enum(LIKELIHOOD).nullable(),
  likelihood_max: z.enum(LIKELIHOOD).nullable(),
  sensitivity: z.enum(SENSITIVITY).nullable(),
  distribution: z.enum(DISTRIBUTION).nullable(),
  expected_size_min: size.nullable(),
  expected_size_max: size.nullable(),
  trend: z.string().max(40).nullable(),
  confidence: z.enum(CONFIDENCE).nullable(),
  comments: z.string().max(2000).nullable(),
}).refine((p) => p.expected_size_min === null || p.expected_size_max === null || p.expected_size_min <= p.expected_size_max, "size min > max")
  .refine((p) => !p.likelihood_min || !p.likelihood_max || LIKELIHOOD.indexOf(p.likelihood_min) <= LIKELIHOOD.indexOf(p.likelihood_max), "likelihood min > max");

export const assessmentBody = z.object({
  ratings: z.object({ alp: ratingCell.optional(), tln: ratingCell.optional(), btl: ratingCell.optional() }),
  problems: z.array(problem).max(6),
  confidence: z.enum(CONFIDENCE).nullable(),
  rationale: z.string().max(4000).nullable(),
});

export const morningBody = assessmentBody.extend({
  date,
  issued_at: instant,
  weather: z.array(z.object({
    variable: z.enum(["hn24", "hw24", "wind_speed_max", "air_temp_max", "freezing_level", "precip_24"]),
    unit: z.string().min(1).max(10),
    location_reference: z.string().min(1).max(60),
    expected_min: z.number().nullable(),
    expected_max: z.number().nullable(),
  })).max(20),
});

export const nowcastBody = assessmentBody.extend({ date, issued_at: instant });

export const coverageBody = z.object({
  coverage_type: z.string().min(1).max(60),
  coverage_class: z.enum(COVERAGE_CLASSES),
  visibility_class: z.enum(COVERAGE_CLASSES).nullable(),
  patrol_coverage_class: z.enum(COVERAGE_CLASSES).nullable(),
  mitigation_sampling_class: z.enum(COVERAGE_CLASSES).nullable(),
  remote_detection_status: z.enum(["operational", "partial", "none"]).nullable(),
  rationale: z.string().min(3).max(2000),
});

export const evidenceBody = z.object({
  conflicts: z.array(z.string().min(1).max(300)).max(10).default([]),
  not_applicable: z.string().max(300).nullable().default(null),
  /** Optional reviewer override; must carry a rationale. */
  override: z.object({ evidence_class: z.enum(EVIDENCE_CLASSES), rationale: z.string().min(10).max(2000) }).nullable().default(null),
});

export const adjudicationBody = z.object({
  category: z.enum(DISCREPANCY_CATEGORIES),
  severity: z.enum(["minor", "moderate", "major"]).nullable(),
  contributing_factors: z.array(z.string().max(80)).max(10),
  reviewer_confidence: z.enum(CONFIDENCE),
  comments: z.string().max(2000).nullable(),
  supersedes_id: z.string().uuid().nullable().optional(),
});

export const importBody = z.object({
  adapter: z.enum(["avcan-bulletin", "avyfx-feed", "csv-observations"]),
  file_name: z.string().min(1).max(200),
  /** JSON payload for bulletin/feed adapters; CSV text or row array for observations. */
  payload: z.unknown(),
  captured_at: instant.optional(),
  mapping: z.unknown().optional(),
  /** Commit only: checksum from the dry run, to prove the same payload is being committed. */
  expected_checksum: z.string().optional(),
});
