import type { Branching, EffectiveRepoConfig, LaneEnv, OperatorConfig, TrackerKind, V3Policy } from "./schema.js";

/**
 * Spec §2.5 built-in generated-doc patterns: extendable per layer, never shrinkable (narrowing.ts).
 *
 * The single definition of this list. `src/gate/generated-docs.ts` re-exports it
 * (`export { GENERATED_DOC_PATTERNS } from "../config/defaults.js"`) instead of
 * declaring its own copy, and runtime consumers — checkpoint excludes (git group)
 * and the publish preflight (gate group) — take the *effective*
 * `cfg.generatedDocPatterns` produced by loadEffectiveConfig, so a layer that
 * extends the list applies everywhere.
 */
export const GENERATED_DOC_PATTERNS: readonly string[] = [
  "**/PLAN.md",
  "**/*.plan.md",
  "**/spec.md",
  "**/design.md",
  "**/diagnosis.md",
  "**/steer-packet.md",
  "**/issue-brief.md",
  "**/analysis.md",
  "**/review.md",
  "**/verdict.md",
  "docs/superpowers/**",
  ".omc/**",
  ".pi/*.local.*",
  ".pi/factory-rules*.yaml",
  "**/*.ai.md",
];

/** Operator block minus `worktreeRoot`, which loadEffectiveConfig derives from the factory home. */
export type OperatorDefaults = Omit<OperatorConfig, "worktreeRoot">;

/** Repo-scope keys that have a built-in value. `branching.base/target`, `setupCommand`, `dependencyUpdateCommand` are probed. */
export type RepoDefaultValues = Omit<
  EffectiveRepoConfig,
  "repoRoot" | "remote" | "branching" | "setupCommand" | "dependencyUpdateCommand"
> & {
  branching: Omit<Branching, "base" | "target">;
  installTimeoutSeconds: number;
  codegenCommands: string[][];
  laneEnv: LaneEnv;
};

/** Per-entry defaults for `operator.trackers[]` (applied by the trackers module, not by the merge). */
export interface TrackerEntryDefaults {
  label: string;
  transitionOnClaim: Record<TrackerKind, boolean>;
  transitionOnMerge: boolean;
  assignOnClaim: boolean;
}

const SRC_ROOTS = ["src/**", "lib/**", "packages/*/src/**", "apps/*/src/**"];

/**
 * Layer 1. Every default from the spec §2.2 table lives here and nowhere else;
 * tests/unit/config/defaults.test.ts asserts each row so the table cannot drift.
 */
export const DEFAULTS: {
  readonly operator: OperatorDefaults;
  readonly repo: RepoDefaultValues;
  readonly trackerEntry: TrackerEntryDefaults;
} = {
  operator: {
    trackers: [],
    github: {},
    coAuthoredBy: true,
    maxLanes: 3,
    maxLanesPerRepo: 2,
    dailyBudgetUsd: 150,
    maxTicketsPerDay: 20,
    pollIntervalSeconds: 60,
    allowBurstLane: false,
    maxAttempts: 2,
    abandonDays: 7,
    intake: {},
    steeringApprovers: "tui",
    workers: "auto",
    visibleStages: ["plan", "gate", "implement", "review", "security", "judge"],
    interrupt: { onIdleWithoutVerdict: "ask" },
    fusion: {
      stack: [],
      providerConcurrency: {},
      budgetMultiplier: 1.6,
      slotTimeoutSeconds: 300,
      off: false,
    },
    notify: {},
    gcDays: 7,
    landReminderDays: 3,
    codify: {
      enabled: true,
      repos: [],
      eligibility: "landed",
      minRecurrence: 2,
      schedule: "idle+daily@03:00",
      window: "30d/300",
      reserveUsd: 15,
      maxPerDay: 3,
      maxCandidatesPerRun: 2,
      requireIdleLanes: 1,
      forwardRoi: 3,
      dispatch: "exact",
      pythonDeps: [],
      maxActivePerRepo: 25,
      maxActiveGlobal: 50,
      staleDays: 90,
      shadowAgreeToActivate: 2,
      demoteAfterFailures: 2,
      cooldownDays: 30,
      taskTools: { unattended: "never" },
    },
    v3: {
      gitlab: { enabled: false },
      linear: { enabled: false },
      mcpTrackers: { enabled: false },
      setfit: { enabled: false, minLabelsPerClass: 40 },
      secondReview: { enabled: false, rate: 0.1 },
      transcriptAudit: { enabled: false },
      bestOfN: { enabled: false, n: 2 },
      dagParallel: { enabled: false },
      mergeQueue: { enabled: false },
      webhooks: { enabled: false },
      collaborateExecution: { enabled: false },
      crossRepoTools: { enabled: false },
      learner: { enabled: false },
    } satisfies V3Policy,
  },
  trackerEntry: {
    label: "factory:ready",
    transitionOnClaim: { github: false, jira: true, "azure-devops": true },
    transitionOnMerge: false,
    assignOnClaim: false,
  },
  repo: {
    branching: {
      nameTemplate: "factory/{tracker}-{id}-{slug}",
      titleTemplate: "{kind}: {title} ({ref})",
      draftPolicy: "elevated", // spec: "per tier" — draft when the run's tier is elevated
      linkStyle: "auto", // spec: "tracker default"
    },
    setupTimeoutSeconds: 600,
    installTimeoutSeconds: 300,
    allowInstallScripts: false,
    codegenCommands: [],
    checks: [],
    checksTimeoutSeconds: 900,
    checksConcurrency: 1,
    stageTimeoutSeconds: 1800,
    testDir: "tests",
    testPattern: "**/*.test.*",
    // spec §7 manifest gate: test-infra globs restored from base before every run
    testInfra: [
      "**/conftest.py",
      "pyproject.toml",
      "tox.ini",
      "setup.py",
      "setup.cfg",
      "pytest.ini",
      "tsconfig*.json",
      "vitest.*",
      "jest.*",
      ".mocharc*",
      "babel*",
      ".npmrc",
      "Makefile",
      ".github/**",
      ".husky/**",
      ".githooks/**",
    ],
    writeRoots: {
      feature: [...SRC_ROOTS, "migrations/**", "docs/**", "README.md"],
      enhancement: [...SRC_ROOTS, "docs/**", "README.md"],
      bug: [...SRC_ROOTS],
      chore: [
        ...SRC_ROOTS,
        "docs/**",
        "README.md",
        "CHANGELOG.md",
        "scripts/**",
        ".github/**",
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "pyproject.toml",
        "poetry.lock",
        "requirements*.txt",
      ],
    },
    // spec §3 risk tier: auth, crypto, migrations, lockfiles, manifests, CI config
    riskPaths: [
      "auth/**",
      "**/auth/**",
      "**/crypto/**",
      "migrations/**",
      "**/migrations/**",
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "pyproject.toml",
      "poetry.lock",
      "requirements*.txt",
      "Cargo.toml",
      "Cargo.lock",
      "go.mod",
      "go.sum",
      ".github/**",
      ".gitlab-ci.yml",
      "Jenkinsfile",
    ],
    securityPaths: ["auth/**", "**/auth/**", "**/crypto/**", "**/security/**", "**/secrets/**"],
    exclusivePaths: [],
    generatedPaths: [],
    generatedDocPatterns: [...GENERATED_DOC_PATTERNS],
    maxDiffLines: 400,
    maxChangedFiles: 15,
    laneEnv: {},
    steering: "always",
    planApproval: "never",
    sandbox: "required",
  },
};
