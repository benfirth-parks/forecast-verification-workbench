// Shared importer contract. Importers are pure: they validate and normalize a
// payload into canonical records plus row-level messages, and never write.
// Committing (idempotency, supersession, audit) is the repository's job.
import { createHash } from "node:crypto";
import { canonicalJson } from "../scoring/common";

export type Severity = "error" | "warning" | "info";

export interface ImportMessage {
  severity: Severity;
  code: string;
  message: string;
  row?: number;
  field?: string;
}

export interface ImportResult<T> {
  adapter: string;
  adapter_version: string;
  source_system: string;
  source_identifier: string;
  checksum: string;
  records: T[];
  /** Records rejected with at least one error (kept for the dry-run preview). */
  rejected: { row: number; raw: unknown }[];
  messages: ImportMessage[];
  summary: { accepted: number; rejected: number; errors: number; warnings: number; info: number };
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const payloadHash = (value: unknown) => sha256(canonicalJson(value));

export function finish<T>(
  base: Omit<ImportResult<T>, "summary">,
): ImportResult<T> {
  const count = (s: Severity) => base.messages.filter((m) => m.severity === s).length;
  return {
    ...base,
    summary: {
      accepted: base.records.length,
      rejected: base.rejected.length,
      errors: count("error"),
      warnings: count("warning"),
      info: count("info"),
    },
  };
}

/** Minimal HTML → text for narrative fields (never rendered as HTML). */
export function htmlToText(html: unknown): string {
  return String(html ?? "")
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|li|h[1-6]|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

export const uuid = () => globalThis.crypto.randomUUID();
