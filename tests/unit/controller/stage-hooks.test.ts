import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStageHooks, pinWorkspaceArtifacts } from "../../../src/controller/stage-hooks.js";
import { makeStepContext } from "../../helpers/steer-fixtures.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import type { WorkerExecutor, WorkerRequest, WorkerResult } from "../../../src/runtime/types.js";
import type { StageDef } from "../../../src/lanes/schema.js";
import { seedPath } from "../../../src/codify/seeds.js";
import { readLedger } from "../../../src/scheduler/ledger.js";

function stage(over: Partial<StageDef> & { name: string }): StageDef {
  return { gates: [], onFail: "fix-round", ...over } as StageDef;
}

function executor(result: WorkerResult): WorkerExecutor {
  return { run: async () => result };
}

describe("agentStep", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = join(await mkdtemp(join(tmpdir(), "pi-sdlc-hooks-")), "runs", "run-1");
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(runDir, "..", ".."), { recursive: true, force: true });
  });

  it("writes steps/<stage>-r0.prompt.md on the first attempt and never PASSes a timeout", async () => {
    const hooks = makeStageHooks({
      executor: executor({ verdict: null, exitCode: 1, timedOut: true, stderrTail: "", durationMs: 10 }),
      agents: [
        {
          name: "planner",
          model: "stub",
          promptPath: "/dev/null",
          tools: ["read"],
          stageClass: "read-only",
        },
      ],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    const run = hooks.agentStep(stage({ name: "plan", agent: "planner" }), "plan");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", steps: [] } });
    const result = await run(ctx);
    expect(result.verdict).toBe("FAIL");
    expect(result.evidence?.timedOut).toBe(true);
    await expect(readFile(join(runDir, "steps", "plan-r0.prompt.md"), "utf8")).resolves.toContain(
      "REQUIRED FINAL ACTION",
    );
  });

  it("injects OPERATOR RULES above the ticket and still starts with the generated marker", async () => {
    const hooks = makeStageHooks({
      executor: executor({
        verdict: { step: "plan", verdict: "PASS" },
        exitCode: 0,
        timedOut: false,
        stderrTail: "",
        durationMs: 1,
      }),
      agents: [{ name: "planner", model: "stub", promptPath: "/dev/null", tools: ["read"], stageClass: "read-only" }],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
      rules: [
        {
          id: "r-impl-constraint",
          text: "Always add a changelog entry.",
          scope: { repo: "*", lane: "*", stage: ["plan", "implement"], kind: "*", paths: [] },
          class: "constraint",
          enforce: ["prompt"],
          createdAt: "2026-09-02T00:00:00.000Z",
          author: "operator",
          status: "active",
        },
      ],
    });
    const run = hooks.agentStep(stage({ name: "plan", agent: "planner" }), "plan");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", steps: [] } });
    await mkdir(ctx.workspaceDir, { recursive: true });
    await run(ctx);
    const text = await readFile(join(runDir, "steps", "plan-r0.prompt.md"), "utf8");
    expect(text.startsWith("<!-- pi-sdlc-factory generated")).toBe(true);
    const rulesAt = text.indexOf("## OPERATOR RULES (binding)");
    const stageAt = text.indexOf("Stage: plan");
    expect(rulesAt).toBeGreaterThanOrEqual(0);
    expect(stageAt).toBeGreaterThan(rulesAt);
    expect(text).toContain("r-impl-constraint");
    expect(text).not.toContain("(none in v0)");
  });

  it("sets extraUpsert from writeRoots for implementer and denies testDir plus generated docs", async () => {
    let seen: WorkerRequest | undefined;
    const hooks = makeStageHooks({
      executor: {
        run: async (req) => {
          seen = req;
          return { verdict: { step: "implement", verdict: "PASS" }, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 1 };
        },
      },
      agents: [
        {
          name: "implementer",
          model: "stub",
          promptPath: "/dev/null",
          tools: ["read", "write", "edit", "bash"],
          stageClass: "writer",
        },
      ],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    const run = hooks.agentStep(stage({ name: "implement", agent: "implementer" }), "implement");
    const ctx = makeStepContext(runDir, {
      state: { runId: "run-1", kind: "chore", steps: [], workspaceDir: join(runDir, "ws") },
      cfg: {
        writeRoots: { chore: ["src/**"], feature: ["src/**"], enhancement: ["src/**"], bug: ["src/**"] },
        testDir: "tests",
        generatedDocPatterns: ["**/PLAN.md"],
      },
    });
    await mkdir(ctx.workspaceDir, { recursive: true });
    await run(ctx);
    expect(seen?.extraUpsert).toEqual(["src/**"]);
    expect(seen?.denyUpsert).toEqual(["tests/**", "**/PLAN.md"]);
    expect(seen?.tools).toEqual(["read", "write", "edit", "bash"]);
  });

  it("does not grant writeRoots extraUpsert to a planner", async () => {
    let seen: WorkerRequest | undefined;
    const hooks = makeStageHooks({
      executor: {
        run: async (req) => {
          seen = req;
          return { verdict: { step: "plan", verdict: "PASS" }, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 1 };
        },
      },
      agents: [{ name: "planner", model: "stub", promptPath: "/dev/null", tools: ["read"], stageClass: "read-only" }],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    const run = hooks.agentStep(stage({ name: "plan", agent: "planner" }), "plan");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", steps: [] } });
    await mkdir(ctx.workspaceDir, { recursive: true });
    await run(ctx);
    expect(seen?.extraUpsert).toEqual([]);
    expect(seen?.denyUpsert).toEqual([]);
    expect(seen?.tools).toEqual(["read"]);
  });
});

describe("hostStep publish emits run.published", () => {
  it("evaluates yaml gates then publishes, recording the live head-is-judged-sha result", async () => {
    const judged = await makeJudgedWorkspace();
    try {
      pinWorkspaceArtifacts(judged.state, judged.ws);
      const events: { type: string }[] = [];
      const hooks = makeStageHooks({
        executor: executor({ verdict: { step: "x", verdict: "PASS" }, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 1 }),
        agents: [],
        piBinary: "pi",
        projectRootDefault: "/",
        policyFile: "/dev/null",
        policySha: "0".repeat(64),
        writeEvidence: async () => "/tmp/e.json",
      });
      const run = hooks.hostStep(
        stage({ name: "publish", host: "publish", gates: ["head-is-judged-sha", "preflight"] }),
        "publish",
      );
      const ctx = makeStepContext("/tmp/unused-run", {
        state: judged.state,
        cfg: judged.cfg,
      });
      ctx.workspaceDir = judged.ws.path;
      ctx.state.workspaceDir = judged.ws.path;
      ctx.emit = (event) => events.push(event);
      const result = await run(ctx);
      expect(result.verdict).toBe("PASS");
      expect(result.evidence?.predicates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "head-is-judged-sha", ok: true }),
          expect.objectContaining({ name: "preflight", ok: true }),
        ]),
      );
      expect(events.map((e) => e.type)).toContain("run.published");
    } finally {
      await judged.cleanup();
    }
  });

  it("refuses publish when head-is-judged-sha fails without pushing", async () => {
    const judged = await makeJudgedWorkspace();
    try {
      pinWorkspaceArtifacts(judged.state, judged.ws);
      judged.state.judgedSha = "0".repeat(40);
      const hooks = makeStageHooks({
        executor: executor({ verdict: { step: "x", verdict: "PASS" }, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 1 }),
        agents: [],
        piBinary: "pi",
        projectRootDefault: "/",
        policyFile: "/dev/null",
        policySha: "0".repeat(64),
        writeEvidence: async () => "/tmp/e.json",
      });
      const run = hooks.hostStep(
        stage({ name: "publish", host: "publish", gates: ["head-is-judged-sha", "preflight"] }),
        "publish",
      );
      const ctx = makeStepContext("/tmp/unused-run", { state: judged.state, cfg: judged.cfg });
      ctx.workspaceDir = judged.ws.path;
      ctx.state.workspaceDir = judged.ws.path;
      const result = await run(ctx);
      expect(result.verdict).toBe("FAIL");
      expect(result.escalate).toBe("publish-refused");
      expect(result.evidence?.predicates?.some((p) => p.name === "head-is-judged-sha" && !p.ok)).toBe(true);
    } finally {
      await judged.cleanup();
    }
  });
});

describe("humanStep steer uses cfg.steering", () => {
  it("returns a human step named steer", () => {
    const hooks = makeStageHooks({
      executor: { run: async () => ({ verdict: null, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 0 }) },
      agents: [],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => "/tmp/e.json",
    });
    const run = hooks.humanStep(stage({ name: "steer", human: true }), "steer");
    expect(typeof run).toBe("function");
  });
});

describe("agentStep maybeSeed", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = join(await mkdtemp(join(tmpdir(), "pi-sdlc-hooks-seed-")), "runs", "run-1");
    await mkdir(runDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(join(runDir, "..", ".."), { recursive: true, force: true });
  });

  const implementer = {
    name: "implementer",
    model: "stub",
    promptPath: "/dev/null",
    tools: ["read", "write", "edit", "bash"],
    stageClass: "writer" as const,
  };
  const tester = {
    name: "tester",
    model: "stub",
    promptPath: "/dev/null",
    tools: ["read", "write", "edit", "bash"],
    stageClass: "writer" as const,
  };

  it("seeds after a successful implementer step", async () => {
    const hooks = makeStageHooks({
      executor: executor({
        verdict: {
          step: "implement",
          verdict: "PASS",
          changedFiles: ["scripts/sync_aem.py"],
          scripts: [{ path: "scripts/sync_aem.py", purpose: "sync aem", inputsObserved: ["README.md"] }],
        },
        exitCode: 0,
        timedOut: false,
        stderrTail: "",
        durationMs: 1,
      }),
      agents: [implementer],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    const run = hooks.agentStep(stage({ name: "implement", agent: "implementer" }), "implement");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", kind: "chore", steps: [] } });
    await mkdir(join(ctx.workspaceDir, "scripts"), { recursive: true });
    await writeFile(join(ctx.workspaceDir, "scripts", "sync_aem.py"), "print(1)\n", "utf8");
    const result = await run(ctx);
    expect(result.verdict).toBe("PASS");
    const runsDir = join(runDir, "..");
    const seed = await readFile(seedPath(runsDir, "run-1", "implement", 0), "utf8");
    expect(seed).toContain("script-seed");
    expect(seed).toContain("scripts/sync_aem.py");
  });

  it("seeds after a successful tester step and not after a planner", async () => {
    const testerHooks = makeStageHooks({
      executor: executor({
        verdict: {
          step: "test",
          verdict: "PASS",
          scripts: [{ path: "scripts/check.py", purpose: "check", inputsObserved: [] }],
        },
        exitCode: 0,
        timedOut: false,
        stderrTail: "",
        durationMs: 1,
      }),
      agents: [tester],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    await mkdir(join(runDir, "scripts"), { recursive: true });
    await writeFile(join(runDir, "scripts", "check.py"), "print(0)\n", "utf8");
    const testRun = testerHooks.agentStep(stage({ name: "test", agent: "tester" }), "test");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", steps: [] } });
    await mkdir(ctx.workspaceDir, { recursive: true });
    expect((await testRun(ctx)).verdict).toBe("PASS");
    await expect(readFile(seedPath(join(runDir, ".."), "run-1", "test", 0), "utf8")).resolves.toContain("check.py");

    const plannerHooks = makeStageHooks({
      executor: executor({
        verdict: {
          step: "plan",
          verdict: "PASS",
          scripts: [{ path: "scripts/check.py", purpose: "check", inputsObserved: [] }],
        },
        exitCode: 0,
        timedOut: false,
        stderrTail: "",
        durationMs: 1,
      }),
      agents: [{ name: "planner", model: "stub", promptPath: "/dev/null", tools: ["read"], stageClass: "read-only" }],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    const planRun = plannerHooks.agentStep(stage({ name: "plan", agent: "planner" }), "plan");
    const planCtx = makeStepContext(runDir, { state: { runId: "run-1", steps: [] } });
    await mkdir(planCtx.workspaceDir, { recursive: true });
    expect((await planRun(planCtx)).verdict).toBe("PASS");
    await expect(readFile(seedPath(join(runDir, ".."), "run-1", "plan", 0), "utf8")).rejects.toThrow();
  });

  it("does not fail the stage when seeding throws — ledger code seed-failed", async () => {
    await mkdir(join(runDir, "..", "_factory"), { recursive: true, mode: 0o700 });
    await writeFile(join(runDir, "..", "_factory", "codify"), "not-a-dir", "utf8");
    const hooks = makeStageHooks({
      executor: executor({
        verdict: {
          step: "implement",
          verdict: "PASS",
          scripts: [{ path: "scripts/sync_aem.py", purpose: "sync", inputsObserved: [] }],
        },
        exitCode: 0,
        timedOut: false,
        stderrTail: "",
        durationMs: 1,
      }),
      agents: [implementer],
      piBinary: "pi",
      projectRootDefault: "/",
      policyFile: "/dev/null",
      policySha: "0".repeat(64),
      writeEvidence: async () => join(runDir, "evidence", "x.json"),
    });
    const run = hooks.agentStep(stage({ name: "implement", agent: "implementer" }), "implement");
    const ctx = makeStepContext(runDir, { state: { runId: "run-1", steps: [] } });
    await mkdir(join(ctx.workspaceDir, "scripts"), { recursive: true });
    await writeFile(join(ctx.workspaceDir, "scripts", "sync_aem.py"), "print(1)\n", "utf8");
    const result = await run(ctx);
    expect(result.verdict).toBe("PASS");
    const events = await readLedger(join(runDir, ".."));
    expect(events.some((e) => e.code === "seed-failed")).toBe(true);
  });
});
