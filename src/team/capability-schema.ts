// Phase 0 — capability JSON schema. The result of a Phase 0a probe is
// stored as a `CapabilityBundle` and gates Phase A / Phase B at run
// start. Provenance fields (round 4 MED #1 + round 6 MED #1) record
// the exact runtime fingerprint the bundle was probed against so the
// matrix can detect drift and force a re-probe.
import { Type, type Static } from "@sinclair/typebox";

// Source class for a typed stream event: where the chunk was observed
// AND when in the subprocess lifecycle. Phase B picks the realtime
// source per provider from this enum.
export const StreamSource = Type.Union([
  Type.Literal("stdout"),
  Type.Literal("stderr"),
  Type.Literal("audit-pre-close"),
  Type.Literal("audit-post-close-only"),
  Type.Literal("pty-required"),
  Type.Literal("none"),
]);
export type StreamSource = Static<typeof StreamSource>;

// One observed stream-source survey result per content kind.
export const StreamSourceMap = Type.Object({
  thinking: StreamSource,
  tool_call_invoke: StreamSource,
  tool_call_result: StreamSource,
  assistant_text: StreamSource,
  error: StreamSource,
});
export type StreamSourceMap = Static<typeof StreamSourceMap>;

// Sentinel call outcome for each tool probed.
export const SentinelResult = Type.Union([
  Type.Literal("ok"),
  Type.Literal("blocked-by-domain-lock"),
  Type.Literal("tool-not-in-inventory"),
  Type.Literal("model-refused"),
  Type.Literal("timeout"),
  Type.Literal("error"),
]);
export type SentinelResult = Static<typeof SentinelResult>;

// Provenance for a capability bundle. EVERY bundle ships these
// fields; wildcards (`"*"`) are allowed only on shipped baseline
// bundles and require `baselineOnly: true`.
export const Provenance = Type.Object({
  provider: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  accountFingerprint: Type.String({ minLength: 1 }),
  piVersion: Type.String({ minLength: 1 }),
  piBuildHash: Type.String({ minLength: 1 }),
  piEngVersion: Type.String({ minLength: 1 }),
  protocolVersion: Type.String({ minLength: 1 }),
  runtimeFlags: Type.Array(Type.String()),
  probeTs: Type.String({ minLength: 1, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}" }),
  probeBundleHash: Type.String({ minLength: 1 }),
  harnessVersion: Type.String({ minLength: 1 }),
});
export type Provenance = Static<typeof Provenance>;

// The canonical capability bundle, written by `scripts/probe-pi-provider.mjs`
// and read by `capability-matrix.ts` at run start.
export const CapabilityBundle = Type.Object({
  schemaVersion: Type.Literal(1),
  baselineOnly: Type.Optional(Type.Boolean()),
  provenance: Provenance,
  // Tools the model actually saw in its inventory during the probe.
  observedTools: Type.Array(Type.String()),
  // Sentinel outcomes per tool name. A tool can be in observedTools
  // but sentinel-block on the upsert-target path; that's still
  // useful signal.
  sentinelResults: Type.Record(Type.String(), SentinelResult),
  // Stream-source survey (Phase 0b).
  streams: StreamSourceMap,
  // Free-form notes the harness or operator can attach (e.g. "GHCP
  // truncates audit JSONL on premature close in v0.72").
  notes: Type.Optional(Type.String()),
});
export type CapabilityBundle = Static<typeof CapabilityBundle>;

// Result of a single capability lookup at run start.
export type CapabilityLookup = {
  bundle: CapabilityBundle;
  source: "baseline" | "probed";
  age: { probeTs: string; ageDays: number };
  // True when the lookup tuple required wildcards in the bundle to
  // match — only acceptable in `observe`/`warn` modes.
  matchedByWildcard: boolean;
};
