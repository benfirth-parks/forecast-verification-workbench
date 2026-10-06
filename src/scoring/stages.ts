// How the hazard call for one valid day moved through the day's stages:
// the public bulletin issued at 17:00 the evening before, the morning
// meeting, the afternoon meeting, and (later) the hindsight review.
//
// These are descriptive changes between the team's own calls, not forecast
// errors. Only the hindsight review is treated as the reference, and only
// for the "toward hindsight" counts.
import type { HazardAssessment } from "../domain/types";
import { ELEVATION_BANDS, PROBLEM_TYPES, type DangerLevel, type ElevationBand, type ProblemType } from "../domain/vocab";
import { rate, type Rate } from "./common";
import { matchProblems, type SynonymGroups } from "./problems";

export const STAGES = ["bulletin", "morning", "afternoon", "hindsight"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  bulletin: "Public bulletin",
  morning: "Morning meeting",
  afternoon: "Afternoon meeting",
  hindsight: "Hindsight review",
};

/** The transitions summarized across a season. */
export const TRANSITIONS = [["bulletin", "morning"], ["morning", "afternoon"]] as const satisfies readonly (readonly [Stage, Stage])[];
export type Transition = (typeof TRANSITIONS)[number];

export type DayStages = Partial<Record<Stage, HazardAssessment>>;

export interface BandChange {
  from: DangerLevel | null;
  to: DangerLevel | null;
  /** to − from; null unless both stages gave a numeric rating. */
  delta: number | null;
}

export interface StageChange {
  from: Stage;
  to: Stage;
  bands: Record<ElevationBand, BandChange>;
  problemsAdded: ProblemType[];
  problemsRemoved: ProblemType[];
  problemsKept: ProblemType[];
  /** Any rating or problem-set change. */
  changed: boolean;
}

const level = (a: HazardAssessment, b: ElevationBand): DangerLevel | null => {
  const c = a.ratings[b];
  return c?.kind === "rated" ? c.level : null;
};

export function compareStages(from: Stage, to: Stage, a: HazardAssessment, b: HazardAssessment, synonyms: SynonymGroups = []): StageChange {
  const bands = Object.fromEntries(ELEVATION_BANDS.map((band) => {
    const f = level(a, band), t = level(b, band);
    return [band, { from: f, to: t, delta: f !== null && t !== null ? t - f : null }];
  })) as Record<ElevationBand, BandChange>;
  const m = matchProblems(a.problems, b.problems, synonyms);
  const problemsAdded = m.missed, problemsRemoved = m.unsupported;
  return {
    from, to, bands, problemsAdded, problemsRemoved, problemsKept: m.truePositives,
    changed: Object.values(bands).some((x) => x.delta !== null && x.delta !== 0) || problemsAdded.length > 0 || problemsRemoved.length > 0,
  };
}

/** Changes between consecutive stages that exist for the day, in stage order. */
export function dayChanges(day: DayStages, synonyms: SynonymGroups = []): StageChange[] {
  const present = STAGES.filter((s) => day[s]);
  const out: StageChange[] = [];
  for (let i = 1; i < present.length; i++) out.push(compareStages(present[i - 1], present[i], day[present[i - 1]]!, day[present[i]]!, synonyms));
  return out;
}

export interface BandTransitionSummary {
  /** Days where both stages rated this band. */
  compared: number;
  raised: Rate;
  lowered: Rate;
  unchanged: Rate;
  /** Of the changed days with a final hindsight rating: moved closer to it / further from it. */
  towardHindsight: Rate;
  awayFromHindsight: Rate;
}

export interface TransitionSummary {
  from: Stage;
  to: Stage;
  /** Days that have both stages. */
  days: number;
  daysChanged: Rate;
  bands: Record<ElevationBand, BandTransitionSummary>;
  /** Problem type → days the later stage added / removed it. */
  problemsAdded: Partial<Record<ProblemType, number>>;
  problemsRemoved: Partial<Record<ProblemType, number>>;
  /** Of the added problems on days with a final hindsight: how many the hindsight kept. */
  addedConfirmed: Rate;
  /** Of the removed problems on days with a final hindsight: how many the hindsight also left out. */
  removedConfirmed: Rate;
  dates: { changed: string[] };
}

export interface StageDay { date: string; stages: DayStages; /** Only a final hindsight counts as the reference. */ hindsightFinal: boolean }

export function summarizeTransitions(days: StageDay[], synonyms: SynonymGroups = []): TransitionSummary[] {
  return TRANSITIONS.map(([from, to]) => {
    const pairs = days.filter((d) => d.stages[from] && d.stages[to]);
    const changes = pairs.map((d) => ({ d, c: compareStages(from, to, d.stages[from]!, d.stages[to]!, synonyms) }));
    const bands = Object.fromEntries(ELEVATION_BANDS.map((band) => {
      let compared = 0, raised = 0, lowered = 0, toward = 0, away = 0, changedWithRef = 0;
      for (const { d, c } of changes) {
        const x = c.bands[band];
        if (x.delta === null) continue;
        compared++;
        if (x.delta > 0) raised++;
        if (x.delta < 0) lowered++;
        const h = d.hindsightFinal && d.stages.hindsight ? level(d.stages.hindsight, band) : null;
        if (x.delta !== 0 && h !== null) {
          changedWithRef++;
          const before = Math.abs(x.from! - h), after = Math.abs(x.to! - h);
          if (after < before) toward++;
          if (after > before) away++;
        }
      }
      return [band, {
        compared, raised: rate(raised, compared), lowered: rate(lowered, compared), unchanged: rate(compared - raised - lowered, compared),
        towardHindsight: rate(toward, changedWithRef), awayFromHindsight: rate(away, changedWithRef),
      }];
    })) as Record<ElevationBand, BandTransitionSummary>;
    const problemsAdded: Partial<Record<ProblemType, number>> = {}, problemsRemoved: Partial<Record<ProblemType, number>> = {};
    let added = 0, addedKept = 0, removed = 0, removedAbsent = 0;
    for (const { d, c } of changes) {
      for (const t of c.problemsAdded) problemsAdded[t] = (problemsAdded[t] ?? 0) + 1;
      for (const t of c.problemsRemoved) problemsRemoved[t] = (problemsRemoved[t] ?? 0) + 1;
      if (!d.hindsightFinal || !d.stages.hindsight) continue;
      const ref = matchProblems(d.stages[to]!.problems, d.stages.hindsight.problems, synonyms);
      const refPrior = matchProblems(d.stages[from]!.problems, d.stages.hindsight.problems, synonyms);
      added += c.problemsAdded.length;
      addedKept += c.problemsAdded.filter((t) => ref.truePositives.includes(t)).length;
      removed += c.problemsRemoved.length;
      removedAbsent += c.problemsRemoved.filter((t) => refPrior.unsupported.includes(t)).length;
    }
    const changedDates = changes.filter((x) => x.c.changed).map((x) => x.d.date);
    return {
      from, to, days: pairs.length, daysChanged: rate(changedDates.length, pairs.length), bands,
      problemsAdded: sortCounts(problemsAdded), problemsRemoved: sortCounts(problemsRemoved),
      addedConfirmed: rate(addedKept, added), removedConfirmed: rate(removedAbsent, removed),
      dates: { changed: changedDates },
    };
  });
}

const sortCounts = (m: Partial<Record<ProblemType, number>>) =>
  Object.fromEntries(PROBLEM_TYPES.filter((t) => m[t]).map((t) => [t, m[t]!])) as Partial<Record<ProblemType, number>>;
