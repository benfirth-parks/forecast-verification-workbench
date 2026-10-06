# Test fixtures

| File | What it is |
| --- | --- |
| `avcan/byk-2026-10-01-live.json` | The real public avalanche.ca product for Parks BYK as served on 2026-10-06 (issued 2026-10-01, early-season, no problems). Public data. Transcribed through a fetch tool and abridged (weather summary and notification text shortened), so it is not byte-exact; replace with a direct capture once the snapshot job runs. |
| `avcan/SYNTHETIC-in-season.json` | **Synthetic.** Same shape with invented ratings and problems, to exercise parsing. Not a real bulletin; never import it into a shared database. |
| `avyfx/SYNTHETIC-feed.json` | **Synthetic.** Shape of the Parks Avy FX public feed (`feed?format=json`). |
| `csv/SYNTHETIC-*.csv` | **Synthetic** observation files covering valid rows and each validation error. |

No fixture contains Parks Canada operational records, staff names or locations from real incidents.
