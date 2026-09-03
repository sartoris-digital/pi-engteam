// tests/helpers/fake-repo-cfg.ts — a complete EffectiveRepoConfig for unit tests that need one.
import type { EffectiveRepoConfig } from "../../src/config/schema.js";

export function fakeRepoCfg(overrides: Partial<EffectiveRepoConfig> = {}): EffectiveRepoConfig {
  return {
    repoRoot: "/nonexistent/repo",
    remote: "origin",
    branching: {
      base: "main",
      target: "main",
      nameTemplate: "factory/{tracker}-{id}-{slug}",
      titleTemplate: "{kind}: {title}",
      draftPolicy: "elevated",
      linkStyle: "closes",
    },
    checks: [],
    testDir: "tests",
    testPattern: "**/*.test.ts",
    testInfra: [],
    setupTimeoutSeconds: 600,
    allowInstallScripts: false,
    writeRoots: { feature: ["src/**"], enhancement: ["src/**"], bug: ["src/**"], chore: ["src/**"] },
    riskPaths: [],
    securityPaths: [],
    exclusivePaths: [],
    generatedPaths: [],
    maxDiffLines: 400,
    maxChangedFiles: 15,
    steering: "always",
    planApproval: "never",
    stageTimeoutSeconds: 1800,
    checksTimeoutSeconds: 900,
    checksConcurrency: 1,
    generatedDocPatterns: ["docs/plans/**", "**/*.factory.md"],
    sandbox: "off",
    ...overrides,
  };
}
