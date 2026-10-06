// Netlify Function: all /api/v1/* routes. Secrets stay server-side.
import type { Config } from "@netlify/functions";
import { handle } from "../../src/server/api";
import { devAuthenticator, supabaseAuthenticator } from "../../src/server/auth";
import { fromPgPool, type Db } from "../../src/server/db";

let db: Promise<Db> | null = null;

export default async (req: Request) => {
  const url = process.env.DATABASE_URL;
  if (!url) return new Response(JSON.stringify({ error: "DATABASE_URL is not configured" }), { status: 503 });
  db ??= fromPgPool(url, process.env.DATABASE_CA_CERT);
  const conn = await db;
  const authenticate = process.env.WORKBENCH_AUTH === "dev" && process.env.CONTEXT !== "production"
    ? devAuthenticator()
    : supabaseAuthenticator(conn, process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SECRET_KEY ?? "");
  return handle(req, { db: conn, authenticate, commit: process.env.COMMIT_REF });
};

export const config: Config = { path: "/api/v1/*" };
