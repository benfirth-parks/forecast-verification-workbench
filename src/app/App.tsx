import { useEffect, useState } from "react";
import { zoneDataPredatesAlbertaTime } from "../domain/time";
import { ROLES, type Role } from "../domain/vocab";
import { api, devRole, isDevAuth, setAccessToken, setDevRole } from "./api";
import { useRoute } from "./router";
import { TodayReview } from "./pages/TodayReview";
import { CasePage } from "./pages/CasePage";
import { MorningMeeting } from "./pages/MorningMeeting";
import { Analytics } from "./pages/Analytics";
import { Imports } from "./pages/Imports";

const NAV: [string, string][] = [["/today-review", "Review queue"], ["/morning", "Daily meetings"], ["/analytics", "Analytics"], ["/imports", "Imports"]];

export function App() {
  const [me, setMe] = useState<{ id: string; role: Role; zone_data_outdated?: boolean } | null>(null);
  const [checked, setChecked] = useState(false);
  const route = useRoute();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isDevAuth()) {
        const { createClient } = await import("@supabase/supabase-js");
        const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
        const { data } = await sb.auth.getSession();
        setAccessToken(data.session?.access_token ?? null);
        sb.auth.onAuthStateChange((_e, s) => setAccessToken(s?.access_token ?? null));
      }
      try { const m = await api<{ id: string; role: Role; zone_data_outdated?: boolean }>("/me"); if (!cancelled) setMe(m); } catch { /* not signed in */ }
      if (!cancelled) setChecked(true);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!checked) return <p className="p-4">Loading…</p>;
  if (!me) return <SignIn onSignedIn={setMe} />;
  const page = route.path.startsWith("/case/") ? <CasePage id={route.path.slice(6)} role={me.role} />
    : route.path === "/morning" ? <MorningMeeting role={me.role} query={route.query} />
    : route.path === "/analytics" ? <Analytics query={route.query} />
    : route.path === "/imports" ? <Imports role={me.role} />
    : <TodayReview query={route.query} />;
  return (
    <div className="min-h-screen">
      <div className="bg-amber-200 px-4 py-1 text-center text-xs font-semibold text-amber-950" role="note">
        RESEARCH PROTOTYPE · retrospective learning use only · not an operational forecast or a personnel evaluation
      </div>
      <ZoneDataWarning server={Boolean(me.zone_data_outdated)} />
      <nav className="flex flex-wrap items-center gap-4 border-b border-slate-300 bg-white px-4 py-2">
        <span className="font-semibold">Forecast Verification Workbench</span>
        {NAV.map(([p, l]) => <a key={p} href={`#${p}`} className={`text-sm ${route.path === p ? "font-semibold underline" : "text-blue-800 hover:underline"}`}>{l}</a>)}
        <span className="ml-auto text-xs text-slate-600">Signed in as <strong>{me.role}</strong>{isDevAuth() ? " (development)" : ""}</span>
        <button className="btn" onClick={() => { setDevRole(null); setAccessToken(null); setMe(null); }}>Sign out</button>
      </nav>
      <main className="p-4">{page}</main>
    </div>
  );
}

/** Alberta's permanent UTC−6 change (November 2026) needs tz data 2026c or later on the server and in the browser. */
function ZoneDataWarning({ server }: { server: boolean }) {
  const browser = zoneDataPredatesAlbertaTime();
  if (!server && !browser) return null;
  const where = server && browser ? "the server and this browser" : server ? "the server" : "this browser";
  return (
    <div className="border-b border-red-700 bg-red-50 px-4 py-1 text-center text-xs text-red-900" role="alert">
      Time-zone data on {where} predates Alberta's permanent UTC−6 change (November 2026). Local times and day boundaries from then on will be one hour off until it is updated.
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (m: { id: string; role: Role }) => void }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (isDevAuth()) {
    return (
      <div className="mx-auto mt-16 max-w-sm card">
        <h1 className="h2">Development sign-in</h1>
        <p className="mb-3 text-sm text-slate-700">Local database only. Choose a role to test permissions.</p>
        <div className="flex flex-wrap gap-2">
          {ROLES.map((r) => (
            <button key={r} className="btn" onClick={async () => {
              setDevRole(r);
              try { onSignedIn(await api("/me")); } catch (e) { setError((e as Error).message); }
            }}>{r}</button>
          ))}
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}</p>}
        {devRole() && <p className="mt-2 text-xs">Last role: {devRole()}</p>}
      </div>
    );
  }
  return (
    <form className="mx-auto mt-16 max-w-sm card" onSubmit={async (e) => {
      e.preventDefault();
      const { createClient } = await import("@supabase/supabase-js");
      const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
      if (error) setError(error.message); else setSent(true);
    }}>
      <h1 className="h2">Sign in</h1>
      <label className="block"><span className="label">Work email</span>
        <input className="input w-full" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <button className="btn btn-primary mt-3" type="submit">Email me a sign-in link</button>
      {sent && <p className="mt-2 text-sm">Check your email for the link.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-800">{error}</p>}
    </form>
  );
}
