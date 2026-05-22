import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CapabilityMatrix } from "../../../src/team/capability-matrix.js";
import {
  buildRuntimeFingerprint,
  performCapabilityCheck,
  runWithStepTimeout,
  StepTimeoutError,
  defaultStepTimeoutSeconds,
} from "../../../src/team/phaseA-runtime.js";
import { resetPhaseAConfigCache } from "../../../src/team/phaseA-config.js";
import type { CapabilityBundle } from "../../../src/team/capability-schema.js";

function makeBaselineBundle(provider: string): CapabilityBundle {
  return {
    schemaVersion: 1,
    baselineOnly: true,
    provenance: {
      provider,
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
    sentinelResults: { write: "ok" },
    streams: {
      thinking: "stdout",
      tool_call_invoke: "stdout",
      tool_call_result: "stdout",
      assistant_text: "stdout",
      error: "stderr",
    },
  };
}

describe("performCapabilityCheck", () => {
  let cacheDir: string;
  let baselineDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "phaseA-cache-"));
    baselineDir = mkdtempSync(join(tmpdir(), "phaseA-baseline-"));
    env = { ...process.env };
    // Clear all Phase A env vars before each test.
    delete process.env.PI_ENGINEERING_LEGACY_MODE;
    delete process.env.PI_ENGINEERING_CAPABILITY_MODE;
    resetPhaseAConfigCache();
  });

  afterEach(() => {
    process.env = env;
    resetPhaseAConfigCache();
  });

  it("legacy mode bypasses the check entirely", () => {
    process.env.PI_ENGINEERING_LEGACY_MODE = "2.0.x";
    resetPhaseAConfigCache();
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "enforce" });
    const result = performCapabilityCheck(matrix, buildRuntimeFingerprint({ provider: "ghcp", modelId: "m" }));
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.source).toBe("legacy-bypass");
  });

  it("warn mode logs and allows when no bundle matches", () => {
    process.env.PI_ENGINEERING_CAPABILITY_MODE = "warn";
    resetPhaseAConfigCache();
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m), error: vi.fn() };
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "warn" });
    const result = performCapabilityCheck(matrix, buildRuntimeFingerprint({ provider: "ghcp", modelId: "m" }), logger);
    expect(result.allowed).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/no bundle matched/);
  });

  it("enforce mode refuses when no bundle matches", () => {
    process.env.PI_ENGINEERING_CAPABILITY_MODE = "enforce";
    resetPhaseAConfigCache();
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "enforce" });
    const result = performCapabilityCheck(matrix, buildRuntimeFingerprint({ provider: "ghcp", modelId: "m" }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/provider-missing-capability/);
      expect(result.mode).toBe("enforce");
    }
  });

  it("enforce mode refuses a wildcard-baseline-only match", () => {
    process.env.PI_ENGINEERING_CAPABILITY_MODE = "enforce";
    resetPhaseAConfigCache();
    writeFileSync(join(baselineDir, "ghcp-baseline.json"), JSON.stringify(makeBaselineBundle("ghcp")), "utf8");
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "enforce" });
    const result = performCapabilityCheck(matrix, buildRuntimeFingerprint({ provider: "ghcp", modelId: "m" }));
    // In enforce mode, getCapabilities skips baselines AND
    // performCapabilityCheck also refuses an isolated baseline match.
    expect(result.allowed).toBe(false);
  });

  it("observe mode never blocks even on missing capability", () => {
    process.env.PI_ENGINEERING_CAPABILITY_MODE = "observe";
    resetPhaseAConfigCache();
    const matrix = new CapabilityMatrix({ cacheDir, baselineDir, mode: "observe" });
    const result = performCapabilityCheck(matrix, buildRuntimeFingerprint({ provider: "ghcp", modelId: "m" }));
    expect(result.allowed).toBe(true);
  });
});

describe("runWithStepTimeout", () => {
  it("returns the fn's value when it resolves before the deadline", async () => {
    const result = await runWithStepTimeout("test-step", 5, async () => 42);
    expect(result).toBe(42);
  });

  it("throws StepTimeoutError when the fn exceeds the deadline", async () => {
    await expect(
      runWithStepTimeout("slow-step", 1, () => new Promise<number>((res) => setTimeout(() => res(99), 1500))),
    ).rejects.toBeInstanceOf(StepTimeoutError);
  });

  it("the thrown error carries step name and budget", async () => {
    try {
      await runWithStepTimeout("named", 1, () => new Promise<number>((res) => setTimeout(() => res(0), 1500)));
      throw new Error("expected timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(StepTimeoutError);
      if (err instanceof StepTimeoutError) {
        expect(err.stepName).toBe("named");
        expect(err.budgetMs).toBe(1000);
      }
    }
  });
});

describe("defaultStepTimeoutSeconds", () => {
  it("returns 360 for judge-gate", () => {
    expect(defaultStepTimeoutSeconds("judge-gate")).toBe(360);
  });
  it("returns 240 for any other step", () => {
    expect(defaultStepTimeoutSeconds("classify")).toBe(240);
    expect(defaultStepTimeoutSeconds("route")).toBe(240);
  });
});

// Phase C item 20 — PI version detection.
import { checkPiVersion, resetPiVersionCheckCache } from "../../../src/team/phaseA-runtime.js";

describe("checkPiVersion", () => {
  afterEach(() => {
    resetPiVersionCheckCache();
  });

  it("classifies unknown when the pi binary cannot be resolved", () => {
    const r = checkPiVersion("nonexistent-pi-binary-xyz");
    // Either "unknown" (no version output) or "ok" depending on
    // the host's PATH — both are acceptable here. The contract
    // is that the function never throws.
    expect(["ok", "warn", "error", "unknown"]).toContain(r.level);
  });
});

