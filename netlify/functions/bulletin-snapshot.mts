// Captures the avalanche.ca BYK product so each bulletin is frozen as issued.
// avalanche.ca updates products in place; without a capture near issue time
// the original wording and ratings are lost.
//
// DISABLED until approved (Phase 4): it runs only when the feature flag
// `bulletin_snapshot_schedule` is enabled in the database. To schedule it,
// add `schedule: "*/30 * * * *"` to the config below after approval.
import type { Config } from "@netlify/functions";
import { importAvcanProducts } from "../../src/importers/avcan-bulletin";
import { fromPgPool } from "../../src/server/db";
import * as repo from "../../src/server/repo";

const PRODUCTS = "https://api.avalanche.ca/forecasts/en/products";
const SYSTEM_ACTOR = { id: "00000000-0000-4000-8000-0000000000aa", role: "administrator" };

export default async () => {
  const url = process.env.DATABASE_URL;
  if (!url) return new Response("DATABASE_URL missing", { status: 503 });
  const db = await fromPgPool(url, process.env.DATABASE_CA_CERT);
  const flag = await db.query<{ enabled: boolean }>("select enabled from feature_flags where key='bulletin_snapshot_schedule'");
  if (!flag.rows[0]?.enabled) return new Response("snapshot disabled by feature flag", { status: 200 });
  const res = await fetch(PRODUCTS, { headers: { accept: "application/json" } });
  if (!res.ok) return new Response(`avalanche.ca returned ${res.status}`, { status: 502 });
  const payload = await res.json();
  const capturedAt = new Date().toISOString();
  return db.tx(async (tx) => {
    await repo.ensureDomain(tx);
    const dry = importAvcanProducts(payload, { domainCode: "BYK", capturedAt, importRunId: "pending" });
    const fresh = [];
    for (const b of dry.records) {
      const seen = await tx.query("select 1 from forecast_issuances where source_system=$1 and source_record_id=$2 and raw_payload_hash=$3",
        [b.issuance.source_system, b.issuance.source_record_id, b.issuance.raw_payload_hash]);
      if (!seen.rows.length) fresh.push(b);
    }
    if (!fresh.length && !dry.summary.errors) return new Response("no new bulletin versions", { status: 200 });
    const runId = await repo.recordImportRun(tx, dry, SYSTEM_ACTOR, { dryRun: false, fileName: PRODUCTS });
    const result = importAvcanProducts(payload, { domainCode: "BYK", capturedAt, importRunId: runId });
    const summary = await repo.commitBulletins(tx, result, SYSTEM_ACTOR, runId);
    await repo.audit(tx, null, "import.snapshot", "import_run", runId, { ...summary });
    return new Response(JSON.stringify(summary), { status: 200 });
  });
};

export const config: Config = {};
