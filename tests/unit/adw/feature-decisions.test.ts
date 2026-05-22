import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  computeCohortKey,
  readFrozenDecisions,
  snapshotFeatureVector,
  writeFrozenDecisions,
  type FrozenDecisions,
} from "../../../src/adw/feature-decisions.js";

describe("feature-decisions — computeCohortKey", () => {
  it("produces a 16-char hex hash from the full stable tuple", () => {
    const r = computeCohortKey({
      provider: "copilot",
      modelId: "claude-opus-4-6",
      accountFingerprint: "acct-abc",
      piVersion: "0.74.1",
      piBuildHash: "deadbeef",
      hostId: "machine-1",
    });
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.key).toContain("copilot");
    expect(r.key).toContain("claude-opus-4-6");
  });

  it("is deterministic across calls for the same tuple", () => {
    const a = computeCohortKey({
      provider: "p", modelId: "m", accountFingerprint: "a",
      piVersion: "v", piBuildHash: "b", hostId: "h",
    });
    const b = computeCohortKey({
      provider: "p", modelId: "m", accountFingerprint: "a",
      piVersion: "v", piBuildHash: "b", hostId: "h",
    });
    expect(a.hash).toBe(b.hash);
  });

  it("changes when piVersion changes (round 13 MED #2)", () => {
    const a = computeCohortKey({
      provider: "p", modelId: "m", accountFingerprint: "a",
      piVersion: "0.74.1", piBuildHash: "b", hostId: "h",
    });
    const b = computeCohortKey({
      provider: "p", modelId: "m", accountFingerprint: "a",
      piVersion: "0.75.0", piBuildHash: "b", hostId: "h",
    });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("feature-decisions — persistence", () => {
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "fd-"));
  });

  const decisions: FrozenDecisions = {
    schemaVersion: 1,
    runId: "test-run",
    cohortKey: "k",
    cohortHash: "h",
    frozenAt: "2026-05-22T00:00:00.000Z",
    features: {
      verdictSlotHostOwned: true,
      acceptPredicates: false,
      forcedRetriesEnabled: true,
      forcedRetryBudget: 2,
      telemetryEnabled: true,
      expandedStateProtection: true,
      activityStreamEnabled: true,
      capabilityMode: "warn",
    },
  };

  it("writeFrozenDecisions + readFrozenDecisions round-trips", () => {
    const path = writeFrozenDecisions(runDir, decisions);
    expect(existsSync(path)).toBe(true);
    const back = readFrozenDecisions(runDir);
    expect(back).toBeDefined();
    expect(back!.features.forcedRetryBudget).toBe(2);
    expect(back!.cohortHash).toBe("h");
  });

  it("readFrozenDecisions returns undefined when file missing", () => {
    expect(readFrozenDecisions(runDir)).toBeUndefined();
  });

  it("readFrozenDecisions returns undefined on schemaVersion mismatch", () => {
    const tampered = { ...decisions, schemaVersion: 99 };
    const path = join(runDir, "feature-decisions.json");
    const { writeFileSync, mkdirSync } = require("fs") as typeof import("fs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path, JSON.stringify(tampered));
    expect(readFrozenDecisions(runDir)).toBeUndefined();
  });
});

describe("feature-decisions — snapshotFeatureVector", () => {
  it("lifts the relevant Phase A fields from a PhaseAConfig snapshot", () => {
    const cfg = {
      legacyMode: false,
      capabilityMode: "enforce" as const,
      verdictSlotHostOwned: true,
      acceptPredicates: true,
      forcedRetriesEnabled: true,
      forcedRetryBudget: 3,
      telemetryEnabled: true,
      expandedStateProtection: true,
      noNewWrites: false,
      activityStreamEnabled: true,
    };
    const v = snapshotFeatureVector(cfg);
    expect(v.capabilityMode).toBe("enforce");
    expect(v.forcedRetryBudget).toBe(3);
    expect(v.activityStreamEnabled).toBe(true);
    // legacyMode + noNewWrites are NOT in the feature vector — those
    // are pure runtime kill-switches, not behaviour-changing
    // features the cohort controller ramps.
    expect("legacyMode" in v).toBe(false);
    expect("noNewWrites" in v).toBe(false);
  });
});
