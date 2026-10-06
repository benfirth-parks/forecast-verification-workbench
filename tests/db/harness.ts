import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../../src/server/local-db";

export async function freshDb() {
  return openLocalDb();
}

/** Run `fn` as an authenticated user with the given id (RLS applies). */
export async function asUser<T>(pg: PGlite, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);`);
  try { return await fn(); } finally { await pg.exec("reset role; select set_config('request.jwt.claim.sub', '', false);"); }
}
