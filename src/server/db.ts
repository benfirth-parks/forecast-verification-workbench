// Thin SQL interface shared by production (node-postgres against Supabase's
// pooled connection) and local dev / tests (PGlite, an embedded Postgres that
// runs the same migrations, triggers and constraints).
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

interface PgLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function fromPglite(pg: PgLike & { transaction<T>(fn: (tx: PgLike) => Promise<T>): Promise<T> }): Db {
  const wrap = (q: PgLike): Db => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await q.query(sql, params)).rows as T[] }),
    tx: (fn) => (q === pg ? pg.transaction((t) => fn(wrap(t))) : fn(wrap(q))),
  });
  return wrap(pg);
}

/** `caCert`: Supabase's database CA (Settings → Database → SSL). TLS is always verified. */
export async function fromPgPool(connectionString: string, caCert?: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 3, ssl: caCert ? { ca: caCert, rejectUnauthorized: true } : { rejectUnauthorized: true } });
  const wrapClient = (c: PgLike): Db => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await c.query(sql, params)).rows as T[] }),
    tx: (fn) => fn(wrapClient(c)),
  });
  return {
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrapClient(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
