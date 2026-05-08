import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { rm } from "fs/promises";
import { ADWEngine } from "../../src/adw/ADWEngine.js";
import type { Workflow, Step } from "../../src/workflows/types.js";
import type { VerdictPayload } from "../../src/types.js";

function makeStep(name: string, opts: { verify?: boolean; agent?: string }): Step {
  return {
    name,
    required: true,
    verify: opts.verify,
    agent: opts.agent,
    run: async (ctx) => {
      const verdict = await ctx.team.deliver(opts.agent ?? "implementer", {
        id: crypto.randomUUID(),
        from: "system",
        to: opts.agent ?? "implementer",
        summary: `Execute step: ${name}`,
        message: `do step ${name}`,
        ts: new Date().toISOString(),
      });
      return {
        success: verdict?.verdict === "PASS",
        verdict: verdict?.verdict ?? "FAIL",
        artifacts: verdict?.artifacts
          ? Object.fromEntries(verdict.artifacts.map((a, i) => [`a${i}`, a]))
          : {},
        issues: verdict?.issues,
      };
    },
  };
}

function makeFakeWorkflow(): Workflow {
  return {
    name: "fake-verify",
    description: "fake",
    steps: [
      makeStep("build", { verify: true, agent: "implementer" }),
      makeStep("review", {}),
    ],
    transitions: [
      { from: "build", when: (r) => r.verdict === "PASS", to: "review" },
      { from: "build", when: (r) => r.verdict !== "PASS", to: "halt" },
      { from: "review", when: () => true, to: "halt" },
    ],
    defaults: { maxIterations: 8, maxCostUsd: 10, maxWallSeconds: 60 },
  };
}

describe("Phase 3 Verifier integration", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "phase3-verifier-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  function buildEngine(deliver: (agent: string, msg: any) => Promise<VerdictPayload | undefined>) {
    const observer = { emit: vi.fn() } as any;
    const team: any = {
      deliver: vi.fn(deliver),
      setRunId: vi.fn(),
      setStepContext: vi.fn(),
      markStepComplete: vi.fn(),
      setAgentLineCallback: vi.fn(),
    };
    const workflows = new Map([["fake-verify", makeFakeWorkflow()]]);
    const engine = new ADWEngine({ runsDir, workflows, team, observer });
    return { engine, team, observer };
  }

  it("runs verifier when step.verify=true and the worker emits PASS", async () => {
    const calls: string[] = [];
    const { engine, team } = buildEngine(async (agent, msg) => {
      calls.push(`${agent}:${msg.summary}`);
      if (agent === "verifier") {
        const verDir = join(runsDir, msg.message.match(/RUN_ID: (\S+)/)![1], "verification");
        await mkdir(verDir, { recursive: true });
        await writeFile(join(verDir, `build-1.md`), "STATUS: PASS\nCONFIDENCE: PERFECT\n");
        return { step: "verify:build", verdict: "PASS" };
      }
      return { step: msg.summary.replace("Execute step: ", ""), verdict: "PASS", artifacts: ["x.ts"] };
    });
    const state = await engine.startRun({
      workflow: "fake-verify",
      goal: "g",
      budget: { maxIterations: 8, maxCostUsd: 10, maxWallSeconds: 60 },
    });
    const final = await engine.executeRun(state.runId);
    expect(final.status).toBe("succeeded");
    expect(team.deliver).toHaveBeenCalled();
    expect(calls.some((c) => c.startsWith("verifier:"))).toBe(true);
  });

  it("appends a gap to gaps.jsonl when verifier returns PARTIAL", async () => {
    const { engine } = buildEngine(async (agent, msg) => {
      if (agent === "verifier") {
        const runId = msg.message.match(/RUN_ID: (\S+)/)![1];
        const verDir = join(runsDir, runId, "verification");
        await mkdir(verDir, { recursive: true });
        await writeFile(join(verDir, `build-1.md`), "STATUS: PARTIAL\nCONFIDENCE: PARTIAL\n");
        return { step: "verify:build", verdict: "PARTIAL", issues: ["claim Z not covered"] };
      }
      return { step: msg.summary.replace("Execute step: ", ""), verdict: "PASS", artifacts: ["x.ts"] };
    });
    const state = await engine.startRun({
      workflow: "fake-verify",
      goal: "g",
      budget: { maxIterations: 8, maxCostUsd: 10, maxWallSeconds: 60 },
    });
    const final = await engine.executeRun(state.runId);
    expect(final.status).toBe("succeeded");
    const gapsPath = join(runsDir, state.runId, "learning", "gaps.jsonl");
    const raw = await readFile(gapsPath, "utf8");
    expect(raw).toContain("claim Z not covered");
  });

  it("re-iterates the worker on verifier FAIL until PASS", async () => {
    let buildCalls = 0;
    let verifyCalls = 0;
    const { engine } = buildEngine(async (agent, msg) => {
      if (agent === "verifier") {
        verifyCalls++;
        const runId = msg.message.match(/RUN_ID: (\S+)/)![1];
        const verDir = join(runsDir, runId, "verification");
        await mkdir(verDir, { recursive: true });
        if (verifyCalls === 1) {
          await writeFile(join(verDir, `build-1.md`), "STATUS: FAIL\nCONFIDENCE: FEEDBACK\n");
          return { step: "verify:build", verdict: "FAIL", issues: ["did not address X"] };
        }
        await writeFile(join(verDir, `build-2.md`), "STATUS: PASS\nCONFIDENCE: VERIFIED\n");
        return { step: "verify:build", verdict: "PASS" };
      }
      // worker
      if (msg.summary.startsWith("Execute step: build")) buildCalls++;
      return { step: msg.summary.replace("Execute step: ", ""), verdict: "PASS", artifacts: ["x.ts"] };
    });
    const state = await engine.startRun({
      workflow: "fake-verify",
      goal: "g",
      budget: { maxIterations: 8, maxCostUsd: 10, maxWallSeconds: 60 },
    });
    const final = await engine.executeRun(state.runId);
    expect(final.status).toBe("succeeded");
    expect(verifyCalls).toBe(2);
    expect(buildCalls).toBe(1); // build is called once by ADW; verifier corrective uses team.deliver to worker, which the test counts via summary too — already addressed in test by checking only "Execute step: build"
  });

  it("pauses run with waiting_user on verifier exhaustion", async () => {
    const { engine } = buildEngine(async (agent, msg) => {
      if (agent === "verifier") {
        const runId = msg.message.match(/RUN_ID: (\S+)/)![1];
        const verDir = join(runsDir, runId, "verification");
        await mkdir(verDir, { recursive: true });
        await writeFile(join(verDir, `build-x.md`), "STATUS: FAIL\nCONFIDENCE: FAILED\n");
        return { step: "verify:build", verdict: "FAIL", issues: ["never resolved"] };
      }
      return { step: msg.summary.replace("Execute step: ", ""), verdict: "PASS", artifacts: ["x.ts"] };
    });
    const state = await engine.startRun({
      workflow: "fake-verify",
      goal: "g",
      budget: { maxIterations: 8, maxCostUsd: 10, maxWallSeconds: 60 },
    });
    const final = await engine.executeRun(state.runId);
    expect(final.status).toBe("waiting_user");
  });

  it("does NOT run verifier when step.verify is unset", async () => {
    let verifierCalls = 0;
    const observer = { emit: vi.fn() } as any;
    const team: any = {
      deliver: vi.fn(async (agent: string, msg: any) => {
        if (agent === "verifier") verifierCalls++;
        return { step: msg.summary.replace("Execute step: ", ""), verdict: "PASS", artifacts: [] };
      }),
      setRunId: vi.fn(),
      setStepContext: vi.fn(),
      markStepComplete: vi.fn(),
      setAgentLineCallback: vi.fn(),
    };
    const wf: Workflow = {
      name: "no-verify",
      description: "",
      steps: [makeStep("build", { verify: false })],
      transitions: [{ from: "build", when: () => true, to: "halt" }],
      defaults: { maxIterations: 4, maxCostUsd: 5, maxWallSeconds: 60 },
    };
    const workflows = new Map([["no-verify", wf]]);
    const engine = new ADWEngine({ runsDir, workflows, team, observer });
    const state = await engine.startRun({
      workflow: "no-verify",
      goal: "g",
      budget: { maxIterations: 4, maxCostUsd: 5, maxWallSeconds: 60 },
    });
    const final = await engine.executeRun(state.runId);
    expect(final.status).toBe("succeeded");
    expect(verifierCalls).toBe(0);
  });

  it("does NOT run verifier when worker FAILed (only on PASS)", async () => {
    let verifierCalls = 0;
    const { engine } = buildEngine(async (agent, msg) => {
      if (agent === "verifier") {
        verifierCalls++;
        return { step: "verify:build", verdict: "PASS" };
      }
      return { step: msg.summary.replace("Execute step: ", ""), verdict: "FAIL", issues: ["bad"] };
    });
    const state = await engine.startRun({
      workflow: "fake-verify",
      goal: "g",
      budget: { maxIterations: 8, maxCostUsd: 10, maxWallSeconds: 60 },
    });
    await engine.executeRun(state.runId);
    expect(verifierCalls).toBe(0);
  });

  it("emits a verdict event when verifier passes", async () => {
    const { engine, observer } = buildEngine(async (agent, msg) => {
      if (agent === "verifier") return { step: "verify:build", verdict: "PASS" };
      return { step: msg.summary.replace("Execute step: ", ""), verdict: "PASS", artifacts: [] };
    });
    const state = await engine.startRun({
      workflow: "fake-verify",
      goal: "g",
      budget: { maxIterations: 8, maxCostUsd: 10, maxWallSeconds: 60 },
    });
    await engine.executeRun(state.runId);
    const verifyEvents = (observer.emit as any).mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => e.type === "verify");
    expect(verifyEvents.length).toBeGreaterThanOrEqual(1);
  });
});
