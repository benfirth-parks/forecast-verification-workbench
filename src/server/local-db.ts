// Embedded Postgres for local development and tests. Runs the same SQL
// migrations as Supabase (except PostGIS) behind a stand-in `auth` schema.
// Data lives only on this machine; it is never synced anywhere.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDevUsers } from "./auth";
import { fromPglite, type Db } from "./db";
import { ensureDomain } from "./repo";

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

export const AUTH_STUB = `
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $f$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
`;

export async function openLocalDb(dataDir?: string) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const migrated = (await pg.query("select to_regclass('public.forecast_issuances') as t")).rows[0] as { t: string | null };
  if (!migrated.t) {
    await pg.exec(AUTH_STUB);
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !f.includes("postgis")).sort()) {
      await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    await pg.exec(`grant usage on schema public, auth to authenticated;
      grant select, insert, update, delete on all tables in schema public to authenticated;`);
  }
  const db: Db = fromPglite(pg as never);
  await seedDevUsers(db);
  await ensureDomain(db);
  return { pg, db };
}
