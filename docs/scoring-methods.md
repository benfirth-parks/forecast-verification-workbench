# Scoring methods

Scoring version `v1-draft` (`src/scoring/case.ts`, `DEFAULT_SCORING_CONFIG`). A scoring version is identified by the
SHA-256 of its canonical JSON configuration; changing any rule creates a new `scoring_versions` row and new
`verification_scores` rows. Old results are never replaced. There is no master accuracy score.

**Eligibility (all case-level metrics):** final hindsight assessment **and** evidence class `observed_positive` or
`supported_negative`. Excluded cases are counted by reason and shown beside every table.

Signed differences are always **forecast − hindsight** (positive = forecast higher).

| Metric | Inputs | Method | Notes / limitations |
| --- | --- | --- | --- |
| Exact agreement, within one | rated band pairs | share of pairs with \|error\| = 0, ≤ 1 | Non-rated states (early season, no rating, missing) are excluded per band, never treated as Low. |
| Signed / absolute ordinal error, MAE | rated band pairs | f − h; mean of \|f − h\| | Danger levels are ordinal; MAE is a convenience summary. |
| Over/underforecast rate | rated band pairs | share with f > h, f < h | |
| Confusion matrix | rated band pairs | 5×5 counts, forecast rows × hindsight columns | |
| Weighted Cohen's κ | confusion matrix | quadratic weights (i−j)²/(k−1)² | Withheld below 30 pairs (configurable). |
| Problem precision / recall / F1 | problem type sets | TP/forecast, TP/hindsight, harmonic mean | Exact type match. Synonym groups only if a scoring version names them. |
| Primary problem correct | rank 1 on each side | equality | null if either side has none. |
| Missed / unsupported problems | sets | H∖F, F∖H | |
| Aspect, band, combined overlap | matched problems | Jaccard over 8 sectors, 3 bands, aspect×band cells | Discrete sectors, so north is not special. |
| Aspect arc overlap | degree arcs | Jaccard over arc length, arcs split at 0° | For sources with continuous aspect ranges; tested across north. |
| Elevation range overlap | metre ranges | \|∩\| / \|∪\| | null if any bound missing. |
| Likelihood / sensitivity / distribution steps | matched problems | difference in category index | Steps are **not** assumed evenly spaced; means of steps are labelled as such. |
| Likelihood overlap | category ranges | Jaccard over covered categories | |
| Size min/max difference, overlap, direction | matched problems | numeric difference; Jaccard over half-size classes | |
| Weather bias, MAE | expectation vs observation | point forecast = stated value or range midpoint | Observation = last reading for that station and variable in the day + 12 h. |
| Range coverage | ranged expectations | share of observations inside [min, max] | |
| Threshold agreement | point forecast, obs | 2×2 table at a threshold (HN24 ≥ 20 cm default) | |
| Peirce skill score | 2×2 table | POD − POFD | For supported binary event sets only. |
| Timing error | forecast vs observed start/end/peak | hours, forecast − observed | Function available; inputs not yet captured. |

## Screening for systematic misses

Flags (`src/scoring/misses.ts`) appear when, among included cases:
- a band's over- or underforecast rate ≥ 25 % with ≥ 10 pairs;
- a problem type is missed, or forecast but unsupported, in ≥ 25 % of its occurrences with ≥ 10 occurrences;
- among ≥ 10 matched pairs of a type, mean size, likelihood or sensitivity difference ≥ 0.5 steps, or mean aspect×elevation overlap < 50 %.

These thresholds are part of the scoring version. A flag is a prompt to review the listed cases, not a finding.

## Version history
- `v1-draft` (2026-10-06): initial metrics and evidence rule `evidence-v1-draft`.
