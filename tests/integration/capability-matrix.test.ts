// Phase D item 22 — capability-aware integration matrix.
//
// Verifies the capability gate behavior across three fixture
// providers — `full-tool`, `copilot-like`, `minimal` — in each
// of the three modes (observe / warn / enforce). This is the
// minimal viable integration matrix; the full per-workflow ×
// per-fixture sweep is a follow-up.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CapabilityMatrix } from "../../src/team/capability-matrix.js";
import { buildRuntimeFingerprint, performCapabilityCheck } from "../../src/team/phaseA-runtime.js";
import { resetPhaseAConfigCache } from "../../src/team/phaseA-config.js";
import type { CapabilityBundle } from "../../src/team/capability-schema.js";

type Fixture = "full-tool" | "copilot-like" | "minimal";

function makeFixture(provider: string, kind: Fixture): CapabilityBundle {
  const base = {
    schemaVersion: 1 as const,
    baselineOnly: false,
    provenance: {
      provider,
      modelId: "claude-opus-4-6",
      accountFingerprint: "test-account",
      piVersion: "0.74.1",
      piBuildHash: "deadbeef",
      piEngVersion: "2.2.0",
      protocolVersion: "1",
      runtimeFlags: [],
      probeTs: "2026-05-22T00:00:00.000Z",
      probeBundleHash: "",
      harnessVersion: "0.1.0",
    },
    streams: {
      thinking: "stdout" as const,
      tool_call_invoke: "stdout" as const,
      tool_call_result: "stdout" as const,
      assistant_text: "stdout" as const,
      error: "stderr" as const,
    },
  };
  if (kind === "full-tool") {
    const b: CapabilityBundle = {
      ...base,
      observedTools: ["VerdictEmit", "SendMessage", "TaskList", "TaskUpdate", "CheckApproval", "RequestApproval", "GrantApproval", "UseSecret", "read", "write", "edit", "bash"],
      sentinelResults: { VerdictEmit: "ok", write: "ok", edit: "ok", read: "ok", SendMessage: "ok" },
    };
    b.provenance.probeBundleHash = CapabilityMatrix.computeBundleHash(b);
    return b;
  }
  if (kind === "copilot-like") {
    const b: CapabilityBundle = {
      ...base,
      observedTools: ["read", "write", "edit", "bash"],
      sentinelResults: {
        VerdictEmit: "tool-not-in-inventory",
        SendMessage: "tool-not-in-inventory",
        write: "ok",
        edit: "ok",
        read: "ok",
      },
    };
    b.provenance.probeBundleHash = CapabilityMatrix.computeBundleHash(b);
    return b;
  }
  // minimal
  const b: CapabilityBundle = {
    ...base,
    observedTools: ["read"],
    sentinelResults: { read: "ok", write: "tool-not-in-inventory", edit: "tool-not-in-inventory" },
  };
  b.provenance.probeBundleHash = CapabilityMatrix.computeBundleHash(b);
  return b;
}

describe("Phase D item 22 — capability gate matrix", () => {
  let cacheDir: string;
  let baselineDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "capmatrix-cache-"));
    baselineDir = mkdtempSync(join(tmpdir(), "capmatrix-baseline-"));
    env = { ...process.env };
    process.env.PI_ENGINEERING_PROVIDER = "test-provider";
    process.env.PI_ENGINEERING_MODEL = "claude-opus-4-6";
    process.env.PI_ENGINEERING_ACCOUNT_FINGERPRINT = "test-account";
    delete process.env.PI_ENGINEERING_LEGACY_MODE;
    delete process.env.PI_ENGINEERING_CAPABILITY_MODE;
    resetPhaseAConfigCache();
  });
  afterEach(() => {
    process.env = env;
    resetPhaseAConfigCache();
  });

  function installFixture(kind: Fixture) {
    const provider = "test-provider";
    const dir = join(cacheDir, provider);
    mkdirSync(dir, { recursive: true });
    const bundle = makeFixture(provider, kind);
    writeFileSync(join(dir, `${kind}.json`), JSON.stringify(bundle));
    return bundle;
  }

  function fingerprintFromBundle(b: CapabilityBundle) {
    return {
      provider: b.provenance.provider,
      modelId: b.provenance.modelId,
      accountFingerprint: b.provenance.accountFingerprint,
      piVersion: b.provenance.piVersion,
      piBuildHash: b.provenance.piBuildHash,
      protocolVersion: b.provenance.protocolVersion,
      runtimeFlags: b.provenance.runtimeFlags,
    };
  }

  const modes: Array<"observe" | "warn" | "enforce"> = ["observe", "warn", "enforce"];

  for (const fixture of ["full-tool", "copilot-like", "minimal"] as Fixture[]) {
    for (const mode of modes) {
      it(`${fixture} fixture, mode=${mode} → ${mode === "enforce" ? "PASS (concrete bundle present)" : "PASS (allowed)"}`, () => {
        process.env.PI_ENGINEERING_CAPABILITY_MODE = mode;
        resetPhaseAConfigCache();
        const bundle = installFixture(fixture);
        const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode });
        const fp = { ...buildRuntimeFingerprint({}), ...fingerprintFromBundle(bundle) };
        const result = performCapabilityCheck(matrix, fp);
        expect(result.allowed).toBe(true);
      });
    }

    it(`${fixture} fixture in enforce mode WITHOUT a probed bundle → fails closed`, () => {
      // Don't install the fixture; matrix has no bundle for this
      // provider at all.
      process.env.PI_ENGINEERING_CAPABILITY_MODE = "enforce";
      resetPhaseAConfigCache();
      const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "enforce" });
      const fp = buildRuntimeFingerprint({});
      const result = performCapabilityCheck(matrix, fp);
      expect(result.allowed).toBe(false);
    });
  }

  it("LEGACY_MODE bypasses the matrix entirely regardless of fixture", () => {
    process.env.PI_ENGINEERING_LEGACY_MODE = "2.0.x";
    process.env.PI_ENGINEERING_CAPABILITY_MODE = "enforce";
    resetPhaseAConfigCache();
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "enforce" });
    const fp = buildRuntimeFingerprint({});
    const result = performCapabilityCheck(matrix, fp);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.source).toBe("legacy-bypass");
  });
});
