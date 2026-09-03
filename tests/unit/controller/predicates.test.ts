import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGates, allGatesOk } from "../../../src/controller/predicates.js";
import { evidencePath, writeEvidence, type EvidenceRecord } from "../../../src/engine/evidence.js";
import { snapshotTree } from "../../../src/gate/snapshot.js";
import { makeRepoConfig, makeRunState } from "../../helpers/steer-fixtures.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import { pinWorkspaceArtifacts } from "../../../src/controller/stage-hooks.js";
import { writeGeneratedJson } from "../../../src/engine/state.js";
import type { StepContext, StepResult } from "../../../src/engine/types.js";
import type { Workspace } from "../../../src/workspace/types.js";

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

  it("unknown predicates fail closed and leftover catalog ids are enforced", async () => {
    const ctx = ctxFor(runDir, ws);
    const unknown = await evaluateGates(ctx, ["not-a-real-gate", "junit-green"], { verdict: "PASS" });
    expect(unknown[0]).toMatchObject({ name: "not-a-real-gate", ok: false, note: "unknown predicate" });
    expect(allGatesOk(unknown)).toBe(false);
    const leftover = await evaluateGates(ctx, ["citations", "checklist", "ac-spotcheck"], { verdict: "PASS" });
    expect(leftover.every((r) => r.note !== "v0: not enforced")).toBe(true);
    expect(leftover.find((r) => r.name === "citations")?.ok).toBe(false);
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

  it("red-baseline parses junit and escalates per RedResult", async () => {
    const ctx = ctxFor(runDir, ws);
    ctx.state.artifacts["gate.testIds"] = JSON.stringify(["bad"]);
    expect((await evaluateGates(ctx, ["red-baseline"], { verdict: "PASS" }))[0]).toMatchObject({
      ok: false,
      escalate: "gate-invalid",
    });
    await writeFile(join(ws, "reports", "junit.xml"), JUNIT_RED);
    const red = (await evaluateGates(ctx, ["red-baseline"], { verdict: "PASS" }))[0];
    expect(red?.ok).toBe(true);
    await writeFile(join(ws, "reports", "junit.xml"), JUNIT_GREEN);
    ctx.state.artifacts["gate.testIds"] = JSON.stringify(["ok"]);
    const green = (await evaluateGates(ctx, ["red-baseline"], { verdict: "PASS" }))[0];
    expect(green?.ok).toBe(false);
    expect(green?.escalate).toBe("gate-baseline-green");
  });

  it("citations requires a path:line or junit id in review.md", async () => {
    const ctx = ctxFor(runDir, ws);
    expect((await evaluateGates(ctx, ["citations"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(join(runDir, "review.md"), "looks fine, no pointers\n");
    expect((await evaluateGates(ctx, ["citations"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(join(runDir, "review.md"), "src/added.ts:1 is the helper\n");
    expect((await evaluateGates(ctx, ["citations"], { verdict: "PASS" }))[0]?.ok).toBe(true);
    await writeFile(join(runDir, "review.md"), "covered by tests/smoke.test.ts::smoke: add\n");
    expect((await evaluateGates(ctx, ["citations"], { verdict: "PASS" }))[0]?.ok).toBe(true);
  });

  it("verdict-consistent rejects PASS/approved with a nonempty blocking list", async () => {
    const ctx = ctxFor(runDir, ws);
    await writeFile(join(runDir, "review.md"), JSON.stringify({ verdict: "PASS", blocking: [] }));
    expect((await evaluateGates(ctx, ["verdict-consistent"], { verdict: "PASS" }))[0]?.ok).toBe(true);
    await writeFile(join(runDir, "review.md"), JSON.stringify({ verdict: "PASS", blocking: ["src/a.ts:1 leak"] }));
    const hit = (await evaluateGates(ctx, ["verdict-consistent"], { verdict: "PASS" }))[0];
    expect(hit?.ok).toBe(false);
  });

  it("checklist and ac-spotcheck require AC coverage when ACs exist", async () => {
    const ctx = ctxFor(runDir, ws, {
      cfg: makeRepoConfig({
        checks: [{ name: "vitest", argv: ["true"], reporter: "junit", timeoutSeconds: 30, junitPath: "reports/junit.xml" }],
        testDir: "tests",
      }),
    });
    await mkdir(join(ws, "tests"), { recursive: true });
    expect((await evaluateGates(ctx, ["checklist", "ac-spotcheck"], { verdict: "PASS" })).every((r) => r.ok)).toBe(true);
    await writeFile(join(runDir, "plan.md"), "AC1: greet the caller\nAC2: reject empty names\n");
    const missing = await evaluateGates(ctx, ["checklist", "ac-spotcheck"], { verdict: "PASS" });
    expect(missing[0]?.ok).toBe(false);
    expect(missing[1]?.ok).toBe(false);
    await writeFile(join(runDir, "review.md"), "AC1 is covered by the helper test\n");
    await writeFile(join(ws, "tests", "greet.test.ts"), 'test("greet the caller", () => {});\n');
    const covered = await evaluateGates(ctx, ["checklist", "ac-spotcheck"], { verdict: "PASS" });
    expect(covered[0]?.ok).toBe(false);
    expect(covered[1]?.ok).toBe(true);
    await writeFile(join(runDir, "review.md"), "AC1 greet the caller; AC2 reject empty names\n");
    expect((await evaluateGates(ctx, ["checklist"], { verdict: "PASS" }))[0]?.ok).toBe(true);
  });

  it("deps-approval fails when implement requested deps without an approval artifact", async () => {
    const ctx = ctxFor(runDir, ws);
    await mkdir(join(runDir, "_verdicts"), { recursive: true });
    await writeFile(
      join(runDir, "_verdicts", "implement-r0.json"),
      JSON.stringify({ step: "implement", verdict: "PASS", dependenciesRequested: ["left-pad"] }),
    );
    const missing = (await evaluateGates(ctx, ["deps-approval"], { verdict: "PASS" }))[0];
    expect(missing?.ok).toBe(false);
    await writeFile(join(runDir, "dependency-approval.json"), JSON.stringify({ approved: ["left-pad"] }));
    expect((await evaluateGates(ctx, ["deps-approval"], { verdict: "PASS" }))[0]?.ok).toBe(true);
  });

  it("stuck-detector escalates stall when the last two records share issues", async () => {
    const issues = ["src/a.ts:1 still broken"];
    const ctx = ctxFor(runDir, ws, {
      state: makeRunState({
        runId: "run-1",
        workspaceDir: ws,
        judgedSha: "a".repeat(40),
        currentStep: "implement",
        steps: [
          {
            name: "implement",
            round: 0,
            verdict: "FAIL",
            issues,
            startedAt: "2026-09-02T00:00:00.000Z",
            endedAt: "2026-09-02T00:00:01.000Z",
          },
          {
            name: "implement",
            round: 1,
            verdict: "FAIL",
            issues,
            startedAt: "2026-09-02T00:01:00.000Z",
            endedAt: "2026-09-02T00:01:01.000Z",
          },
        ],
      }),
    });
    const stuck = (await evaluateGates(ctx, ["stuck-detector"], { verdict: "FAIL", issues }))[0];
    expect(stuck?.ok).toBe(false);
    expect(stuck?.escalate).toBe("stall");
    ctx.state.steps[1] = { ...ctx.state.steps[1]!, issues: ["src/b.ts:2 other"] };
    expect((await evaluateGates(ctx, ["stuck-detector"], { verdict: "FAIL" }))[0]?.ok).toBe(true);
  });

  it("flaky-rerun is ok when checks-green and fails when the last check still failed", async () => {
    const ctx = ctxFor(runDir, ws);
    const green: StepResult = {
      verdict: "PASS",
      evidence: { commands: [{ argv: ["true"], exitCode: 0, durationMs: 1, outputTail: "" }] },
    };
    expect((await evaluateGates(ctx, ["flaky-rerun"], green))[0]?.ok).toBe(true);
    const failed: StepResult = {
      verdict: "FAIL",
      evidence: { commands: [{ argv: ["false"], exitCode: 1, durationMs: 1, outputTail: "boom" }] },
    };
    expect((await evaluateGates(ctx, ["flaky-rerun"], failed))[0]?.ok).toBe(false);
  });
});

describe("evaluateGates git-backed leftovers", () => {
  let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
  let runDir: string;
  let ctx: StepContext;
  let workspace: Workspace;

  beforeEach(async () => {
    fx = await makeFixtureRepo();
    const root = await mkdtemp(join(tmpdir(), "pi-sdlc-pred-git-"));
    runDir = join(root, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    workspace = {
      provider: "git",
      path: fx.repo,
      branch: "main",
      baseSha: fx.baseSha,
      repoRoot: fx.repo,
      gitCommonDir: join(fx.repo, ".git"),
      configSha: "c".repeat(64),
    };
    const state = makeRunState({
      runId: "run-1",
      workspaceDir: fx.repo,
      mainCheckout: fx.repo,
      baseSha: fx.baseSha,
      kind: "chore",
      currentStep: "implement",
    });
    pinWorkspaceArtifacts(state, workspace);
    ctx = {
      state,
      runDir,
      workspaceDir: fx.repo,
      cfg: makeRepoConfig({
        repoRoot: fx.repo,
        testDir: "tests",
        testInfra: ["package.json"],
        writeRoots: {
          feature: ["src/**"],
          enhancement: ["src/**"],
          bug: ["src/**"],
          chore: ["src/**", "tests/**"],
        },
        checks: [{ name: "vitest", argv: ["true"], reporter: "junit", timeoutSeconds: 30, junitPath: "reports/junit.xml" }],
      }),
      nonce: "n",
      emit: () => undefined,
      signal: new AbortController().signal,
    };
  });

  afterEach(async () => {
    await fx.cleanup();
    await rm(join(runDir, "..", ".."), { recursive: true, force: true });
  });

  it("snapshot fails closed without a before-image and fails out-of-root writes", async () => {
    const missing = (await evaluateGates(ctx, ["snapshot"], { verdict: "PASS" }))[0];
    expect(missing?.ok).toBe(false);
    const before = await snapshotTree(workspace);
    ctx.state.artifacts["snapshot.before"] = JSON.stringify(before);
    expect((await evaluateGates(ctx, ["snapshot"], { verdict: "PASS" }))[0]?.ok).toBe(true);
    await writeFile(join(fx.repo, "CHANGELOG.md"), "# leaked\n", "utf8");
    expect((await evaluateGates(ctx, ["snapshot"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(join(fx.repo, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- Initial fixture package.\n", "utf8");
    await writeFile(join(fx.repo, "src", "added.ts"), "export const x = 1;\n", "utf8");
    expect((await evaluateGates(ctx, ["snapshot"], { verdict: "PASS" }))[0]?.ok).toBe(true);
  });

  it("snapshot:testDir only allows changes under testDir", async () => {
    const before = await snapshotTree(workspace);
    ctx.state.artifacts["snapshot.before"] = JSON.stringify(before);
    await writeFile(join(fx.repo, "src", "index.ts"), "export const leaked = 1;\n", "utf8");
    expect((await evaluateGates(ctx, ["snapshot:testDir"], { verdict: "PASS" }))[0]?.ok).toBe(false);
    await writeFile(
      join(fx.repo, "src", "index.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export function greet(name: string): string {",
        '  return "hello, " + name;',
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(join(fx.repo, "tests", "extra.test.ts"), "test('x', () => {});\n", "utf8");
    expect((await evaluateGates(ctx, ["snapshot:testDir"], { verdict: "PASS" }))[0]?.ok).toBe(true);
  });

  it("manifest-record persists JSON and manifest verifies undeclared test edits", async () => {
    const recorded = (await evaluateGates(ctx, ["manifest-record"], { verdict: "PASS" }))[0];
    expect(recorded?.ok).toBe(true);
    expect(ctx.state.artifacts["manifest.json"]).toBeTruthy();
    const raw = await readFile(join(runDir, "manifest.json"), "utf8");
    expect(raw).toContain("tests/smoke.test.ts");
    expect((await evaluateGates(ctx, ["manifest"], { verdict: "PASS" }))[0]?.ok).toBe(true);
    await writeFile(join(fx.repo, "tests", "smoke.test.ts"), 'test("tamper", () => {});\n', "utf8");
    const tampered = (await evaluateGates(ctx, ["manifest"], { verdict: "PASS" }))[0];
    expect(tampered?.ok).toBe(false);
    await writeFile(
      join(fx.repo, "tests", "skip.test.ts"),
      'it.skip("hidden", () => {});\n',
      "utf8",
    );
    const skip = (await evaluateGates(ctx, ["manifest"], { verdict: "PASS" }))[0];
    expect(skip?.ok).toBe(false);
    expect(skip?.escalate).toBe("test-tampering");
  });

  it("test-infra-restore fails when a testInfra path drifted from base", async () => {
    expect((await evaluateGates(ctx, ["test-infra-restore"], { verdict: "PASS" }))[0]?.ok).toBe(true);
    await writeFile(join(fx.repo, "package.json"), JSON.stringify({ name: "drifted" }), "utf8");
    expect((await evaluateGates(ctx, ["test-infra-restore"], { verdict: "PASS" }))[0]?.ok).toBe(false);
  });

  it("finalize and scope-report use writeRoots and size caps", async () => {
    await writeFile(join(fx.repo, "src", "added.ts"), "export const x = 1;\n", "utf8");
    const ok = await evaluateGates(ctx, ["finalize", "scope-report"], { verdict: "PASS" });
    expect(ok[0]?.ok).toBe(true);
    expect(ok[1]?.ok).toBe(true);
    await writeFile(join(fx.repo, "CHANGELOG.md"), "# leaked changelog\n", "utf8");
    const out = await evaluateGates(ctx, ["finalize", "scope-report"], { verdict: "PASS" });
    expect(out[0]?.ok).toBe(false);
    expect(out[1]?.ok).toBe(false);
  });

  it("manifest-record writes a generated JSON artifact the caller can reload", async () => {
    await evaluateGates(ctx, ["manifest-record"], { verdict: "PASS" });
    const stored = ctx.state.artifacts["manifest.json"];
    expect(stored).toBeTruthy();
    await writeGeneratedJson(join(runDir, "copy.json"), "run-1", { ok: true });
    expect(await readFile(join(runDir, "manifest.json"), "utf8")).toMatch(/pi-sdlc-factory generated/);
  });
});
