// Phase C item 21 — backwards-compat assertions. Every Phase A/B
// feature defaults OFF in the 2.1.0 release window so providers
// with full custom-tool support (Anthropic-direct) see byte-for-byte
// 2.0.x behavior until operators explicitly opt in per the cohort
// rollout design.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPhaseAConfig, resetPhaseAConfigCache } from "../../../src/team/phaseA-config.js";

describe("Phase A defaults — Anthropic-direct preserves 2.0.x behavior", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    env = { ...process.env };
    // Wipe every Phase A/B env var so the test sees defaults.
    delete process.env.PI_ENGINEERING_LEGACY_MODE;
    delete process.env.PI_ENGINEERING_CAPABILITY_MODE;
    delete process.env.PI_ENGINEERING_VERDICT_SLOT_HOSTOWNED;
    delete process.env.PI_ENGINEERING_ACCEPT_PREDICATES;
    delete process.env.PI_ENGINEERING_FORCED_RETRIES;
    delete process.env.PI_ENGINEERING_FORCED_RETRY_BUDGET;
    delete process.env.PI_ENGINEERING_TELEMETRY;
    delete process.env.PI_ENGINEERING_EXPANDED_STATE_PROTECTION;
    delete process.env.PI_ENGINEERING_EMERGENCY_NO_NEW_WRITES;
    delete process.env.PI_ENGINEERING_ACTIVITY_STREAM;
    resetPhaseAConfigCache();
  });
  afterEach(() => {
    process.env = env;
    resetPhaseAConfigCache();
  });

  it("legacy mode is OFF by default", () => {
    expect(getPhaseAConfig().legacyMode).toBe(false);
  });

  it("capability gate defaults to `warn` (not `enforce`)", () => {
    expect(getPhaseAConfig().capabilityMode).toBe("warn");
  });

  it("verdict-slot-hostowned defaults OFF (legacy `_agent_tmp` path)", () => {
    expect(getPhaseAConfig().verdictSlotHostOwned).toBe(false);
  });

  it("acceptance predicates default OFF", () => {
    expect(getPhaseAConfig().acceptPredicates).toBe(false);
  });

  it("forced-retry budget defaults to 1 attempt (matches 2.0.x)", () => {
    expect(getPhaseAConfig().forcedRetryBudget).toBe(1);
  });

  it("telemetry defaults OFF", () => {
    expect(getPhaseAConfig().telemetryEnabled).toBe(false);
  });

  it("activity stream defaults OFF (Phase B opt-in)", () => {
    expect(getPhaseAConfig().activityStreamEnabled).toBe(false);
  });

  it("LEGACY_MODE=2.0.x forces every behavior-changing flag OFF", () => {
    process.env.PI_ENGINEERING_LEGACY_MODE = "2.0.x";
    resetPhaseAConfigCache();
    const cfg = getPhaseAConfig();
    expect(cfg.legacyMode).toBe(true);
    expect(cfg.capabilityMode).toBe("observe");
    expect(cfg.verdictSlotHostOwned).toBe(false);
    expect(cfg.acceptPredicates).toBe(false);
    expect(cfg.forcedRetriesEnabled).toBe(false);
    expect(cfg.telemetryEnabled).toBe(false);
    expect(cfg.expandedStateProtection).toBe(false);
    expect(cfg.activityStreamEnabled).toBe(false);
  });
});
