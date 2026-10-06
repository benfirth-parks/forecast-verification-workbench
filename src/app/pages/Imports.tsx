// Imports: dry-run validation first, then commit of the same checksum.
import { useEffect, useState } from "react";
import type { Role } from "../../domain/vocab";
import { api } from "../api";
import { ErrorText } from "../components/assessment";

type Adapter = "avcan-bulletin" | "avyfx-feed" | "csv-observations";
interface Message { severity: string; code: string; message: string; row?: number; field?: string }
interface Validation { import_run_id: string; checksum: string; summary: Record<string, number>; messages: Message[]; already_committed: boolean; preview: unknown[] }

const MAPPING_TEMPLATE = JSON.stringify({
  target: "avalanche_event", source_system: "<your source system>", domain_code: "BYK", time_zone: "America/Edmonton", elevation_unit: "m",
  columns: { source_record_id: "ID", observed_at: "Date observed", occurred_from: "Occurred from", occurred_to: "Occurred to", observation_confidence: "Confidence",
    location_name: "Location", size: "Size", trigger_type: "Trigger", aspect: "Aspect", elevation_m: "Elevation", problem_type: "Problem" },
}, null, 2);

export function Imports({ role }: { role: Role }) {
  const [adapter, setAdapter] = useState<Adapter>("avcan-bulletin");
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [mapping, setMapping] = useState(MAPPING_TEMPLATE);
  const [capturedAt, setCapturedAt] = useState("");
  const [validation, setValidation] = useState<Validation | null>(null);
  const [committed, setCommitted] = useState<Record<string, unknown> | null>(null);
  const [runs, setRuns] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<unknown>(null);
  const isAdmin = role === "administrator";
  const loadRuns = () => { if (role !== "viewer" && role !== "reviewer") api<{ runs: Record<string, unknown>[] }>("/imports").then((r) => setRuns(r.runs)).catch(setError); };
  useEffect(loadRuns, [role]);

  const body = () => {
    const payload = adapter === "csv-observations" ? text : JSON.parse(text);
    return { adapter, file_name: fileName || "pasted", payload, mapping: adapter === "csv-observations" ? JSON.parse(mapping) : undefined, captured_at: capturedAt ? new Date(capturedAt).toISOString() : undefined };
  };
  return (
    <section className="space-y-3">
      <h1 className="text-lg font-semibold">Imports</h1>
      {!isAdmin ? <p className="card text-sm">Only administrators can import. You can view import history{role === "reviewer" || role === "viewer" ? " if you have analyst access" : ""}.</p> : (
        <div className="card space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <label><span className="label">Source</span>
              <select className="input" value={adapter} onChange={(e) => { setAdapter(e.target.value as Adapter); setValidation(null); setCommitted(null); }}>
                <option value="avcan-bulletin">avalanche.ca bulletin (JSON)</option>
                <option value="avyfx-feed">Parks Avy FX feed (JSON)</option>
                <option value="csv-observations">Observations (CSV)</option>
              </select></label>
            <label><span className="label">File</span>
              <input className="input" type="file" accept=".json,.csv,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setFileName(f.name); setText(await f.text()); setValidation(null); }} /></label>
            {adapter !== "csv-observations" && <label><span className="label">Captured at (if not now)</span><input className="input" type="datetime-local" value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} /></label>}
          </div>
          <label className="block"><span className="label">Payload</span><textarea className="input w-full font-mono text-xs" rows={6} value={text} onChange={(e) => { setText(e.target.value); setValidation(null); }} /></label>
          {adapter === "csv-observations" && <label className="block"><span className="label">Field mapping</span><textarea className="input w-full font-mono text-xs" rows={10} value={mapping} onChange={(e) => { setMapping(e.target.value); setValidation(null); }} /></label>}
          <div className="flex gap-2">
            <button className="btn" disabled={!text} onClick={async () => { setError(null); setCommitted(null); try { setValidation(await api<Validation>("/imports/validate", { method: "POST", body: body() })); loadRuns(); } catch (e) { setError(e); } }}>Validate (dry run)</button>
            <button className="btn btn-primary" disabled={!validation || validation.summary.accepted === 0} onClick={async () => { setError(null); try { setCommitted(await api("/imports/commit", { method: "POST", body: { ...body(), expected_checksum: validation!.checksum } })); loadRuns(); } catch (e) { setError(e); } }}>Commit</button>
          </div>
          <ErrorText error={error} />
          {validation && (
            <div className="text-sm">
              <p>Checksum <code className="text-xs">{validation.checksum.slice(0, 16)}…</code> · {Object.entries(validation.summary).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
              {validation.already_committed && <p className="text-amber-900">This exact payload was committed before. Committing again creates no duplicates.</p>}
              <table className="table mt-2"><thead><tr><th>Severity</th><th>Row</th><th>Field</th><th>Message</th></tr></thead><tbody>
                {validation.messages.map((m, i) => <tr key={i}><td>{m.severity}</td><td>{m.row ?? ""}</td><td className="text-xs">{m.field ?? ""}</td><td>{m.message}</td></tr>)}
              </tbody></table>
              <details className="mt-2"><summary className="cursor-pointer">Preview of normalized records ({validation.preview.length})</summary><pre className="max-h-72 overflow-auto text-xs">{JSON.stringify(validation.preview, null, 2)}</pre></details>
            </div>
          )}
          {committed && <p role="status" className="rounded border border-green-700 bg-green-50 p-2 text-sm">Committed: {["inserted", "duplicates", "amended", "casesCreated"].map((k) => `${k} ${committed[k]}`).join(" · ")}</p>}
        </div>
      )}
      {runs.length > 0 && (
        <div className="card overflow-x-auto">
          <h2 className="h2">Import history</h2>
          <table className="table"><thead><tr><th>When</th><th>Adapter</th><th>Source</th><th>Status</th><th>Summary</th><th></th></tr></thead><tbody>
            {runs.map((r) => <tr key={String(r.id)}><td className="whitespace-nowrap text-xs">{new Date(String(r.started_at)).toISOString().slice(0, 16)}Z</td><td>{String(r.adapter)}</td><td className="text-xs">{String(r.source_identifier)}</td>
              <td>{String(r.status)}{r.dry_run ? " (dry run)" : ""}</td><td className="text-xs">{JSON.stringify(r.summary)}</td>
              <td>{isAdmin && r.status === "committed" && <button className="btn" onClick={async () => { const reason = window.prompt("Why supersede this import? Its records will be excluded but kept."); if (!reason) return; try { await api(`/imports/${r.id}/supersede`, { method: "POST", body: { reason } }); loadRuns(); } catch (e) { setError(e); } }}>Supersede</button>}</td></tr>)}
          </tbody></table>
        </div>
      )}
    </section>
  );
}
