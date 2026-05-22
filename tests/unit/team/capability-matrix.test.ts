import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CapabilityMatrix } from "../../../src/team/capability-matrix.js";
import type { CapabilityBundle } from "../../../src/team/capability-schema.js";

function makeBundle(over: Partial<CapabilityBundle["provenance"]> = {}, daysOld = 0): CapabilityBundle {
  const probeTs = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  const bundle: CapabilityBundle = {
    schemaVersion: 1,
    provenance: {
      provider: over.provider ?? "anthropic",
      modelId: over.modelId ?? "claude-opus-4-7",
      accountFingerprint: over.accountFingerprint ?? "acct-test",
      piVersion: over.piVersion ?? "0.74.1",
      piBuildHash: over.piBuildHash ?? "abc123",
      piEngVersion: over.piEngVersion ?? "2.1.0",
      protocolVersion: over.protocolVersion ?? "1",
      runtimeFlags: over.runtimeFlags ?? [],
      probeTs,
      probeBundleHash: "",
      harnessVersion: over.harnessVersion ?? "0.1.0",
    },
    observedTools: ["read", "write", "edit", "VerdictEmit"],
    sentinelResults: { write: "ok", VerdictEmit: "ok" },
    streams: {
      thinking: "stdout",
      tool_call_invoke: "stdout",
      tool_call_result: "stdout",
      assistant_text: "stdout",
      error: "stderr",
    },
  };
  bundle.provenance.probeBundleHash = CapabilityMatrix.computeBundleHash(bundle);
  return bundle;
}

describe("CapabilityMatrix — schema + lookup", () => {
  let cacheDir: string;
  let baselineDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "cap-cache-"));
    baselineDir = mkdtempSync(join(tmpdir(), "cap-baseline-"));
  });

  it("writeBundle and lookup roundtrip for a full-tuple match", () => {
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir });
    const b = makeBundle();
    const out = matrix.writeBundle(b);
    expect(existsSync(out)).toBe(true);
    const result = matrix.getCapabilities({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      accountFingerprint: "acct-test",
      piVersion: "0.74.1",
      piBuildHash: "abc123",
      protocolVersion: "1",
      runtimeFlags: [],
    });
    expect(result).toBeDefined();
    expect(result!.source).toBe("probed");
    expect(result!.matchedByWildcard).toBe(false);
    expect(result!.bundle.observedTools).toContain("VerdictEmit");
  });

  it("relaxed match (model drift) returns matchedByWildcard=true", () => {
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir });
    matrix.writeBundle(makeBundle({ modelId: "claude-opus-4-6" }));
    const result = matrix.getCapabilities({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      accountFingerprint: "acct-test",
      piVersion: "0.74.1",
      piBuildHash: "abc123",
      protocolVersion: "1",
      runtimeFlags: [],
    });
    expect(result).toBeDefined();
    expect(result!.matchedByWildcard).toBe(true);
  });

  it("refuses hand-edited bundles (broken bundleHash)", () => {
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir });
    const b = makeBundle();
    const dir = join(cacheDir, b.provenance.provider);
    mkdirSync(dir, { recursive: true });
    // Tamper: change a field after computing the hash.
    const tampered = { ...b, observedTools: ["read", "write", "edit", "FORGED_TOOL"] };
    writeFileSync(join(dir, "tampered.json"), JSON.stringify(tampered), "utf8");
    const result = matrix.getCapabilities({
      provider: b.provenance.provider,
      modelId: b.provenance.modelId,
      accountFingerprint: b.provenance.accountFingerprint,
      piVersion: b.provenance.piVersion,
      piBuildHash: b.provenance.piBuildHash,
      protocolVersion: b.provenance.protocolVersion,
      runtimeFlags: b.provenance.runtimeFlags,
    });
    expect(result).toBeUndefined();
  });

  it("baseline bundle returns matchedByWildcard=true and source=baseline in warn mode", () => {
    const baseline: CapabilityBundle = {
      schemaVersion: 1,
      baselineOnly: true,
      provenance: {
        provider: "copilot",
        modelId: "*",
        accountFingerprint: "*",
        piVersion: "*",
        piBuildHash: "*",
        piEngVersion: "2.1.0",
        protocolVersion: "*",
        runtimeFlags: ["*"],
        probeTs: "2026-01-01T00:00:00.000Z",
        probeBundleHash: "baseline",
        harnessVersion: "0.0.0-baseline",
      },
      observedTools: ["read", "write", "edit"],
      sentinelResults: { write: "ok", VerdictEmit: "tool-not-in-inventory" },
      streams: {
        thinking: "stdout",
        tool_call_invoke: "stdout",
        tool_call_result: "stdout",
        assistant_text: "stdout",
        error: "stderr",
      },
    };
    writeFileSync(join(baselineDir, "copilot-baseline.json"), JSON.stringify(baseline), "utf8");
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "warn" });
    const result = matrix.getCapabilities({
      provider: "copilot",
      modelId: "claude-opus-4-6",
      accountFingerprint: "acct-foo",
      piVersion: "0.74.1",
      piBuildHash: "abc123",
      protocolVersion: "1",
      runtimeFlags: ["x"],
    });
    expect(result).toBeDefined();
    expect(result!.source).toBe("baseline");
    expect(result!.matchedByWildcard).toBe(true);
  });

  it("enforce mode refuses baselines and returns undefined when no probed bundle matches", () => {
    const baseline: CapabilityBundle = {
      schemaVersion: 1,
      baselineOnly: true,
      provenance: {
        provider: "copilot",
        modelId: "*",
        accountFingerprint: "*",
        piVersion: "*",
        piBuildHash: "*",
        piEngVersion: "2.1.0",
        protocolVersion: "*",
        runtimeFlags: ["*"],
        probeTs: "2026-01-01T00:00:00.000Z",
        probeBundleHash: "baseline",
        harnessVersion: "0.0.0-baseline",
      },
      observedTools: ["read", "write"],
      sentinelResults: {},
      streams: {
        thinking: "stdout",
        tool_call_invoke: "stdout",
        tool_call_result: "stdout",
        assistant_text: "stdout",
        error: "stderr",
      },
    };
    writeFileSync(join(baselineDir, "copilot-baseline.json"), JSON.stringify(baseline), "utf8");
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "enforce" });
    const result = matrix.getCapabilities({
      provider: "copilot",
      modelId: "claude-opus-4-6",
      accountFingerprint: "acct-foo",
      piVersion: "0.74.1",
      piBuildHash: "abc123",
      protocolVersion: "1",
      runtimeFlags: ["x"],
    });
    expect(result).toBeUndefined();
  });
});

describe("CapabilityMatrix — GC retention", () => {
  let cacheDir: string;
  let baselineDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "cap-cache-gc-"));
    baselineDir = mkdtempSync(join(tmpdir(), "cap-baseline-gc-"));
  });

  it("keeps the most-recent bundle per fingerprint AND up to N=10 fleet-wide", () => {
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir });
    // 12 bundles, all distinct timestamps, all with the same
    // fingerprint — only the most-recent-per-fingerprint AND the
    // 10 fleet-wide most-recent should remain. Since they all share
    // one fingerprint, the "per fingerprint" rule keeps 1 and the
    // "10 fleet-wide" rule keeps the top 10; the union is 10.
    for (let i = 0; i < 12; i++) {
      matrix.writeBundle(makeBundle({}, i));
    }
    matrix.gc("anthropic");
    const remaining = matrix.loadProbedBundles("anthropic");
    expect(remaining.length).toBe(10);
  });

  it("prunes bundles older than TTL when not pinned", () => {
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, bundleTtlDays: 30 });
    matrix.writeBundle(makeBundle({ modelId: "old-model" }, 100));
    matrix.writeBundle(makeBundle({ modelId: "fresh-model" }, 1));

    matrix.gc("anthropic");
    const remaining = matrix.loadProbedBundles("anthropic");
    // The 100-day-old bundle should be pruned even though its
    // fingerprint is unique, because TTL exceeded and not pinned.
    // The fresh bundle stays.
    const modelIds = remaining.map((b) => b.provenance.modelId);
    expect(modelIds).toContain("fresh-model");
    expect(modelIds).not.toContain("old-model");
  });

  it("pinned fingerprints survive even when over cap", () => {
    const matrix = new CapabilityMatrix({
      cacheDir,
      baselineDir,
      maxBundlesPerProvider: 1,
    });
    matrix.writeBundle(makeBundle({ modelId: "model-A" }, 0));
    matrix.writeBundle(makeBundle({ modelId: "model-B" }, 1));

    const fpA = `anthropic|model-A|acct-test|0.74.1|abc123|1|`;
    matrix.gc("anthropic", [fpA]);

    const remaining = matrix.loadProbedBundles("anthropic");
    const modelIds = remaining.map((b) => b.provenance.modelId);
    expect(modelIds).toContain("model-A");
  });
});
