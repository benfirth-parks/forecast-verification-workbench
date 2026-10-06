// Browser API client. Holds no secrets: production uses the signed-in user's
// Supabase access token; local development uses a chosen development role.
import type { Role } from "../domain/vocab";

const DEV_KEY = "fvw:dev-role";
let token: string | null = null;
export const setAccessToken = (t: string | null) => { token = t; };
export const devRole = (): Role | null => { try { return (localStorage.getItem(DEV_KEY) as Role) || null; } catch { return null; } };
export const setDevRole = (r: Role | null) => { try { if (r) localStorage.setItem(DEV_KEY, r); else localStorage.removeItem(DEV_KEY); } catch { /* storage unavailable */ } };
export const isDevAuth = () => !import.meta.env.VITE_SUPABASE_URL;

export class ApiError extends Error {
  constructor(message: string, public status: number, public issues?: { path: string; message: string }[]) { super(message); }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const role = devRole();
  if (isDevAuth() && role) headers["x-dev-role"] = role;
  const res = await fetch(`/api/v1${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status, (data as { issues?: { path: string; message: string }[] }).issues);
  return data as T;
}
