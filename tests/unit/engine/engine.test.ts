import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine, EngineError, agentLabel } from "../../../src/engine/engine.js";
import { readEvidence, verifyEvidence } from "../../../src/engine/evidence.js";
import { loadRunState, readGeneratedJson, readRunSecret, runDirPath } from "../../../src/engine/state.js";
import type { Escalation, FactoryEvent, RunState } from "../../../src/engine/types.js";
import { rawGit } from "../../helpers/raw-git.js";
import {
  buildLaneSteps,
  cleanupTmpDirs,
  evalWhenStub,
  makeStep,
  makeWorkflow,
  startParams,
  tmpRunsDir,
} from "./helpers.js";

afterEach(cleanupTmpDirs);

describe("Engine.startRun", () => {
  it("creates a pending run at the first non-terminal step with a derived maxIterations", async () => {
    const runsDir = await tmpRunsDir();
    const workflow = makeWorkflow("chore", buildLaneSteps(), { fixRounds: 2, fixTarget: "implement" });
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const state = await engine.startRun(startParams(workflow));
    expect(state.status).toBe("pending");
    expect(state.currentStep).toBe("plan");
    expect(state.workflow).toBe("factory-sdlc:chore@deadbeef");
    expect(state.budget).toEqual({ fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8, maxIterations: 8 + 2 * 4 + 2 });
    expect(await engine.getRun(state.runId)).toEqual(state);
    await expect(engine.getRun("01ARZ3NDEKTSV4RRFFQ69G5FAV")).rejects.toBeInstanceOf(EngineError);
  });
});

describe("Engine.executeRun", () => {
  it("runs a clean pass to halt, writing a verifiable evidence record per step", async () => {
    const runsDir = await tmpRunsDir();
    const log: string[] = [];
    const events: FactoryEvent[] = [];
    const steps = buildLaneSteps(
      {
        implement: async () => {
          log.push("implement");
          return { verdict: "PASS", artifacts: { diff: "/tmp/ws/.factory/diff.patch" }, commit: { message: "implement: checkpoint (local-1)" } };
        },
        judge: async () => {
          log.push("judge");
          return { verdict: "PASS", evidence: { headSha: "judged1", predicates: [{ name: "checklist", ok: true }] } };
        },
      },
      log,
    );
    const workflow = makeWorkflow("chore", steps, { fixRounds: 2, fixTarget: "implement" });
    const engine = new Engine({
      runsDir,
      evalWhen: evalWhenStub,
      emit: (e) => events.push(e),
      checkpoint: async (_ctx, message) => (message.startsWith("implement:") ? "sha-implement" : null),
    });
    const run = await engine.startRun(startParams(workflow));
    const final = await engine.executeRun(run.runId);

    expect(final.status).toBe("succeeded");
    expect(log).toEqual(["plan", "gate", "steer", "implement", "test", "review", "judge", "publish"]);
    expect(final.iteration).toBe(7);
    expect(final.rounds).toEqual({});
    expect(final.hostCommits).toEqual(["sha-implement"]);
    expect(final.judgedSha).toBe("judged1");
    expect(final.artifacts).toEqual({ diff: "/tmp/ws/.factory/diff.patch" });
    expect(final.steps.map((s) => [s.name, s.round, s.verdict])).toEqual([
      ["plan", 0, "PASS"], ["gate", 0, "PASS"], ["steer", 0, "PASS"], ["implement", 0, "PASS"],
      ["test", 0, "PASS"], ["review", 0, "PASS"], ["judge", 0, "PASS"], ["publish", 0, "PASS"],
    ]);

    const runDir = runDirPath(runsDir, run.runId);
    const secret = await readRunSecret(runDir);
    for (const name of ["plan", "gate", "steer", "implement", "test", "review", "judge", "publish"]) {
      const verified = await verifyEvidence(runDir, name, 0, secret);
      expect(verified.ok, name).toBe(true);
    }
    expect((await readEvidence(runDir, "plan"))?.agent).toBe("planner");
    expect((await readEvidence(runDir, "test"))?.agent).toBe("host:checks");
    expect((await readEvidence(runDir, "steer"))?.agent).toBe("human");
    expect((await readEvidence(runDir, "steer"))?.verdict).toBe("AUTO");
    expect((await readEvidence(runDir, "plan"))?.headSha).toBe("0000000");
    expect((await readEvidence(runDir, "test"))?.headSha).toBe("sha-implement"); // after the checkpoint
    expect((await readEvidence(runDir, "judge"))?.predicates).toEqual([{ name: "checklist", ok: true }]);
    expect((await readEvidence(runDir, "judge"))?.headSha).toBe("judged1");
    expect(final.steps[0]?.evidencePath).toBe(join(runDir, "evidence", "stage-plan-r0.json"));

    expect(events.map((e) => e.type).slice(0, 3)).toEqual(["run.start", "stage.start", "stage.end"]);
    expect(events.every((e) => typeof e.ts === "string")).toBe(true);
    expect(events.filter((e) => e.type.startsWith("run.")).every((e) => e.category === "lifecycle")).toBe(true);
    expect(events.filter((e) => e.type.startsWith("stage.")).every((e) => e.category === "stage")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.end");
    expect((await loadRunState(runsDir, run.runId))?.status).toBe("succeeded");
  });

  it("persists state after every step so a crash can resume at currentStep", async () => {
    const runsDir = await tmpRunsDir();
    let seen: RunState | null = null;
    const steps = [
      makeStep({ name: "a" }),
      makeStep({ name: "b" }, async (ctx) => {
        seen = await loadRunState(runsDir, ctx.state.runId);
        return { verdict: "PASS" };
      }),
      makeStep({ name: "c" }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("lin", steps)));
    await engine.executeRun(run.runId);
    // Assignment is inside the step callback; CFA still sees `seen` as null.
    const captured = seen as RunState | null;
    expect(captured?.status).toBe("running");
    expect(captured?.currentStep).toBe("b");
    expect(captured?.steps.map((s) => s.name)).toEqual(["a"]);
  });

  it("skips a step whose `when` is false: evidence skipped, verdict PASS, run never called", async () => {
    const runsDir = await tmpRunsDir();
    let called = false;
    const steps = [
      makeStep({ name: "plan" }),
      makeStep({ name: "security", kind: "agent", agent: "security-auditor", when: "tier == 'elevated'" }, async () => {
        called = true;
        return { verdict: "FAIL" };
      }),
      makeStep({ name: "publish" }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("skip", steps), { tier: "low" }));
    const final = await engine.executeRun(run.runId);
    expect(called).toBe(false);
    expect(final.status).toBe("succeeded");
    const ev = await readEvidence(runDirPath(runsDir, run.runId), "security");
    expect(ev?.skipped).toBe(true);
    expect(ev?.verdict).toBe("PASS");
    expect(final.steps.find((s) => s.name === "security")?.verdict).toBe("PASS");
  });

  it("runs the verifier hook on PASS + verify:true and turns its FAIL into the step's FAIL", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [
      makeStep({ name: "implement", kind: "agent", agent: "implementer", verify: true, onFail: "escalate:needs-decision" }),
      makeStep({ name: "escalate", host: "escalate" }),
    ];
    const engine = new Engine({
      runsDir,
      evalWhen: evalWhenStub,
      verify: async (step) => ({ verdict: "FAIL", issues: [`verifier: ${step.name} not proven`] }),
    });
    const run = await engine.startRun(startParams(makeWorkflow("ver", steps)));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(final.steps[0]?.verdict).toBe("FAIL");
    expect(final.steps[0]?.issues).toEqual(["verifier: implement not proven"]);
    expect(final.escalation?.code).toBe("needs-decision");
  });

  it("a step's `escalate` runs the terminal escalate step (budget-exempt) and ends failed", async () => {
    const runsDir = await tmpRunsDir();
    const log: string[] = [];
    const steps = [
      makeStep({ name: "scope-check" }, async () => ({ verdict: "FAIL", issues: ["wrote outside roots"], escalate: "scope-violation" })),
      makeStep({ name: "plan" }, async () => {
        log.push("plan");
        return { verdict: "PASS" };
      }),
      makeStep({ name: "escalate", host: "escalate" }, async () => {
        log.push("escalate");
        return { verdict: "PASS" };
      }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("esc", steps)));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(log).toEqual(["escalate"]);
    expect(final.escalation?.code).toBe("scope-violation");
    expect(final.escalation?.step).toBe("scope-check");
    expect(final.escalation?.detail).toContain("wrote outside roots");
    expect(final.escalation?.humanAction).toBeTruthy();
    expect(final.currentStep).toBe("escalate");
    const runDir = runDirPath(runsDir, run.runId);
    const onDisk = await readGeneratedJson<Escalation>(join(runDir, "escalation.json"));
    expect(onDisk?.code).toBe("scope-violation");
    expect((await readEvidence(runDir, "escalate"))?.agent).toBe("host:escalate");
  });

  it("a `to: escalate` transition uses the step's onFail code; no terminal step → failed directly", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [
      makeStep({ name: "publish", host: "publish", onFail: "escalate:publish-refused" }, async () => ({ verdict: "FAIL", issues: ["preflight: HEAD != judgedSha"] })),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("pub", steps)));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("failed");
    expect(final.escalation?.code).toBe("publish-refused");
    expect(final.currentStep).toBe("publish");
  });

  it("pauseForUser sets waiting_user and returns without advancing", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [
      makeStep({ name: "plan" }),
      makeStep({ name: "steer", kind: "human" }, async () => ({ verdict: "PASS", pauseForUser: { reason: "steer", packetPath: "/tmp/packet.md" } })),
      makeStep({ name: "implement" }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("pause", steps)));
    const paused = await engine.executeRun(run.runId);
    expect(paused.status).toBe("waiting_user");
    expect(paused.currentStep).toBe("steer");
    expect(paused.pauseForUser).toEqual({ reason: "steer", packetPath: "/tmp/packet.md" });
    expect(paused.steps.map((s) => s.name)).toEqual(["plan", "steer"]);
    expect((await loadRunState(runsDir, run.runId))?.status).toBe("waiting_user");
  });

  it("a terminal step that pauses keeps the escalation and waits for the user", async () => {
    const runsDir = await tmpRunsDir();
    const steps = [
      makeStep({ name: "implement", kind: "agent", agent: "implementer" }, async () => ({ verdict: "NEEDS_MORE", escalate: "approval-needed" })),
      makeStep({ name: "escalate", host: "escalate" }, async () => ({ verdict: "PASS", pauseForUser: { reason: "approval-needed" } })),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("appr", steps)));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("waiting_user");
    expect(final.escalation?.code).toBe("approval-needed");
  });

  it("binds judgedSha to live workspace HEAD on safetyGating PASS, not evidence or hostCommits fallback", async () => {
    const runsDir = await tmpRunsDir();
    const ws = join(runsDir, "ws");
    await mkdir(ws, { recursive: true });
    await rawGit(ws, "init", "-q", "-b", "main");
    await rawGit(ws, "config", "user.name", "Fixture");
    await rawGit(ws, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(ws, "a.txt"), "a\n");
    await rawGit(ws, "add", "-A");
    await rawGit(ws, "commit", "-q", "-m", "init");
    const liveHead = await rawGit(ws, "rev-parse", "HEAD");
    const steps = [
      makeStep({ name: "judge", kind: "agent", agent: "judge", safetyGating: true }, async () => ({
        verdict: "PASS",
        evidence: { headSha: "stale-from-agent" },
      })),
      makeStep({ name: "publish", host: "publish" }),
      makeStep({ name: "escalate", host: "escalate" }),
    ];
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("head", steps), { workspaceDir: ws, baseSha: "not-the-head" }));
    const final = await engine.executeRun(run.runId);
    expect(liveHead).toMatch(/^[0-9a-f]{40}$/);
    expect(final.judgedSha).toBe(liveHead);
    expect(final.judgedSha).not.toBe("stale-from-agent");
    expect(final.judgedSha).not.toBe("not-the-head");
    expect((await readEvidence(runDirPath(runsDir, run.runId), "judge"))?.headSha).toBe(liveHead);
  });

  it("refuses to execute an unregistered run and returns terminal runs untouched", async () => {
    const runsDir = await tmpRunsDir();
    const engine = new Engine({ runsDir, evalWhen: evalWhenStub });
    const run = await engine.startRun(startParams(makeWorkflow("one", [makeStep({ name: "a" })])));
    const done = await engine.executeRun(run.runId);
    expect(done.status).toBe("succeeded");
    expect(await engine.executeRun(run.runId)).toEqual(done);
    const other = new Engine({ runsDir, evalWhen: evalWhenStub });
    await expect(other.executeRun(run.runId)).rejects.toThrow(/registerWorkflow/);
  });
});

describe("agentLabel", () => {
  it("labels agents, host actions and humans", () => {
    expect(agentLabel(makeStep({ name: "plan", kind: "agent", agent: "planner" }))).toBe("planner");
    expect(agentLabel(makeStep({ name: "test", host: "checks" }))).toBe("host:checks");
    expect(agentLabel(makeStep({ name: "steer", kind: "human" }))).toBe("human");
  });
});
