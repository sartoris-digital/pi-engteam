import { describe, it, expect } from "vitest";
import { DEFAULTS, GENERATED_DOC_PATTERNS } from "../../../src/config/defaults.js";

function dig(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((acc, key) => {
    return acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined;
  }, root);
}

const SRC = ["src/**", "lib/**", "packages/*/src/**", "apps/*/src/**"];

/** One row per documented default in spec §2.2 (plus §2.5, §3 and §7 where the table says "built-in list"). */
const table: Array<[path: string, expected: unknown]> = [
  // operator
  ["operator.trackers", []],
  ["operator.github", {}],
  ["operator.coAuthoredBy", true],
  ["operator.maxLanes", 3],
  ["operator.maxLanesPerRepo", 2],
  ["operator.dailyBudgetUsd", 150],
  ["operator.maxTicketsPerDay", 20],
  ["operator.pollIntervalSeconds", 60],
  ["operator.allowBurstLane", false],
  ["operator.maxAttempts", 2],
  ["operator.abandonDays", 7],
  ["operator.intake", {}],
  ["operator.steeringApprovers", "tui"],
  ["operator.workers", "auto"],
  ["operator.visibleStages", ["plan", "gate", "implement", "review", "security", "judge"]],
  ["operator.interrupt.onIdleWithoutVerdict", "ask"],
  ["operator.fusion.stack", []],
  ["operator.fusion.providerConcurrency", {}],
  ["operator.fusion.budgetMultiplier", 1.6],
  ["operator.fusion.slotTimeoutSeconds", 300],
  ["operator.fusion.off", false],
  ["operator.notify", {}],
  ["operator.gcDays", 7],
  ["operator.landReminderDays", 3],
  ["operator.codify.enabled", true],
  ["operator.codify.repos", []],
  ["operator.codify.eligibility", "landed"],
  ["operator.codify.minRecurrence", 2],
  ["operator.codify.schedule", "idle+daily@03:00"],
  ["operator.codify.window", "30d/300"],
  ["operator.codify.reserveUsd", 15],
  ["operator.codify.maxPerDay", 3],
  ["operator.codify.maxCandidatesPerRun", 2],
  ["operator.codify.requireIdleLanes", 1],
  ["operator.codify.forwardRoi", 3],
  ["operator.codify.dispatch", "exact"],
  ["operator.codify.pythonDeps", []],
  ["operator.codify.maxActivePerRepo", 25],
  ["operator.codify.maxActiveGlobal", 50],
  ["operator.codify.staleDays", 90],
  ["operator.codify.shadowAgreeToActivate", 2],
  ["operator.codify.demoteAfterFailures", 2],
  ["operator.codify.cooldownDays", 30],
  ["operator.codify.taskTools.unattended", "never"],
  // trackers[] entry defaults (conditional on kind for transitionOnClaim)
  ["trackerEntry.label", "factory:ready"],
  ["trackerEntry.transitionOnClaim", { github: false, jira: true, "azure-devops": true }],
  ["trackerEntry.transitionOnMerge", false],
  ["trackerEntry.assignOnClaim", false],
  // defaults / repo
  ["repo.branching.nameTemplate", "factory/{tracker}-{id}-{slug}"],
  ["repo.branching.titleTemplate", "{kind}: {title} ({ref})"],
  ["repo.branching.draftPolicy", "elevated"],
  ["repo.branching.linkStyle", "auto"],
  ["repo.setupTimeoutSeconds", 600],
  ["repo.installTimeoutSeconds", 300],
  ["repo.allowInstallScripts", false],
  ["repo.codegenCommands", []],
  ["repo.checks", []],
  ["repo.checksTimeoutSeconds", 900],
  ["repo.checksConcurrency", 1],
  ["repo.stageTimeoutSeconds", 1800],
  ["repo.testDir", "tests"],
  ["repo.testPattern", "**/*.test.*"],
  [
    "repo.testInfra",
    [
      "**/conftest.py", "pyproject.toml", "tox.ini", "setup.py", "setup.cfg", "pytest.ini",
      "tsconfig*.json", "vitest.*", "jest.*", ".mocharc*", "babel*", ".npmrc", "Makefile",
      ".github/**", ".husky/**", ".githooks/**",
    ],
  ],
  ["repo.writeRoots.feature", [...SRC, "migrations/**", "docs/**", "README.md"]],
  ["repo.writeRoots.enhancement", [...SRC, "docs/**", "README.md"]],
  ["repo.writeRoots.bug", [...SRC]],
  [
    "repo.writeRoots.chore",
    [
      ...SRC, "docs/**", "README.md", "CHANGELOG.md", "scripts/**", ".github/**", "package.json",
      "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "pyproject.toml", "poetry.lock", "requirements*.txt",
    ],
  ],
  [
    "repo.riskPaths",
    [
      "auth/**", "**/auth/**", "**/crypto/**", "migrations/**", "**/migrations/**",
      "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "poetry.lock",
      "requirements*.txt", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
      ".github/**", ".gitlab-ci.yml", "Jenkinsfile",
    ],
  ],
  ["repo.securityPaths", ["auth/**", "**/auth/**", "**/crypto/**", "**/security/**", "**/secrets/**"]],
  ["repo.exclusivePaths", []],
  ["repo.generatedPaths", []],
  ["repo.maxDiffLines", 400],
  ["repo.maxChangedFiles", 15],
  ["repo.laneEnv", {}],
  ["repo.steering", "always"],
  ["repo.planApproval", "never"],
  ["repo.sandbox", "required"],
];

describe("DEFAULTS mirrors the spec §2.2 table", () => {
  it.each(table)("%s = %j", (path, expected) => {
    expect(dig(DEFAULTS, path)).toEqual(expected);
  });

  it("generatedDocPatterns is the built-in list from spec §2.5", () => {
    expect(GENERATED_DOC_PATTERNS).toEqual([
      "**/PLAN.md", "**/*.plan.md", "**/spec.md", "**/design.md", "**/diagnosis.md", "**/steer-packet.md",
      "**/issue-brief.md", "**/analysis.md", "**/review.md", "**/verdict.md", "docs/superpowers/**", ".omc/**",
      ".pi/*.local.*", ".pi/factory-rules*.yaml", "**/*.ai.md",
    ]);
    expect(DEFAULTS.repo.generatedDocPatterns).toEqual([...GENERATED_DOC_PATTERNS]);
  });

  it("keys the spec marks probed or unset have no built-in value", () => {
    for (const path of [
      "operator.worktreeRoot", "operator.providerKeyEnv", "operator.steerTimeoutHours", "operator.enabledModels",
      "operator.github.appToken", "operator.intake.model", "operator.fusion.synthesizer", "operator.notify.command",
      "repo.branching.base", "repo.branching.target", "repo.setupCommand", "repo.dependencyUpdateCommand",
      "repo.laneEnv.template", "repo.laneEnv.basePort",
    ]) {
      expect(dig(DEFAULTS, path), path).toBeUndefined();
    }
  });

  it("is a fresh object graph (callers may structuredClone it safely)", () => {
    expect(structuredClone(DEFAULTS)).toEqual(DEFAULTS);
  });
});
