import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGates, allGatesOk } from "../../../src/controller/predicates.js";
import { evidencePath, writeEvidence, type EvidenceRecord } from "../../../src/engine/evidence.js";
import { makeRepoConfig, makeRunState } from "../../helpers/steer-fixtures.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import { pinWorkspaceArtifacts } from "../../../src/controller/stage-hooks.js";
import type { StepContext } from "../../../src/engine/types.js";

const SECRET = "ab".repeat(32);

function evidenceRecord(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    stage: "implement",
    round: 0,
    agent: "implementer",
    verdict: "PASS",
    predicates: [],
    artifacts: [],
    commands: [],
    synthesized: [],
    timedOut: false,
    headSha: "abc123",
    at: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

const JUNIT_GREEN = `<?xml version="1.0"?><testsuite name="t" tests="1" failures="0" errors="0"><testcase name="ok"/></testsuite>`;
const JUNIT_RED = `<?xml version="1.0"?><testsuite name="t" tests="1" failures="1" errors="0"><testcase name="bad"><failure/></testcase></testsuite>`;

function ctxFor(runDir: string, ws: string, over: Partial<StepContext> = {}): StepContext {
  const state = makeRunState({ runId: "run-1", workspaceDir: ws, judgedSha: "a".repeat(40) });
  return {
    state,
    runDir,
    workspaceDir: ws,
    cfg: makeRepoConfig({
      checks: [{ name: "vitest", argv: ["true"], reporter: "junit", timeoutSeconds: 30, junitPath: "reports/junit.xml" }],
    }),
    nonce: "n",
    emit: () => undefined,
    signal: new AbortController().signal,
    ...over,
  };
}

describe("evaluateGates", () => {
  let root: string;
  let runDir: string;
  let ws: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sdlc-pred-"));
    runDir = join(root, "runs", "run-1");
    ws = join(root, "ws");
    await mkdir(join(ws, "reports"), { recursive: true });
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("junit-green requires the report to exist and have zero failures", async () => {
    const ctx = ctxFor(runDir, ws);
    expect((await evaluateGates(ctx, ["junit-green"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(join(ws, "reports", "junit.xml"), JUNIT_RED);
    expect((await evaluateGates(ctx, ["junit-green"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(join(ws, "reports", "junit.xml"), JUNIT_GREEN);
    expect((await evaluateGates(ctx, ["junit-green"], { verdict: "PASS" }))[0]?.ok).toBe(true);
  });

  it("sections: requires the named headings", async () => {
    const ctx = ctxFor(runDir, ws);
    await writeFile(join(runDir, "plan.md"), "## Goal\n## Files to touch\n");
    const miss = await evaluateGates(ctx, ["sections:plan.md:Goal,Files to touch,Steps"], { verdict: "PASS" });
    expect(miss[0]?.ok).toBe(false);
    await writeFile(join(runDir, "plan.md"), "## Goal\n## Files to touch\n## Steps\n");
    const hit = await evaluateGates(ctx, ["sections:plan.md:Goal,Files to touch,Steps"], { verdict: "PASS" });
    expect(hit[0]?.ok).toBe(true);
  });

  it("unknown predicates fail closed; catalog ids that v0 defers still no-op", async () => {
    const ctx = ctxFor(runDir, ws);
    const unknown = await evaluateGates(ctx, ["not-a-real-gate", "junit-green"], { verdict: "PASS" });
    expect(unknown[0]).toMatchObject({ name: "not-a-real-gate", ok: false, note: "unknown predicate" });
    expect(allGatesOk(unknown)).toBe(false);
    const deferred = await evaluateGates(ctx, ["citations", "checklist", "ac-spotcheck"], { verdict: "PASS" });
    expect(deferred.every((r) => r.ok && r.note === "v0: not enforced")).toBe(true);
  });

  it("evidence-signed verifies every record, not only the lexicographically last filename", async () => {
    await writeFile(join(runDir, ".secret"), SECRET);
    const ctx = ctxFor(runDir, ws);
    await writeEvidence(runDir, evidenceRecord({ stage: "implement" }), SECRET);
    await writeEvidence(runDir, evidenceRecord({ stage: "review" }), SECRET);
    expect((await evaluateGates(ctx, ["evidence-signed"], { verdict: "PASS" }))[0]?.ok).toBe(true);
    const implementPath = evidencePath(runDir, "implement", 0);
    const raw = await readFile(implementPath, "utf8");
    await writeFile(implementPath, raw.replace('"verdict": "PASS"', '"verdict": "FAIL"'));
    const failed = (await evaluateGates(ctx, ["evidence-signed"], { verdict: "PASS" }))[0];
    expect(failed?.ok).toBe(false);
    expect(failed?.note).toMatch(/implement-r0/);
  });

  it("no-synthesized fails when any prior evidence record lists synthesized paths", async () => {
    await writeFile(join(runDir, ".secret"), SECRET);
    const ctx = ctxFor(runDir, ws);
    await writeEvidence(runDir, evidenceRecord({ stage: "implement", synthesized: [] }), SECRET);
    expect((await evaluateGates(ctx, ["no-synthesized"], { verdict: "PASS" }))[0]?.ok).toBe(true);
    await writeEvidence(runDir, evidenceRecord({ stage: "review", synthesized: ["src/a.ts"] }), SECRET);
    const hit = (await evaluateGates(ctx, ["no-synthesized"], { verdict: "PASS" }))[0];
    expect(hit?.ok).toBe(false);
    expect(hit?.note).toMatch(/review-r0/);
  });

  it("preflight and head-is-judged-sha are real gates on a judged workspace", async () => {
    const judged = await makeJudgedWorkspace();
    try {
      pinWorkspaceArtifacts(judged.state, judged.ws);
      const ctx = ctxFor(runDir, judged.ws.path, {
        state: judged.state,
        cfg: judged.cfg,
        workspaceDir: judged.ws.path,
      });
      const head = await evaluateGates(ctx, ["head-is-judged-sha"], { verdict: "PASS" });
      expect(head[0]).toMatchObject({ name: "head-is-judged-sha", ok: true });
      const pre = await evaluateGates(ctx, ["preflight"], { verdict: "PASS" });
      expect(pre[0]).toMatchObject({ name: "preflight", ok: true });
      const stale = await evaluateGates(
        ctxFor(runDir, judged.ws.path, {
          state: { ...judged.state, judgedSha: "0".repeat(40) },
          cfg: judged.cfg,
          workspaceDir: judged.ws.path,
        }),
        ["head-is-judged-sha", "preflight"],
        { verdict: "PASS" },
      );
      expect(stale[0]?.ok).toBe(false);
      expect(stale[1]?.ok).toBe(false);
    } finally {
      await judged.cleanup();
    }
  });
});
