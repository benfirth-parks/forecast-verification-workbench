// Canonical records shared by importers, scoring, the API and the UI.
// Timestamps are ISO-8601 UTC strings. Local dates ("YYYY-MM-DD") always carry
// the IANA zone they were computed in.
import type {
  Aspect, Confidence, CoverageClass, DiscrepancyCategory, Distribution, ElevationBand, EvidenceClass,
  Likelihood, ProblemType, RatingCell, Role, Sensitivity,
} from "./vocab";

export interface Provenance {
  source_system: string;
  source_record_id: string;
  source_version: string | null;
  import_run_id: string | null;
  transformation_version: string;
}

export type AssessmentType = "operational_forecast" | "morning_hazard" | "public_bulletin" | "other";
export type AssessmentKind = "forecast" | "nowcast" | "hindsight";
export type RecordStatus = "draft" | "final" | "superseded";

export interface ForecastIssuance {
  id: string;
  forecast_domain_code: string;
  assessment_type: AssessmentType;
  issued_at: string;
  valid_from: string;
  valid_to: string;
  time_zone: string;
  source_system: string;
  source_record_id: string;
  source_version: string | null;
  raw_payload: unknown;
  raw_payload_hash: string;
  forecaster_team_code: string | null;
  status: "issued" | "amended" | "cancelled";
  import_run_id: string;
  /** First observed by this system (for snapshots of in-place-updated products). */
  captured_at: string;
}

export interface AvalancheProblem {
  problem_type: ProblemType;
  rank: number | null;
  elevation_bands: ElevationBand[];
  aspects: Aspect[];
  /** Optional finer aspect×band selection ("N:alp"); when present it overrides the cross product. */
  cells: string[] | null;
  minimum_elevation_m: number | null;
  maximum_elevation_m: number | null;
  likelihood_min: Likelihood | null;
  likelihood_max: Likelihood | null;
  sensitivity: Sensitivity | null;
  distribution: Distribution | null;
  expected_size_min: number | null;
  expected_size_max: number | null;
  trend: string | null;
  confidence: Confidence | null;
  comments: string | null;
}

export interface HazardAssessment {
  id: string;
  forecast_issuance_id: string | null;
  forecast_domain_code: string;
  assessment_kind: AssessmentKind;
  assessment_time: string;
  valid_from: string;
  valid_to: string;
  /** Local calendar day (in the domain zone) the assessment is for. */
  valid_date: string;
  /** Days between issue date and valid_date, in the domain zone. 0 = same day. */
  forecast_horizon_days: number | null;
  ratings: Partial<Record<ElevationBand, RatingCell>>;
  problems: AvalancheProblem[];
  confidence: Confidence | null;
  rationale: string | null;
  status: RecordStatus;
  version: number;
  created_by: string;
  created_at: string;
  supersedes_id: string | null;
  /** Hindsight entered after the validity period is a later expert assessment. */
  label: string | null;
}

export interface WeatherExpectation {
  id: string;
  forecast_issuance_id: string;
  location_reference: string;
  variable: WeatherVariable;
  unit: string;
  expected_min: number | null;
  expected_max: number | null;
  expected_value: number | null;
  period_start: string;
  period_end: string;
  available_at: string;
}

export type WeatherVariable = "hn24" | "hw24" | "wind_speed_max" | "air_temp_max" | "freezing_level" | "precip_24";

export interface WeatherObservation {
  id: string;
  station_code: string;
  observed_at: string;
  variable: WeatherVariable;
  value: number | null;
  unit: string;
  quality_status: string;
  quality_flags: string[];
  provenance: Provenance;
}

export interface AvalancheEvent {
  id: string;
  forecast_domain_code: string;
  occurred_from: string | null;
  occurred_to: string | null;
  observed_at: string;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  location_confidence: string;
  trigger_type: string | null;
  avalanche_type: string | null;
  problem_type: ProblemType | null;
  size_min: number | null;
  size_max: number | null;
  failure_layer: string | null;
  aspect: Aspect | null;
  elevation_m: number | null;
  elevation_band: ElevationBand | null;
  observation_confidence: string;
  raw_payload: unknown;
  provenance: Provenance;
}

export interface MitigationAction {
  id: string;
  forecast_domain_code: string;
  action_time: string;
  location_name: string | null;
  method: string;
  result_class: string;
  result_summary: Record<string, unknown>;
  linked_avalanche_event_ids: string[];
  observation_confidence: string;
  raw_payload: unknown;
  provenance: Provenance;
}

export interface FieldObservation {
  id: string;
  forecast_domain_code: string;
  observation_type: string;
  observed_at: string;
  location_name: string | null;
  standardized_payload: Record<string, unknown>;
  raw_payload: unknown;
  quality_status: string;
  provenance: Provenance;
}

export interface DataCoverage {
  id: string;
  forecast_domain_code: string;
  period_start: string;
  period_end: string;
  coverage_type: string;
  coverage_class: CoverageClass;
  visibility_class: CoverageClass | null;
  patrol_coverage_class: CoverageClass | null;
  remote_detection_status: string | null;
  mitigation_sampling_class: CoverageClass | null;
  rationale: string;
  created_by: string;
  created_at: string;
}

export interface VerificationCase {
  id: string;
  forecast_issuance_id: string;
  forecast_domain_code: string;
  period_start: string;
  period_end: string;
  valid_date: string;
  verification_unit: string;
  forecast_assessment_id: string;
  hindsight_assessment_id: string | null;
  outcome_evidence_class: EvidenceClass | null;
  evidence_rationale: string | null;
  review_status: "unassigned" | "in_review" | "final" | "reopened";
  assigned_reviewer: string | null;
  scoring_version_id: string | null;
  created_at: string;
}

export interface Adjudication {
  id: string;
  verification_case_id: string;
  category: DiscrepancyCategory;
  severity: "minor" | "moderate" | "major" | null;
  contributing_factors: string[];
  reviewer_confidence: Confidence;
  comments: string | null;
  status: RecordStatus;
  version: number;
  created_by: string;
  created_at: string;
  supersedes_id: string | null;
}

export interface VerificationScore {
  id: string;
  verification_case_id: string;
  scoring_version_id: string;
  metric_family: string;
  metric_name: string;
  metric_value: number | null;
  metric_payload: Record<string, unknown>;
  calculated_at: string;
  input_hash: string;
}

export interface ImportRun {
  id: string;
  adapter: string;
  source_system: string;
  source_identifier: string;
  checksum: string;
  dry_run: boolean;
  status: "validated" | "committed" | "failed" | "superseded";
  started_at: string;
  finished_at: string | null;
  summary: Record<string, number>;
  created_by: string;
  superseded_by: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  details: Record<string, unknown>;
}

export interface AppUser {
  id: string;
  /** Coded identifier shown in analytics; never a name. */
  code: string;
  role: Role;
}
