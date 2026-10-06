// Authentication and role checks. Every API route requires a user; roles are
// checked here AND enforced again by row-level security for any direct access.
import { ROLES, type Role } from "../domain/vocab";
import type { Db } from "./db";
import type { Actor } from "./repo";

export class AuthError extends Error {
  constructor(message: string, public status: 401 | 403) { super(message); }
}

const RANK: Record<Role, number> = { viewer: 1, analyst: 2, reviewer: 3, administrator: 4 };
export const atLeast = (role: string, minimum: Role) => (RANK[role as Role] ?? 0) >= RANK[minimum];

export function requireRole(actor: Actor, minimum: Role) {
  if (!atLeast(actor.role, minimum)) throw new AuthError(`Requires ${minimum} role`, 403);
}

export interface Authenticator { (req: Request): Promise<Actor> }

/** Fixed ids for development sign-in. These users exist only in local databases. */
export const DEV_USERS: Record<Role, { id: string; code: string }> = {
  viewer: { id: "00000000-0000-4000-8000-000000000001", code: "DEV-V" },
  analyst: { id: "00000000-0000-4000-8000-000000000002", code: "DEV-A" },
  reviewer: { id: "00000000-0000-4000-8000-000000000003", code: "DEV-R" },
  administrator: { id: "00000000-0000-4000-8000-000000000004", code: "DEV-ADM" },
};

export async function seedDevUsers(db: Db) {
  for (const role of ROLES) {
    await db.query("insert into application_users (id, code, role) values ($1,$2,$3) on conflict (id) do nothing",
      [DEV_USERS[role].id, DEV_USERS[role].code, role]);
  }
}

/** Development only: `x-dev-role` header picks one of the DEV_USERS. Refuses to run in Netlify production. */
export function devAuthenticator(): Authenticator {
  if (process.env.CONTEXT === "production") throw new Error("Development sign-in is disabled in production");
  return async (req) => {
    const role = (req.headers.get("x-dev-role") ?? "") as Role;
    if (!ROLES.includes(role)) throw new AuthError("Sign in required", 401);
    return { id: DEV_USERS[role].id, role };
  };
}

/** Production: Supabase Auth access token → user id → role from application_users. */
export function supabaseAuthenticator(db: Db, supabaseUrl: string, secretKey: string): Authenticator {
  return async (req) => {
    const header = req.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new AuthError("Sign in required", 401);
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) throw new AuthError("Session expired; sign in again", 401);
    const r = await db.query<{ role: string }>("select role from application_users where id=$1 and active", [data.user.id]);
    if (!r.rows[0]) throw new AuthError("No workbench role assigned to this account", 403);
    return { id: data.user.id, role: r.rows[0].role };
  };
}
