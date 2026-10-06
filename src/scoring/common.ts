/** A proportion that always carries its numerator and denominator. */
export interface Rate {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0. */
  value: number | null;
}

export const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  value: denominator > 0 ? numerator / denominator : null,
});

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Jaccard index |A∩B| / |A∪B|; null when both sets are empty. */
export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number | null {
  const A = new Set(a), B = new Set(b);
  const union = new Set([...A, ...B]);
  if (union.size === 0) return null;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / union.size;
}

/** Deterministic JSON (sorted keys) for hashing scoring inputs and versions. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export type Direction = "over" | "under" | "match" | "mixed" | "not_comparable";
