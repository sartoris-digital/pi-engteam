// tests/helpers/fake-run-state.ts — a complete RunState literal for unit tests.
import type { RunState } from "../../src/engine/types.js";

export function fakeRunState(overrides: Partial<RunState> = {}): RunState {
  const now = new Date().toISOString();
  return {
    runId: "run-0001",
    workflow: "factory-sdlc:chore@00000000",
    lane: "chore",
    kind: "chore",
    tier: "low",
    status: "running",
    currentStep: "publish",
    iteration: 0,
    rounds: {},
    steps: [],
    artifacts: {},
    ticket: { tracker: "local", ref: "local-0001", title: "fake ticket" },
    workspaceDir: "/nonexistent/ws",
    mainCheckout: "/nonexistent/repo",
    branch: "factory/local-0001-fake",
    baseSha: "0".repeat(40),
    hostCommits: [],
    budget: { maxWallSeconds: 3600, maxCostUsd: 10, maxIterations: 20, fixRounds: 2 },
    wallSecondsUsed: 0,
    costUsd: 0,
    configSha: "c".repeat(64),
    nonce: "n".repeat(32),
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}
