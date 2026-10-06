import type { AvalancheProblem, HazardAssessment } from "../../src/domain/types";

export const problem = (over: Partial<AvalancheProblem>): AvalancheProblem => ({
  problem_type: "wind_slab", rank: 1, elevation_bands: [], aspects: [], cells: null,
  minimum_elevation_m: null, maximum_elevation_m: null, likelihood_min: null, likelihood_max: null,
  sensitivity: null, distribution: null, expected_size_min: null, expected_size_max: null,
  trend: null, confidence: null, comments: null, ...over,
});

export const assessment = (over: Partial<HazardAssessment>): HazardAssessment => ({
  id: "a", forecast_issuance_id: "i", forecast_domain_code: "BYK", assessment_kind: "forecast",
  assessment_time: "2027-01-14T23:00:00Z", valid_from: "2027-01-15T07:00:00Z", valid_to: "2027-01-16T07:00:00Z",
  valid_date: "2027-01-15", forecast_horizon_days: 1, ratings: {}, problems: [], confidence: null, rationale: null,
  status: "final", version: 1, created_by: "u", created_at: "2027-01-14T23:00:00Z", supersedes_id: null, label: null, ...over,
});
