// Morning meeting entry: the team's morning hazard assessment, frozen on
// submit, plus the afternoon nowcast for the same day. Each submission is a
// new immutable version; corrections create an amendment, never an edit.
import { useState } from "react";
import { localDate } from "../../domain/time";
import type { Role } from "../../domain/vocab";
import { api } from "../api";
import { AssessmentEditor, emptyDraft, ErrorText, type AssessmentDraft } from "../components/assessment";
import { navigate } from "../router";

const ZONE = "America/Edmonton";
// Station tabs used by the winter meeting HS Sheet; free text is also accepted.
const STATIONS = ["Bosworth Lower", "Bow Summit", "Simpson Lower", "Stanley Lower", "Sunshine"];
const VARIABLES = [["hn24", "cm"], ["hw24", "mm"], ["wind_speed_max", "km/h"], ["air_temp_max", "°C"], ["freezing_level", "m"], ["precip_24", "mm"]] as const;

interface WeatherRow { variable: string; unit: string; location_reference: string; expected_min: string; expected_max: string }

export function MorningMeeting({ role, query }: { role: Role; query: URLSearchParams }) {
  const tab = query.get("tab") === "nowcast" ? "nowcast" : "morning";
  const [date, setDate] = useState(query.get("date") ?? localDate(new Date().toISOString(), ZONE));
  const [draft, setDraft] = useState<AssessmentDraft>(emptyDraft);
  const [weather, setWeather] = useState<WeatherRow[]>([{ variable: "hn24", unit: "cm", location_reference: STATIONS[0], expected_min: "", expected_max: "" }]);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const canEnter = role === "reviewer" || role === "administrator";
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <section className="max-w-3xl">
      <h1 className="mb-1 text-lg font-semibold">Morning meeting</h1>
      <p className="mb-3 text-sm text-slate-700">Record the morning hazard assessment before the field day, and the afternoon nowcast after it. Both are stored as issued and compared later against an independent hindsight review.</p>
      <div className="mb-3 flex gap-2" role="tablist">
        {(["morning", "nowcast"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? "btn-primary" : ""}`} onClick={() => { setDone(null); navigate("/morning", { tab: t, date }); }}>
            {t === "morning" ? "Morning assessment" : "Afternoon nowcast"}</button>
        ))}
      </div>
      {!canEnter && <p className="card text-sm">Your role can view but not enter assessments.</p>}
      {canEnter && (
        <form className="card space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const body = { date, issued_at: new Date().toISOString(), ...draft };
            if (tab === "morning") {
              const w = weather.filter((x) => x.expected_min !== "" || x.expected_max !== "").map((x) => ({ ...x, expected_min: num(x.expected_min), expected_max: num(x.expected_max) }));
              const r = await api<{ amended: boolean }>("/morning", { method: "POST", body: { ...body, weather: w } });
              setDone(r.amended ? "Saved as an amendment. The first version stays the one under review." : "Morning assessment saved and frozen. A review case was created.");
            } else {
              await api("/nowcast", { method: "POST", body });
              setDone("Afternoon nowcast saved.");
            }
            setDraft(emptyDraft());
          } catch (err) { setError(err); }
        }}>
          <label className="block"><span className="label">Date</span><input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <AssessmentEditor idPrefix={tab} value={draft} onChange={setDraft} />
          {tab === "morning" && (
            <fieldset>
              <legend className="label">Expected weather (next 24 h)</legend>
              <datalist id="stations">{STATIONS.map((s) => <option key={s} value={s} />)}</datalist>
              {weather.map((w, i) => (
                <div key={i} className="mt-1 flex flex-wrap items-end gap-2">
                  <label><span className="sr-only">Variable</span>
                    <select className="input" value={w.variable} onChange={(e) => { const v = VARIABLES.find(([k]) => k === e.target.value)!; setWeather(weather.map((x, j) => (j === i ? { ...x, variable: v[0], unit: v[1] } : x))); }}>
                      {VARIABLES.map(([k]) => <option key={k} value={k}>{k}</option>)}
                    </select></label>
                  <label><span className="sr-only">Station</span><input className="input" list="stations" value={w.location_reference} onChange={(e) => setWeather(weather.map((x, j) => (j === i ? { ...x, location_reference: e.target.value } : x)))} /></label>
                  <label><span className="sr-only">Minimum</span><input className="input w-20" inputMode="decimal" placeholder="min" value={w.expected_min} onChange={(e) => setWeather(weather.map((x, j) => (j === i ? { ...x, expected_min: e.target.value } : x)))} /></label>
                  <label><span className="sr-only">Maximum</span><input className="input w-20" inputMode="decimal" placeholder="max" value={w.expected_max} onChange={(e) => setWeather(weather.map((x, j) => (j === i ? { ...x, expected_max: e.target.value } : x)))} /></label>
                  <span className="text-sm">{w.unit}</span>
                  <button type="button" className="btn" onClick={() => setWeather(weather.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
              <button type="button" className="btn mt-2" onClick={() => setWeather([...weather, { variable: "hn24", unit: "cm", location_reference: STATIONS[0], expected_min: "", expected_max: "" }])}>Add weather expectation</button>
            </fieldset>
          )}
          <ErrorText error={error} />
          {done && <p role="status" className="rounded border border-green-700 bg-green-50 p-2 text-sm">{done}</p>}
          <button className="btn btn-primary" type="submit">{tab === "morning" ? "Submit morning assessment" : "Submit afternoon nowcast"}</button>
        </form>
      )}
    </section>
  );
}
