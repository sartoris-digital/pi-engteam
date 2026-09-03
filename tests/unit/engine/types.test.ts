import { describe, expect, it } from "vitest";
import {
  ESCALATION_CODES,
  RUN_STATUSES,
  isEscalationCode,
  type EvidenceRecord,
  type FactoryEvent,
  type RunState,
  type Step,
  type StepResult,
} from "../../../src/engine/types.js";

describe("engine types", () => {
  it("exports the v1 codes plus the three v1.5 codify codes, unique", () => {
    expect(ESCALATION_CODES).toHaveLength(37);
    expect(new Set(ESCALATION_CODES).size).toBe(37);
    for (const code of [
      "needs-decision", "env-setup-failed", "checks-timeout", "gate-invalid", "gate-baseline-green",
      "test-tampering", "scope-violation", "too-large", "loop-exhausted", "stall", "budget-exhausted",
      "safety-block", "config-tampered", "judge-fail-final", "publish-refused", "push-rejected",
      "approval-needed", "worker-crash", "workspace-lost", "steer-timeout",
      "needs-triage", "needs-info", "duplicate-suspected", "base-red", "cannot-reproduce",
      "gate-defect", "dependency-denied", "security-fail", "rebase-conflict", "rule-violation",
      "needs-rebase", "human-owned",
      "not-codifiable", "validation-failed", "codified-safety",
      "holdout-fail", "proxy-unavailable",
    ]) {
      expect(ESCALATION_CODES).toContain(code);
    }
  });

  it("isEscalationCode narrows unknown values", () => {
    expect(isEscalationCode("loop-exhausted")).toBe(true);
    expect(isEscalationCode("budget-exhausted")).toBe(true);
    expect(isEscalationCode("holdout-fail")).toBe(true);
    expect(isEscalationCode("proxy-unavailable")).toBe(true);
    expect(isEscalationCode("not-a-code")).toBe(false);
    expect(isEscalationCode(42)).toBe(false);
    expect(isEscalationCode(undefined)).toBe(false);
  });

  it("exports the seven run statuses in contract order", () => {
    expect(RUN_STATUSES).toEqual([
      "pending", "running", "waiting_user", "paused", "succeeded", "failed", "cancelled",
    ]);
  });

  it("a RunState literal has the contract shape and FactoryEvent is the observer's", () => {
    const state: RunState = {
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workflow: "factory-sdlc:chore@deadbeef",
      lane: "chore",
      kind: "chore",
      tier: "low",
      status: "pending",
      currentStep: "scope-check",
      iteration: 0,
      rounds: {},
      steps: [],
      artifacts: {},
      ticket: { tracker: "local", ref: "local-1", title: "rename helper" },
      workspaceDir: "/tmp/ws",
      mainCheckout: "/tmp/repo",
      branch: "factory/local-1-rename-helper",
      baseSha: "0000000",
      hostCommits: [],
      budget: { maxWallSeconds: 2700, maxCostUsd: 8, maxIterations: 21, fixRounds: 2 },
      wallSecondsUsed: 0,
      costUsd: 0,
      configSha: "cfg0",
      nonce: "abc",
      startedAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    const step: Step = {
      name: "plan",
      kind: "agent",
      agent: "planner",
      gates: [],
      onFail: "escalate:needs-decision",
      run: async () => ({ verdict: "PASS" }),
    };
    const result: StepResult = { verdict: "PASS", costUsd: 0.5, evidence: { skipped: false } };
    // The engine emits the observer's event shape: category from EVENT_CATEGORIES, timestamp `ts`.
    const event: FactoryEvent = { ts: "2026-09-02T00:00:00.000Z", runId: state.runId, category: "lifecycle", type: "run.start" };
    expect(state.status).toBe("pending");
    expect(state.resumeDecision).toBeUndefined();
    expect(step.onFail.startsWith("escalate:")).toBe(true);
    expect(result.costUsd).toBe(0.5);
    expect(event.category).toBe("lifecycle");
  });

  it("EvidenceRecord accepts optional codified and rulesApplied fields", () => {
    const evidence: EvidenceRecord = {
      stage: "implement",
      round: 0,
      agent: "host:codified-implement",
      verdict: "AUTO",
      predicates: [],
      artifacts: [],
      commands: [],
      synthesized: [],
      timedOut: false,
      headSha: "abc",
      at: "2026-09-03T00:00:00.000Z",
      rulesApplied: ["r-builtin-no-generated-docs"],
      codified: {
        mode: "exact",
        name: "bump-version",
        version: 1,
        inputs: { pkg: "pi-sdlc-factory", version: "1.5.0" },
        exitCode: 0,
        toolSha256: "aa".repeat(32),
        durationMs: 12,
      },
    };
    expect(evidence.codified?.mode).toBe("exact");
    expect(evidence.rulesApplied).toEqual(["r-builtin-no-generated-docs"]);
  });
});
