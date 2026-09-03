import { basename, join } from "node:path";
import type { EffectiveRepoConfig } from "../../src/config/schema.js";
import type { RunState, StepContext } from "../../src/engine/types.js";

export function makeRepoConfig(overrides: Partial<EffectiveRepoConfig> = {}): EffectiveRepoConfig {
  return {
    repoRoot: "/tmp/fixture-repo",
    remote: "origin",
    branching: {
      base: "main",
      target: "main",
      nameTemplate: "factory/{{kind}}/{{slug}}",
      titleTemplate: "{{kind}}: {{title}}",
      draftPolicy: "elevated",
      linkStyle: "closes",
    },
    checks: [],
    testDir: "tests",
    testPattern: "**/*.test.ts",
    testInfra: ["vitest.config.ts"],
    setupTimeoutSeconds: 600,
    allowInstallScripts: false,
    writeRoots: {
      feature: ["src/**", "tests/**"],
      enhancement: ["src/**", "tests/**"],
      bug: ["src/**", "tests/**"],
      chore: ["docs/**", "README.md"],
    },
    riskPaths: ["auth/**", "migrations/**"],
    securityPaths: ["auth/**"],
    exclusivePaths: [],
    generatedPaths: [],
    maxDiffLines: 800,
    maxChangedFiles: 20,
    steering: "always",
    planApproval: "never",
    stageTimeoutSeconds: 1800,
    checksTimeoutSeconds: 900,
    checksConcurrency: 2,
    generatedDocPatterns: ["**/PLAN.md", "**/steer-packet.md"],
    sandbox: "best-effort",
    ...overrides,
  };
}

export function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run-0001",
    workflow: "factory-sdlc:chore@deadbeef",
    lane: "chore",
    kind: "chore",
    tier: "low",
    status: "running",
    currentStep: "steer",
    iteration: 2,
    rounds: {},
    steps: [],
    artifacts: {},
    ticket: { tracker: "local", ref: "local-01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Rename README heading" },
    workspaceDir: "/tmp/ws",
    mainCheckout: "/tmp/fixture-repo",
    branch: "factory/chore/rename-readme-heading",
    baseSha: "a".repeat(40),
    hostCommits: [],
    budget: { maxWallSeconds: 1800, maxCostUsd: 5, maxIterations: 9, fixRounds: 2 },
    wallSecondsUsed: 12,
    costUsd: 0.12,
    configSha: "c".repeat(64),
    nonce: "n0nce-test",
    startedAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:05:00.000Z",
    ...overrides,
  };
}

export function makeStepContext(
  runDir: string,
  opts: { state?: Partial<RunState>; cfg?: Partial<EffectiveRepoConfig>; nonce?: string } = {},
): StepContext {
  const nonce = opts.nonce ?? "n0nce-test";
  return {
    state: makeRunState({ runId: basename(runDir), nonce, ...opts.state }),
    runDir,
    workspaceDir: join(runDir, "ws"),
    cfg: makeRepoConfig(opts.cfg),
    nonce,
    emit: () => {},
    signal: new AbortController().signal,
  };
}
