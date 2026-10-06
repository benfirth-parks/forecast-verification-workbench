// Time-zone helpers. Storage is UTC; local days are computed with an explicit
// IANA zone, never the browser's or server's local zone.

export const DEFAULT_ZONE = "America/Edmonton";

function offsetMs(ts: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ts;
}

export class AmbiguousLocalTimeError extends Error {}

/**
 * Alberta moved to permanent UTC−6 ("Alberta Time") in November 2026 (IANA tzdata 2026c).
 * A runtime with older tz data puts every Alberta local time and day boundary from then on one hour off.
 */
export function zoneDataPredatesAlbertaTime(): boolean {
  return offsetMs(Date.parse("2027-01-15T12:00:00Z"), "America/Edmonton") !== -6 * 36e5;
}

/**
 * Wall-clock date/time in `zone` → UTC ISO string.
 * Throws for a non-existent local time (spring-forward gap). For a repeated
 * local time (fall-back overlap) `onAmbiguous` decides; the default throws so
 * importers report it instead of guessing.
 */
export function zonedToUtc(
  date: string, time: string, zone: string,
  onAmbiguous: "throw" | "earlier" | "later" = "throw",
): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
  const candidates = new Set<number>();
  for (const probe of [wall - 36e5 * 14, wall, wall + 36e5 * 14]) {
    const ts = wall - offsetMs(probe, zone);
    if (ts + offsetMs(ts, zone) === wall) candidates.add(ts);
  }
  const list = [...candidates].sort((a, b) => a - b);
  if (list.length === 0) throw new AmbiguousLocalTimeError(`${date} ${time} does not exist in ${zone}`);
  if (list.length > 1) {
    if (onAmbiguous === "throw") throw new AmbiguousLocalTimeError(`${date} ${time} occurs twice in ${zone}`);
    return new Date(onAmbiguous === "earlier" ? list[0] : list[list.length - 1]).toISOString();
  }
  return new Date(list[0]).toISOString();
}

/** UTC instant → local calendar date in `zone`. */
export function localDate(isoUtc: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(isoUtc));
}

/** UTC instant → "YYYY-MM-DD HH:mm" local, with zone abbreviation. */
export function formatLocal(isoUtc: string, zone: string): string {
  const d = new Date(isoUtc);
  const date = localDate(isoUtc, zone);
  const time = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(d);
  return `${date} ${time}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
}

/** [start, end) of a local calendar day, in UTC. Handles 23- and 25-hour days. */
export function localDayBounds(date: string, zone: string): { start: string; end: string } {
  return { start: zonedToUtc(date, "00:00", zone, "earlier"), end: zonedToUtc(addDays(date, 1), "00:00", zone, "earlier") };
}
