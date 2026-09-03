import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../../../src/config/defaults.js";
import {
  appendCodifyInbox,
  codifyInboxPath,
  landedFromInbox,
  readCodifyInbox,
  stampLanded,
  type CodifyInboxRecord,
} from "../../../src/codify/inbox.js";
import {
  clusterExecutions,
  isEligible,
  isNeverCandidate,
  toCandidate,
  verifiedExecutions,
} from "../../../src/codify/miner.js";
import { stageSignature } from "../../../src/codify/signature.js";
import type { CodifyConfig, FeatureVector, StageExecution, VerifyEvidenceFn } from "../../../src/codify/types.js";
import {
  cleanLanded,
  versionBumpEvidence,
  versionBumpExecution,
} from "../../helpers/codify-cluster.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpRuns(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-sdlc-codify-inbox-"));
  created.push(dir);
  return dir;
}

const cfg: CodifyConfig = { ...DEFAULTS.operator.codify, repos: ["acme/widgets"] };

const SCORE_08: FeatureVector = {
  reproducibleByCommand: 1,
  diffIsSubstitution: 1,
  literalsSourced: 1,
  zeroFixRounds: 1,
  lowModelEffort: 0,
  planImperative: 0,
  small: 0,
};

const SCORE_06: FeatureVector = {
  reproducibleByCommand: 1,
  diffIsSubstitution: 0,
  literalsSourced: 1,
  zeroFixRounds: 1,
  lowModelEffort: 0,
  planImperative: 0,
  small: 0,
};

function inboxRow(over: Partial<CodifyInboxRecord> = {}): CodifyInboxRecord {
  return {
    ref: "github:acme/widgets#1",
    runId: "run-bump-1",
    lane: "chore",
    branch: "factory/github-1-bump",
    baseSha: "a".repeat(40),
    judgedSha: "b".repeat(40),
    hostCommits: ["b".repeat(40)],
    patchIds: ["p1"],
    changedFiles: ["package.json", "package-lock.json"],
    writeGlobs: ["package.json", "package-lock.json"],
    publishedAt: "2026-09-03T00:00:00.000Z",
    kind: "chore",
    stages: ["implement"],
    state: "published",
    ...over,
  };
}

function neverOf(over: Parameters<typeof versionBumpExecution>[0], rejected = {}, now = new Date("2026-09-03T00:00:00.000Z")) {
  return isNeverCandidate(versionBumpExecution(over), rejected, now, 30);
}

describe("toCandidate / clusterExecutions", () => {
  it("clusters two landed chore implement version-bumps scoring 0.8 into one candidate", () => {
    const a = versionBumpExecution({ runId: "r1", features: SCORE_08, landed: cleanLanded("r1") });
    const b = versionBumpExecution({ runId: "r2", features: SCORE_08, landed: cleanLanded("r2") });
    expect(stageSignature(a)).toBe(stageSignature(b));
    const clusters = clusterExecutions([a, b]);
    expect(clusters).toHaveLength(1);
    const cand = toCandidate(clusters[0]!, cfg);
    expect(cand).not.toBeNull();
    expect(cand?.members.map((m) => m.runId).sort()).toEqual(["r1", "r2"]);
    expect(cand?.preScore).toBeCloseTo(0.8);
    expect(cand?.shape).toBe("version-bump");
    expect(cand?.classHint).toBe("stage-tool");
    expect(cand?.stage).toBe("implement");
    expect(cand?.kind).toBe("chore");
  });

  it("accepts N=1 when preScore >= 0.7 and a mechanical shape hits", () => {
    const ex = versionBumpExecution({ runId: "r1", features: SCORE_08, landed: cleanLanded("r1") });
    const cand = toCandidate(clusterExecutions([ex])[0]!, cfg);
    expect(cand).not.toBeNull();
    expect(cand?.members).toHaveLength(1);
  });

  it("rejects N=1 when preScore is 0.6 with no mechanical shape", () => {
    const ex = versionBumpExecution({
      runId: "r1",
      features: SCORE_06,
      changedFiles: ["src/a.ts"],
      diff: { files: [{ path: "src/a.ts", op: "M", hunkLines: 10 }], literals: ["1.2.3"], sourced: ["1.2.3"] },
      landed: cleanLanded("r1"),
    });
    const cluster = clusterExecutions([ex])[0]!;
    expect(cluster.shape).toBeNull();
    expect(cluster.preScore).toBeCloseTo(0.6);
    expect(toCandidate(cluster, cfg)).toBeNull();
  });
});

describe("isNeverCandidate", () => {
  it("refuses review, judge, gate, and steer executions", () => {
    for (const stage of ["review", "judge", "gate", "steer"]) {
      expect(neverOf({ stage }).never, stage).toBe(true);
    }
  });

  it("refuses synthesized, humanIntervened, escalation, and riskPath", () => {
    expect(neverOf({ flags: { synthesized: true } }).never).toBe(true);
    expect(neverOf({ flags: { humanIntervened: true } }).never).toBe(true);
    expect(neverOf({ flags: { escalated: true } }).never).toBe(true);
    expect(neverOf({ touches: { risk: true } }).never).toBe(true);
  });

  it("refuses a rejected signature inside cooldownDays", () => {
    const ex = versionBumpExecution();
    const rejected = { [stageSignature(ex)]: { rejectedAt: "2026-08-20T00:00:00.000Z" } };
    expect(isNeverCandidate(ex, rejected, new Date("2026-09-03T00:00:00.000Z"), 30).never).toBe(true);
    expect(isNeverCandidate(ex, rejected, new Date("2026-10-01T00:00:00.000Z"), 30).never).toBe(false);
  });
});

describe("eligibility and inbox", () => {
  it("eligibility: landed ignores published inbox rows until stampLanded", async () => {
    const runs = await tmpRuns();
    const rec = inboxRow({ runId: "run-bump-1" });
    await appendCodifyInbox(runs, rec);
    const raw = await readFile(codifyInboxPath(runs), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const published = await readCodifyInbox(runs);
    expect(published).toHaveLength(1);
    expect(published[0]?.state).toBe("published");
    const ex = versionBumpExecution({ runId: "run-bump-1" });
    expect(isEligible(ex, landedFromInbox(published[0]!), "landed")).toBe(false);
    expect(isEligible(ex, landedFromInbox(published[0]!), "published")).toBe(true);

    await stampLanded(runs, cleanLanded("run-bump-1"));
    const landedRows = await readCodifyInbox(runs);
    expect(landedRows[0]?.state).toBe("landed");
    expect(landedRows[0]?.landedAs).toBe("clean");
    const landed = landedFromInbox(landedRows[0]!);
    expect(isEligible(ex, landed, "landed")).toBe(true);
  });

  it("eligibility: published includes unpublished members at weight 0.5 and probationaryOnly", () => {
    const ex = versionBumpExecution({
      runId: "r1",
      features: SCORE_08,
      publishedOnly: true,
    });
    expect(isEligible(ex, undefined, "published")).toBe(true);
    const cand = toCandidate(clusterExecutions([ex])[0]!, cfg);
    expect(cand).not.toBeNull();
    expect(cand?.probationaryOnly).toBe(true);
    expect(cand?.members[0]?.weight).toBe(0.5);
  });

  it("survival is not a gate: a reverted member still clusters", () => {
    const landed = cleanLanded("r1", { survival: { reverted: true, retouched: false, linkedBug: false } });
    const ex = versionBumpExecution({ runId: "r1", features: SCORE_08, landed });
    expect(isNeverCandidate(ex, {}, new Date("2026-09-03T00:00:00.000Z"), 30).never).toBe(false);
    expect(isEligible(ex, landed, "landed")).toBe(true);
    expect(clusterExecutions([ex])).toHaveLength(1);
    expect(toCandidate(clusterExecutions([ex])[0]!, cfg)).not.toBeNull();
  });
});

describe("verifiedExecutions", () => {
  it("keeps executions when injected verifyEvidence returns the record", async () => {
    const ex = versionBumpExecution();
    const ok: VerifyEvidenceFn = async () => ({ ok: true, record: versionBumpEvidence() });
    expect(await verifiedExecutions([{ execution: ex, runDir: "/runs/r1", round: 0, secret: "ab".repeat(32) }], ok)).toEqual([ex]);
  });

  it("drops executions when injected verifyEvidence fails", async () => {
    const ex = versionBumpExecution();
    const bad: VerifyEvidenceFn = async () => ({ ok: false, record: null, reason: "signature mismatch" });
    expect(await verifiedExecutions([{ execution: ex, runDir: "/runs/r1", round: 0, secret: "ab".repeat(32) }], bad)).toEqual([]);
  });
});

describe("isEligible published vs landed", () => {
  it("landed eligibility requires a LandedRecord", () => {
    const ex = versionBumpExecution({ runId: "r1" });
    expect(isEligible(ex, undefined, "landed")).toBe(false);
    expect(isEligible(ex, cleanLanded("r1"), "landed")).toBe(true);
  });
});
