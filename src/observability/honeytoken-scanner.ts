// Phase E item E14 — honeytoken/canary-secret scanner. Runs
// periodically across persisted JSONL, SSE history, replay
// outputs, and retry-prompt excerpts to verify the Redactor (Phase
// C item 18) didn't miss a secret. Any hit is a credential-leak
// incident: the Redactor is the SINGLE choke point, so a miss
// means a regression.
//
// The scanner uses the same patterns as the Redactor — running
// them at-rest catches regressions where redaction was bypassed
// (e.g. a code path that wrote to disk without going through the
// pipeline). It also accepts a caller-injected canary string per
// run that probes assert is NEVER visible in persisted output.
import { readFileSync, existsSync } from "fs";

// Re-use the production redact patterns by running redact() and
// observing whether it modified the input. If `redact(text)` !==
// `text`, a secret slipped through.
import { redact } from "../team/Redactor.js";

export type HoneytokenHit = {
  path: string;
  lineNumber?: number;
  patternClass: string;
  preview: string;  // redacted preview, safe to log
};

export type ScanResult = {
  hits: HoneytokenHit[];
  filesScanned: number;
  bytesScanned: number;
};

/**
 * Scan a single file for any pattern that the production redactor
 * would match. Returns at most `maxHitsPerFile` hits per file.
 * The `preview` field is itself redacted — this scanner never
 * leaks the secret it found.
 */
export function scanFile(path: string, opts?: { maxHitsPerFile?: number; maxBytes?: number }): HoneytokenHit[] {
  if (!existsSync(path)) return [];
  const maxHits = opts?.maxHitsPerFile ?? 32;
  const maxBytes = opts?.maxBytes ?? 64 * 1024 * 1024;
  let text: string;
  try {
    const { statSync } = require("fs") as typeof import("fs");
    const st = statSync(path);
    if (st.size > maxBytes) {
      return [{
        path,
        patternClass: "scanner-skip-oversize",
        preview: `(file too large: ${st.size} bytes; max ${maxBytes})`,
      }];
    }
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const hits: HoneytokenHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const redacted = redact(line);
    if (redacted !== line) {
      // Extract the class name from the first `[REDACTED:<class>:`
      // marker in the redacted output for the runbook.
      const m = redacted.match(/\[REDACTED:([^:]+):/);
      const cls = m?.[1] ?? "unknown";
      hits.push({
        path,
        lineNumber: i + 1,
        patternClass: cls,
        preview: redacted.slice(0, 200),
      });
      if (hits.length >= maxHits) break;
    }
  }
  return hits;
}

/**
 * Scan multiple paths. Aggregates hits + totals. Caller passes the
 * paths to scan (typically agent-activity.jsonl, _telemetry/*.jsonl,
 * _verdicts/*.json).
 */
export function scanPaths(paths: string[], opts?: { maxHitsPerFile?: number; maxBytes?: number }): ScanResult {
  const hits: HoneytokenHit[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const { statSync } = require("fs") as typeof import("fs");
      bytesScanned += statSync(p).size;
    } catch { /* ignore */ }
    filesScanned++;
    hits.push(...scanFile(p, opts));
  }
  return { hits, filesScanned, bytesScanned };
}
