// Danger-rating verification. Signed error = forecast − hindsight, so a
// positive value is an overforecast and a negative value an underforecast.
import { DANGER_LEVELS, type DangerLevel, type RatingCell } from "../domain/vocab";
import { mean, rate, type Rate } from "./common";

export interface BandComparison {
  eligible: boolean;
  exclusion: string | null;
  forecast: DangerLevel | null;
  hindsight: DangerLevel | null;
  signed: number | null;
  absolute: number | null;
  exact: boolean | null;
  withinOne: boolean | null;
}

export function compareRating(forecast: RatingCell | undefined, hindsight: RatingCell | undefined): BandComparison {
  const f = forecast?.kind === "rated" ? forecast.level : null;
  const h = hindsight?.kind === "rated" ? hindsight.level : null;
  if (f === null || h === null) {
    const which = f === null && h === null ? "both" : f === null ? "forecast" : "hindsight";
    const state = (c: RatingCell | undefined) => (c ? (c.kind === "rated" ? String(c.level) : c.state) : "missing");
    return {
      eligible: false,
      exclusion: `${which} not rated (forecast: ${state(forecast)}, hindsight: ${state(hindsight)})`,
      forecast: f, hindsight: h, signed: null, absolute: null, exact: null, withinOne: null,
    };
  }
  const signed = f - h;
  return {
    eligible: true, exclusion: null, forecast: f, hindsight: h,
    signed, absolute: Math.abs(signed), exact: signed === 0, withinOne: Math.abs(signed) <= 1,
  };
}

export interface DangerSummary {
  pairs: number;
  excluded: number;
  exclusionReasons: Record<string, number>;
  exact: Rate;
  withinOne: Rate;
  overforecast: Rate;
  underforecast: Rate;
  meanAbsoluteError: number | null;
  meanSignedError: number | null;
  /** signed error → count */
  signedDistribution: Record<string, number>;
  /** confusion[forecast-1][hindsight-1] */
  confusion: number[][];
  weightedKappa: { value: number | null; weights: "quadratic"; minimumSample: number; reason: string | null };
}

export interface DangerInput {
  comparison: BandComparison;
  /** Reason the whole case is excluded (no final hindsight, inadequate evidence…). */
  caseExclusion?: string | null;
}

export function summarizeDanger(inputs: DangerInput[], kappaMinimumSample = 30): DangerSummary {
  const confusion = DANGER_LEVELS.map(() => DANGER_LEVELS.map(() => 0));
  const exclusionReasons: Record<string, number> = {};
  const used: BandComparison[] = [];
  for (const { comparison, caseExclusion } of inputs) {
    const reason = caseExclusion ?? (comparison.eligible ? null : "rating not comparable");
    if (reason) {
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
      continue;
    }
    used.push(comparison);
    confusion[comparison.forecast! - 1][comparison.hindsight! - 1]++;
  }
  const n = used.length;
  const signedDistribution: Record<string, number> = {};
  for (const c of used) signedDistribution[String(c.signed)] = (signedDistribution[String(c.signed)] ?? 0) + 1;
  return {
    pairs: n,
    excluded: inputs.length - n,
    exclusionReasons,
    exact: rate(used.filter((c) => c.exact).length, n),
    withinOne: rate(used.filter((c) => c.withinOne).length, n),
    overforecast: rate(used.filter((c) => c.signed! > 0).length, n),
    underforecast: rate(used.filter((c) => c.signed! < 0).length, n),
    meanAbsoluteError: mean(used.map((c) => c.absolute!)),
    meanSignedError: mean(used.map((c) => c.signed!)),
    signedDistribution,
    confusion,
    weightedKappa: n >= kappaMinimumSample
      ? { value: quadraticWeightedKappa(confusion), weights: "quadratic", minimumSample: kappaMinimumSample, reason: null }
      : { value: null, weights: "quadratic", minimumSample: kappaMinimumSample, reason: `sample of ${n} is below ${kappaMinimumSample}` },
  };
}

/** Cohen's kappa with quadratic weights over a k×k confusion matrix. */
export function quadraticWeightedKappa(m: number[][]): number | null {
  const k = m.length;
  const total = m.flat().reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rows = m.map((r) => r.reduce((a, b) => a + b, 0));
  const cols = m[0].map((_, j) => m.reduce((a, r) => a + r[j], 0));
  let observed = 0, expected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = ((i - j) ** 2) / ((k - 1) ** 2);
      observed += w * m[i][j];
      expected += w * (rows[i] * cols[j]) / total;
    }
  }
  if (expected === 0) return null;
  return 1 - observed / expected;
}
