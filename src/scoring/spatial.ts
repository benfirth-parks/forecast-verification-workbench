// Spatial-distribution agreement: aspect sectors, elevation bands, the
// combined aspect×band "rose" cells, and continuous elevation ranges.
import type { AvalancheProblem } from "../domain/types";
import { ASPECTS, type Aspect, type ElevationBand } from "../domain/vocab";
import { jaccard } from "./common";

export const SPATIAL_METHOD_VERSION = "spatial-v1";

export function cellsOf(p: AvalancheProblem): Set<string> {
  if (p.cells && p.cells.length) return new Set(p.cells);
  const out = new Set<string>();
  for (const a of p.aspects) for (const b of p.elevation_bands) out.add(`${a}:${b}`);
  return out;
}
const aspectsOf = (p: AvalancheProblem) => new Set<Aspect>(p.cells?.length ? p.cells.map((c) => c.split(":")[0] as Aspect) : p.aspects);
const bandsOf = (p: AvalancheProblem) => new Set<ElevationBand>(p.cells?.length ? p.cells.map((c) => c.split(":")[1] as ElevationBand) : p.elevation_bands);

/** Continuous elevation-range overlap: |intersection| / |union| in metres. */
export function elevationRangeOverlap(
  a: [number | null, number | null], b: [number | null, number | null],
): number | null {
  if (a.some((x) => x === null) || b.some((x) => x === null)) return null;
  const [a0, a1] = [Math.min(a[0]!, a[1]!), Math.max(a[0]!, a[1]!)];
  const [b0, b1] = [Math.min(b[0]!, b[1]!), Math.max(b[0]!, b[1]!)];
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const union = Math.max(a1, b1) - Math.min(a0, b0);
  if (union === 0) return a0 === b0 ? 1 : 0;
  return inter / union;
}

/**
 * Overlap of two clockwise aspect arcs given in degrees, e.g. {from: 315, to: 45}
 * is NW→N→NE and crosses 0°. Returns Jaccard over arc length.
 */
export function aspectArcOverlap(a: { from: number; to: number }, b: { from: number; to: number }): number {
  const segs = (arc: { from: number; to: number }): [number, number][] => {
    const f = ((arc.from % 360) + 360) % 360, t = ((arc.to % 360) + 360) % 360;
    if (f === t) return [[0, 360]];
    return f < t ? [[f, t]] : [[f, 360], [0, t]];
  };
  const len = (s: [number, number][]) => s.reduce((x, [p, q]) => x + (q - p), 0);
  const A = segs(a), B = segs(b);
  let inter = 0;
  for (const [p, q] of A) for (const [r, s] of B) inter += Math.max(0, Math.min(q, s) - Math.max(p, r));
  const union = len(A) + len(B) - inter;
  return union === 0 ? 0 : inter / union;
}

/** Convert a set of 45° sectors into covered degrees (for display / cross-checks). */
export function sectorsToDegrees(aspects: Aspect[]): number {
  return new Set(aspects.filter((a) => ASPECTS.includes(a))).size * 45;
}

export interface SpatialComparison {
  method: string;
  aspectOverlap: number | null;
  elevationBandOverlap: number | null;
  combinedOverlap: number | null;
  elevationRangeOverlap: number | null;
  forecastOnlyCells: string[];
  hindsightOnlyCells: string[];
}

export function compareSpatial(forecast: AvalancheProblem, hindsight: AvalancheProblem): SpatialComparison {
  const fc = cellsOf(forecast), hc = cellsOf(hindsight);
  return {
    method: SPATIAL_METHOD_VERSION,
    aspectOverlap: jaccard(aspectsOf(forecast), aspectsOf(hindsight)),
    elevationBandOverlap: jaccard(bandsOf(forecast), bandsOf(hindsight)),
    combinedOverlap: jaccard(fc, hc),
    elevationRangeOverlap: elevationRangeOverlap(
      [forecast.minimum_elevation_m, forecast.maximum_elevation_m],
      [hindsight.minimum_elevation_m, hindsight.maximum_elevation_m],
    ),
    forecastOnlyCells: [...fc].filter((c) => !hc.has(c)).sort(),
    hindsightOnlyCells: [...hc].filter((c) => !fc.has(c)).sort(),
  };
}
