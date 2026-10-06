# Deployment

Not deployed. Steps once a private repo and a Supabase project exist: see README → Deployment. Preview deploys may
use `WORKBENCH_AUTH=dev` with a non-production database; production requires Supabase Auth and `application_users` rows.
The bulletin snapshot function needs both the `bulletin_snapshot_schedule` feature flag and a `schedule` added to its config.
