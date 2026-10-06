// Controlled vocabularies. Defaults follow the CAA Observation Guidelines and
// Recording Standards (OGRS) and the Canadian conceptual model of avalanche
// hazard, as used by avalanche.ca and the Parks Avy FX tool. Every ordered
// scale here is ORDINAL: positions are ranks, not evenly spaced quantities.

export const ELEVATION_BANDS = ["btl", "tln", "alp"] as const;
export type ElevationBand = (typeof ELEVATION_BANDS)[number];
export const ELEVATION_BAND_LABEL: Record<ElevationBand, string> = {
  alp: "Alpine",
  tln: "Treeline",
  btl: "Below treeline",
};

/** Source spellings → canonical band code. Unknown spellings are import errors. */
const BAND_ALIASES: Record<string, ElevationBand> = {
  alp: "alp", alpine: "alp",
  tln: "tln", tl: "tln", treeline: "tln",
  btl: "btl", belowtreeline: "btl",
};
export function parseElevationBand(raw: unknown): ElevationBand | null {
  const k = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return BAND_ALIASES[k] ?? null;
}

export const ASPECTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Aspect = (typeof ASPECTS)[number];
/** Centre bearing (degrees true) of each 45° aspect sector. */
export const ASPECT_CENTRE_DEG: Record<Aspect, number> = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
};
export function parseAspect(raw: unknown): Aspect | null {
  const k = String(raw ?? "").toUpperCase().replace(/[^NESW]/g, "");
  return (ASPECTS as readonly string[]).includes(k) ? (k as Aspect) : null;
}

// ---------- danger ratings ----------

export const DANGER_LEVELS = [1, 2, 3, 4, 5] as const;
export type DangerLevel = (typeof DANGER_LEVELS)[number];
export const DANGER_LABEL: Record<DangerLevel, string> = {
  1: "Low", 2: "Moderate", 3: "Considerable", 4: "High", 5: "Extreme",
};

/**
 * A rating cell is either a numeric level or an explicit non-rated state.
 * A missing or non-rated cell is NEVER the same as Low (1).
 */
export const NON_RATED_STATES = [
  "no_rating", "early_season", "spring", "summer", "no_forecast", "no_elevation", "not_entered",
] as const;
export type NonRatedState = (typeof NON_RATED_STATES)[number];
export type RatingCell =
  | { kind: "rated"; level: DangerLevel }
  | { kind: "not_rated"; state: NonRatedState };

const RATING_ALIASES: Record<string, RatingCell> = {
  "1": { kind: "rated", level: 1 }, low: { kind: "rated", level: 1 }, "1low": { kind: "rated", level: 1 },
  "2": { kind: "rated", level: 2 }, moderate: { kind: "rated", level: 2 }, "2moderate": { kind: "rated", level: 2 },
  "3": { kind: "rated", level: 3 }, considerable: { kind: "rated", level: 3 }, "3considerable": { kind: "rated", level: 3 },
  "4": { kind: "rated", level: 4 }, high: { kind: "rated", level: 4 }, "4high": { kind: "rated", level: 4 },
  "5": { kind: "rated", level: 5 }, extreme: { kind: "rated", level: 5 }, "5extreme": { kind: "rated", level: 5 },
  norating: { kind: "not_rated", state: "no_rating" },
  earlyseason: { kind: "not_rated", state: "early_season" },
  spring: { kind: "not_rated", state: "spring" },
  summer: { kind: "not_rated", state: "summer" },
  summerconditions: { kind: "not_rated", state: "summer" },
  noforecast: { kind: "not_rated", state: "no_forecast" },
  noelevation: { kind: "not_rated", state: "no_elevation" },
};
/** Returns null for an unrecognised value so the caller can raise an import error. */
export function parseRating(raw: unknown): RatingCell | null {
  if (raw === null || raw === undefined || raw === "") return { kind: "not_rated", state: "not_entered" };
  const k = String(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
  return RATING_ALIASES[k] ?? null;
}
export const ratingLevel = (c: RatingCell | undefined): DangerLevel | null =>
  c && c.kind === "rated" ? c.level : null;

// ---------- avalanche problems ----------

export const PROBLEM_TYPES = [
  "dry_loose", "wet_loose", "storm_slab", "wind_slab", "persistent_slab",
  "deep_persistent_slab", "wet_slab", "glide_slab", "cornice",
] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];
export const PROBLEM_LABEL: Record<ProblemType, string> = {
  dry_loose: "Dry loose", wet_loose: "Wet loose", storm_slab: "Storm slab", wind_slab: "Wind slab",
  persistent_slab: "Persistent slab", deep_persistent_slab: "Deep persistent slab",
  wet_slab: "Wet slab", glide_slab: "Glide slab", cornice: "Cornice",
};
/**
 * Spelling variants only. Distinct problem types are never merged here; a
 * scoring version may add explicit synonym groups (see scoring/problems.ts).
 */
const PROBLEM_ALIASES: Record<string, ProblemType> = {
  dryloose: "dry_loose", looseddry: "dry_loose", loosedry: "dry_loose",
  wetloose: "wet_loose", loosewet: "wet_loose",
  stormslab: "storm_slab", stormslabs: "storm_slab",
  windslab: "wind_slab", windslabs: "wind_slab",
  persistentslab: "persistent_slab", persistentslabs: "persistent_slab",
  deeppersistentslab: "deep_persistent_slab", deeppersistentslabs: "deep_persistent_slab",
  wetslab: "wet_slab", wetslabs: "wet_slab",
  glideslab: "glide_slab", glide: "glide_slab", glideslabs: "glide_slab",
  cornice: "cornice", cornices: "cornice",
};
export function parseProblemType(raw: unknown): ProblemType | null {
  const k = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return PROBLEM_ALIASES[k] ?? null;
}

/** Ordinal scales, lowest first. */
export const LIKELIHOOD = ["unlikely", "possible", "likely", "very_likely", "almost_certain"] as const;
export type Likelihood = (typeof LIKELIHOOD)[number];
export const SENSITIVITY = ["unreactive", "stubborn", "reactive", "touchy"] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];
export const DISTRIBUTION = ["isolated", "specific", "widespread"] as const;
export type Distribution = (typeof DISTRIBUTION)[number];

function ordinalParser<T extends string>(scale: readonly T[], extra: Record<string, T> = {}) {
  return (raw: unknown): T | null => {
    const k = String(raw ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    if ((scale as readonly string[]).includes(k)) return k as T;
    return extra[k] ?? null;
  };
}
export const parseLikelihood = ordinalParser(LIKELIHOOD, { certain: "almost_certain", verylikely: "very_likely" });
export const parseSensitivity = ordinalParser(SENSITIVITY);
export const parseDistribution = ordinalParser(DISTRIBUTION);

/** Parses "possible", "possible-likely", "possible_to_likely" into an ordered min/max pair. */
export function parseLikelihoodRange(raw: unknown): { min: Likelihood; max: Likelihood } | null {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return null;
  const single = parseLikelihood(s);
  if (single) return { min: single, max: single };
  // Try every split point between word tokens, so "possible-very-likely" works.
  const tokens = s.split(/[^a-z]+/).filter((t) => t && t !== "to");
  for (let i = 1; i < tokens.length; i++) {
    const a = parseLikelihood(tokens.slice(0, i).join("_"));
    const b = parseLikelihood(tokens.slice(i).join("_"));
    if (a && b) return LIKELIHOOD.indexOf(a) <= LIKELIHOOD.indexOf(b) ? { min: a, max: b } : { min: b, max: a };
  }
  return null;
}

/** Destructive size classes allowed by OGRS (half sizes permitted). */
export function parseSize(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(String(raw).replace(/^D/i, ""));
  if (!Number.isFinite(n) || n < 1 || n > 5 || Math.round(n * 2) !== n * 2) return null;
  return n;
}

export const CONFIDENCE = ["low", "moderate", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const parseConfidence = ordinalParser(CONFIDENCE, { medium: "moderate" });

// ---------- review vocabularies ----------

export const EVIDENCE_CLASSES = [
  "observed_positive", "supported_negative", "unknown_due_to_coverage", "conflicting_evidence", "not_applicable",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export const EVIDENCE_LABEL: Record<EvidenceClass, string> = {
  observed_positive: "Observed positive",
  supported_negative: "Supported negative",
  unknown_due_to_coverage: "Unknown (coverage)",
  conflicting_evidence: "Conflicting evidence",
  not_applicable: "Not applicable",
};

export const COVERAGE_CLASSES = ["high", "moderate", "low", "unknown"] as const;
export type CoverageClass = (typeof COVERAGE_CLASSES)[number];

export const DISCREPANCY_CATEGORIES = [
  "weather_forecast", "problem_type", "spatial_distribution", "likelihood_sensitivity",
  "expected_size", "timing", "local_variability", "inadequate_coverage", "source_data_error",
  "ambiguous_evidence", "other",
] as const;
export type DiscrepancyCategory = (typeof DISCREPANCY_CATEGORIES)[number];
export const DISCREPANCY_LABEL: Record<DiscrepancyCategory, string> = {
  weather_forecast: "Weather forecast difference",
  problem_type: "Problem-type difference",
  spatial_distribution: "Spatial-distribution difference",
  likelihood_sensitivity: "Likelihood or sensitivity difference",
  expected_size: "Expected-size difference",
  timing: "Timing difference",
  local_variability: "Local variability",
  inadequate_coverage: "Inadequate observation coverage",
  source_data_error: "Source-data error",
  ambiguous_evidence: "Ambiguous evidence",
  other: "Other",
};

export const ROLES = ["viewer", "analyst", "reviewer", "administrator"] as const;
export type Role = (typeof ROLES)[number];
