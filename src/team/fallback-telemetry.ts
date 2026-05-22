// Phase A item 7: tier-fired-fallback telemetry. Every time a
// CoPilot-compat recovery tier fires (stdout-scan, filename
// normalization, artifact synthesis, forced retry, etc.), one line
// is appended to `<runsDir>/_telemetry/fallbacks.jsonl` so operators
// can spot models that consistently rely on deep fallbacks and
// re-route them.
//
// Telemetry is gated on the Phase A `telemetryEnabled` flag; in
// `LEGACY_MODE` the writer is a no-op. The writer is host-owned and
// the file is in the Layer-A protected list (item 9), so agents
// cannot tamper.
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getPhaseAConfig } from "./phaseA-config.js";

export type FallbackTier =
  | "verdict-emit-tool"          // tier 1 — preferred (no telemetry emit; this is the happy path)
  | "forced-retry"                // tier 2 — re-prompt with VerdictEmit-required forcing
  | "verdict-file-write"          // tier 3 — file write to PI_ENGINEERING_VERDICT_FILE
  | "stdout-scan"                 // tier 4 — extract verdict JSON from text
  | "synthesis-content-fields"    // tier 5 — synthesize from learnings/decisions/...
  | "synthesis-normalized-name"   // tier 6 — also normalize garbage artifact name
  | "synthesis-collision-suffix"  // tier 7 — append step suffix to avoid collision
  | "acceptance-predicate-failed" // item 8 — synthesized PASS downgraded to NEEDS_MORE
  | "usage-unavailable";           // item 10 — provider returned no token/cost data

export type FallbackEvent = {
  ts: string;
  runId: string;
  agent: string;
  step: string;
  tier: FallbackTier;
  // Optional context — these fields are bounded-cardinality safe
  // (provider/modelId, not free-form text).
  provider?: string;
  modelId?: string;
  durationMs?: number;
  // Free-form context, redacted via Phase C item 18 when that lands.
  // For now, callers are expected to pass only structured fields
  // they're confident are not secret-bearing.
  context?: Record<string, string | number | boolean>;
};

let writerEnabled: boolean | undefined;

function isEnabled(): boolean {
  if (writerEnabled !== undefined) return writerEnabled;
  const cfg = getPhaseAConfig();
  writerEnabled = cfg.telemetryEnabled && !cfg.legacyMode && !cfg.noNewWrites;
  return writerEnabled;
}

/**
 * Test-only: reset the cached enable check so the next call re-reads
 * the Phase A config.
 */
export function resetFallbackTelemetryCache(): void {
  writerEnabled = undefined;
}

/**
 * Emit one fallback-fired event to `<runsDir>/_telemetry/fallbacks.jsonl`.
 * Best-effort — never throws. No-op when telemetry is disabled.
 */
export function emitFallback(runsDir: string, event: FallbackEvent): void {
  if (!isEnabled()) return;
  const dir = join(runsDir, "_telemetry");
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "fallbacks.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {
    // Telemetry must never block real work.
  }
}
