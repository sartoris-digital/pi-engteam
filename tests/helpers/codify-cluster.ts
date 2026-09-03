// tests/helpers/codify-cluster.ts — signed evidence + host diffs for a version-bump cluster.
import type { EvidenceRecord } from "../../src/engine/types.js";
import type { LandedRecord, StageDiff, StageExecution } from "../../src/codify/types.js";

const SEMVER = "1.2.3";

export const CLEAN_FLAGS: StageExecution["flags"] = {
  synthesized: false,
  humanIntervened: false,
  escalated: false,
  tampered: false,
  conflict: false,
  revise: false,
};

export const CLEAN_TOUCHES: StageExecution["touches"] = {
  security: false,
  risk: false,
  exclusive: false,
};

export type ExecutionOver = Partial<Omit<StageExecution, "flags" | "touches" | "diff">> & {
  flags?: Partial<StageExecution["flags"]>;
  touches?: Partial<StageExecution["touches"]>;
  diff?: Partial<StageDiff>;
};

export function versionBumpDiff(version = SEMVER): StageDiff {
  return {
    files: [
      { path: "package.json", op: "M", hunkLines: 2 },
      { path: "package-lock.json", op: "M", hunkLines: 8 },
    ],
    literals: [version],
    sourced: [version],
  };
}

export function versionBumpExecution(over: ExecutionOver = {}): StageExecution {
  const version = SEMVER;
  const baseDiff = versionBumpDiff(version);
  return {
    runId: "run-bump-1",
    repo: "acme/widgets",
    stage: "implement",
    kind: "chore",
    lane: "chore",
    tier: "low",
    headSha: "b".repeat(40),
    parentSha: "a".repeat(40),
    commands: [{ argv: ["npm", "version", version] }],
    toolCallCount: 4,
    fixRounds: 0,
    changedFiles: ["package.json", "package-lock.json"],
    title: `Bump widgets to ${version}`,
    briefLiterals: [version],
    planLiterals: [`Bump widgets to ${version}`],
    ...over,
    diff: { ...baseDiff, ...over.diff },
    flags: { ...CLEAN_FLAGS, ...over.flags },
    touches: { ...CLEAN_TOUCHES, ...over.touches },
  };
}

export function featureDiffExecution(over: ExecutionOver = {}): StageExecution {
  const files = Array.from({ length: 12 }, (_, i) => `src/feature/mod-${i}.ts`);
  return versionBumpExecution({
    runId: "run-feat-1",
    kind: "feature",
    lane: "feature",
    title: "Implement the dashboard widgets",
    briefLiterals: [],
    planLiterals: ["Design the dashboard layout"],
    commands: [],
    toolCallCount: 40,
    fixRounds: 2,
    changedFiles: files,
    diff: {
      files: files.map((path) => ({ path, op: "A", hunkLines: 17 })),
      literals: [],
      sourced: [],
    },
    ...over,
  });
}

export function versionBumpEvidence(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    stage: "implement",
    round: 0,
    agent: "implementer",
    verdict: "PASS",
    predicates: [{ name: "snapshot", ok: true }],
    artifacts: [],
    commands: [{ argv: ["npm", "version", "1.2.3"], exitCode: 0, durationMs: 20, outputTail: "1.2.3" }],
    synthesized: [],
    timedOut: false,
    headSha: "b".repeat(40),
    at: "2026-09-03T00:00:00.000Z",
    ...over,
  };
}

export function cleanLanded(runId: string, over: Partial<LandedRecord> = {}): LandedRecord {
  return {
    runId,
    landedAs: "clean",
    landedSha: "c".repeat(40),
    patchIds: ["p1"],
    changedFiles: ["package.json", "package-lock.json"],
    survival: { reverted: false, retouched: false, linkedBug: false },
    ...over,
  };
}
