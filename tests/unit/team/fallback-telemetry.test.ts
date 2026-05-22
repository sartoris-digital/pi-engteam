import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { emitFallback, resetFallbackTelemetryCache } from "../../../src/team/fallback-telemetry.js";
import { resetPhaseAConfigCache } from "../../../src/team/phaseA-config.js";

describe("fallback-telemetry", () => {
  let runsDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "fb-tel-"));
    env = { ...process.env };
    delete process.env.PI_ENGINEERING_TELEMETRY;
    delete process.env.PI_ENGINEERING_LEGACY_MODE;
    resetPhaseAConfigCache();
    resetFallbackTelemetryCache();
  });

  afterEach(() => {
    process.env = env;
    resetPhaseAConfigCache();
    resetFallbackTelemetryCache();
  });

  it("no-ops when telemetry is disabled (default)", () => {
    emitFallback(runsDir, {
      ts: new Date().toISOString(),
      runId: "r1",
      agent: "bug-triage",
      step: "classify",
      tier: "synthesis-content-fields",
    });
    expect(existsSync(join(runsDir, "_telemetry", "fallbacks.jsonl"))).toBe(false);
  });

  it("appends one line per emit when enabled", () => {
    process.env.PI_ENGINEERING_TELEMETRY = "1";
    resetPhaseAConfigCache();
    resetFallbackTelemetryCache();
    emitFallback(runsDir, {
      ts: "2026-05-22T00:00:00.000Z",
      runId: "r1",
      agent: "bug-triage",
      step: "classify",
      tier: "stdout-scan",
    });
    emitFallback(runsDir, {
      ts: "2026-05-22T00:00:01.000Z",
      runId: "r1",
      agent: "bug-triage",
      step: "route",
      tier: "synthesis-normalized-name",
    });
    const path = join(runsDir, "_telemetry", "fallbacks.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.tier).toBe("stdout-scan");
    expect(first.agent).toBe("bug-triage");
  });

  it("legacy mode disables telemetry even if PI_ENGINEERING_TELEMETRY=1", () => {
    process.env.PI_ENGINEERING_TELEMETRY = "1";
    process.env.PI_ENGINEERING_LEGACY_MODE = "2.0.x";
    resetPhaseAConfigCache();
    resetFallbackTelemetryCache();
    emitFallback(runsDir, {
      ts: new Date().toISOString(),
      runId: "r1",
      agent: "bug-triage",
      step: "classify",
      tier: "stdout-scan",
    });
    expect(existsSync(join(runsDir, "_telemetry", "fallbacks.jsonl"))).toBe(false);
  });

  it("preserves structured fields including durationMs and context", () => {
    process.env.PI_ENGINEERING_TELEMETRY = "1";
    resetPhaseAConfigCache();
    resetFallbackTelemetryCache();
    emitFallback(runsDir, {
      ts: "2026-05-22T00:00:00.000Z",
      runId: "r1",
      agent: "bug-triage",
      step: "classify",
      tier: "forced-retry",
      provider: "copilot",
      modelId: "claude-opus-4-6",
      durationMs: 1234,
      context: { attempts: 2 },
    });
    const text = readFileSync(join(runsDir, "_telemetry", "fallbacks.jsonl"), "utf8");
    const parsed = JSON.parse(text.trim());
    expect(parsed.provider).toBe("copilot");
    expect(parsed.modelId).toBe("claude-opus-4-6");
    expect(parsed.durationMs).toBe(1234);
    expect(parsed.context.attempts).toBe(2);
  });
});
