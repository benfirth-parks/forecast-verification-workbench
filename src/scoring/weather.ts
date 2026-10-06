// Weather verification, per variable and period. Error = forecast − observed.
import type { WeatherExpectation, WeatherVariable } from "../domain/types";
import { mean, rate, type Rate } from "./common";

export interface WeatherPair {
  variable: WeatherVariable;
  expected: Pick<WeatherExpectation, "expected_min" | "expected_max" | "expected_value">;
  observed: number | null;
}

/** Point forecast: the stated value, else the range midpoint. */
export function pointForecast(e: WeatherPair["expected"]): number | null {
  if (e.expected_value !== null) return e.expected_value;
  if (e.expected_min !== null && e.expected_max !== null) return (e.expected_min + e.expected_max) / 2;
  return e.expected_min ?? e.expected_max ?? null;
}

export interface WeatherSummary {
  variable: WeatherVariable;
  pairs: number;
  excludedMissingObservation: number;
  bias: number | null;
  meanAbsoluteError: number | null;
  rangeCoverage: Rate;
  threshold: null | { value: number; hits: number; misses: number; falseAlarms: number; correctNegatives: number; agreement: Rate };
}

export function summarizeWeather(pairs: WeatherPair[], variable: WeatherVariable, threshold?: number): WeatherSummary {
  const mine = pairs.filter((p) => p.variable === variable);
  const usable = mine.filter((p) => p.observed !== null && pointForecast(p.expected) !== null);
  const errors = usable.map((p) => pointForecast(p.expected)! - p.observed!);
  const ranged = usable.filter((p) => p.expected.expected_min !== null && p.expected.expected_max !== null);
  const covered = ranged.filter((p) => p.observed! >= p.expected.expected_min! && p.observed! <= p.expected.expected_max!);
  let thr: WeatherSummary["threshold"] = null;
  if (threshold !== undefined) {
    let hits = 0, misses = 0, falseAlarms = 0, correctNegatives = 0;
    for (const p of usable) {
      const f = pointForecast(p.expected)! >= threshold, o = p.observed! >= threshold;
      if (f && o) hits++; else if (!f && o) misses++; else if (f && !o) falseAlarms++; else correctNegatives++;
    }
    thr = { value: threshold, hits, misses, falseAlarms, correctNegatives, agreement: rate(hits + correctNegatives, usable.length) };
  }
  return {
    variable,
    pairs: usable.length,
    excludedMissingObservation: mine.length - usable.length,
    bias: mean(errors),
    meanAbsoluteError: mean(errors.map(Math.abs)),
    rangeCoverage: rate(covered.length, ranged.length),
    threshold: thr,
  };
}

/** Signed timing error in hours (forecast − observed); positive = forecast too late. */
export function timingErrorHours(forecastIso: string | null, observedIso: string | null): number | null {
  if (!forecastIso || !observedIso) return null;
  return (Date.parse(forecastIso) - Date.parse(observedIso)) / 36e5;
}

/** Peirce skill score (hit rate − false-alarm rate) for a 2×2 table. */
export function peirceSkillScore(t: { hits: number; misses: number; falseAlarms: number; correctNegatives: number }): number | null {
  const pod = t.hits + t.misses > 0 ? t.hits / (t.hits + t.misses) : null;
  const pofd = t.falseAlarms + t.correctNegatives > 0 ? t.falseAlarms / (t.falseAlarms + t.correctNegatives) : null;
  return pod === null || pofd === null ? null : pod - pofd;
}
