// Likelihood, sensitivity, distribution and expected-size comparisons.
// Ordinal differences are reported in CATEGORY STEPS. Steps are not assumed to
// be evenly spaced in any physical sense; averaging them is a documented
// convenience (scoring-methods.md) and never converted into a probability.
import type { AvalancheProblem } from "../domain/types";
import { DISTRIBUTION, LIKELIHOOD, SENSITIVITY } from "../domain/vocab";
import { jaccard, type Direction } from "./common";

function stepDiff<T extends string>(scale: readonly T[], f: T | null, h: T | null): number | null {
  if (!f || !h) return null;
  return scale.indexOf(f) - scale.indexOf(h);
}

const direction = (lo: number | null, hi: number | null): Direction => {
  if (lo === null || hi === null) return "not_comparable";
  if (lo === 0 && hi === 0) return "match";
  if (lo >= 0 && hi >= 0) return "over";
  if (lo <= 0 && hi <= 0) return "under";
  return "mixed";
};

/** Half-size classes covered by an inclusive size range, e.g. 1.5–2.5 → {1.5, 2, 2.5}. */
export function sizeClasses(min: number | null, max: number | null): number[] {
  if (min === null && max === null) return [];
  const lo = min ?? max!, hi = max ?? min!;
  const out: number[] = [];
  for (let s = Math.min(lo, hi); s <= Math.max(lo, hi) + 1e-9; s += 0.5) out.push(Math.round(s * 2) / 2);
  return out;
}

export interface LikelihoodSizeComparison {
  likelihoodMinSteps: number | null;
  likelihoodMaxSteps: number | null;
  likelihoodOverlap: number | null;
  likelihoodDirection: Direction;
  sensitivitySteps: number | null;
  distributionSteps: number | null;
  sizeMinDifference: number | null;
  sizeMaxDifference: number | null;
  sizeOverlap: number | null;
  sizeDirection: Direction;
}

export function compareLikelihoodSize(f: AvalancheProblem, h: AvalancheProblem): LikelihoodSizeComparison {
  const lMin = stepDiff(LIKELIHOOD, f.likelihood_min, h.likelihood_min);
  const lMax = stepDiff(LIKELIHOOD, f.likelihood_max, h.likelihood_max);
  const span = (p: AvalancheProblem) => p.likelihood_min && p.likelihood_max
    ? LIKELIHOOD.slice(LIKELIHOOD.indexOf(p.likelihood_min), LIKELIHOOD.indexOf(p.likelihood_max) + 1)
    : [];
  const sMin = f.expected_size_min !== null && h.expected_size_min !== null ? f.expected_size_min - h.expected_size_min : null;
  const sMax = f.expected_size_max !== null && h.expected_size_max !== null ? f.expected_size_max - h.expected_size_max : null;
  const fSizes = sizeClasses(f.expected_size_min, f.expected_size_max);
  const hSizes = sizeClasses(h.expected_size_min, h.expected_size_max);
  return {
    likelihoodMinSteps: lMin,
    likelihoodMaxSteps: lMax,
    likelihoodOverlap: span(f).length && span(h).length ? jaccard(span(f), span(h)) : null,
    likelihoodDirection: direction(lMin === null || lMax === null ? null : Math.min(lMin, lMax), lMin === null || lMax === null ? null : Math.max(lMin, lMax)),
    sensitivitySteps: stepDiff(SENSITIVITY, f.sensitivity, h.sensitivity),
    distributionSteps: stepDiff(DISTRIBUTION, f.distribution, h.distribution),
    sizeMinDifference: sMin,
    sizeMaxDifference: sMax,
    sizeOverlap: fSizes.length && hSizes.length ? jaccard(fSizes, hSizes) : null,
    sizeDirection: direction(sMin === null || sMax === null ? null : Math.min(sMin, sMax), sMin === null || sMax === null ? null : Math.max(sMin, sMax)),
  };
}
