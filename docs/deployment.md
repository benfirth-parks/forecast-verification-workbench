# Deployment

Not deployed. Steps once a private repo and a Supabase project exist: see README → Deployment. Preview deploys may
use `WORKBENCH_AUTH=dev` with a non-production database; production requires Supabase Auth and `application_users` rows.
The bulletin snapshot function needs both the `bulletin_snapshot_schedule` feature flag and a `schedule` added to its config.

## Time-zone data

Alberta moved to permanent UTC−6 ("Alberta Time") in November 2026, published in IANA tzdata 2026c. The workbench
computes every local time and day boundary with the `America/Edmonton` zone, so the Netlify Functions runtime and
reviewers' browsers need tz data 2026c or later (check with `node -p process.versions.tz`). With older data, times
from November 2026 on are one hour off; the app shows a red banner and imports carry an `outdated_zone_data` warning.

