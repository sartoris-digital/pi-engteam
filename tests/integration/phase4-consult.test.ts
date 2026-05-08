import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ADWEngine } from "../../src/adw/ADWEngine.js";
import { buildConsultWorkflow, bootstrapConsultRun, consult } from "../../src/workflows/consult.js";
import { parseConsultArgs } from "../../src/commands/workflow-shortcuts.js";
import type { VerdictPayload } from "../../src/types.js";

function makeTeam(deliveries: string[]) {
  const order: string[] = [];
  const concurrent = new Map<string, number>();
  let maxConcurrent = 0;
  const team: any = {
    deliver: vi.fn(async (agent: string, msg: any): Promise<VerdictPayload> => {
      order.push(`${agent}:${msg.summary}`);
      // Simulate parallelism: track concurrent invocations.
      const cur = (concurrent.get(agent) ?? 0) + 1;
      concurrent.set(agent, cur);
      const total = Array.from(concurrent.values()).reduce((s, n) => s + n, 0);
      if (total > maxConcurrent) maxConcurrent = total;
      await new Promise((r) => setTimeout(r, 10));
      concurrent.set(agent, cur - 1);
      const stepName = msg.summary.replace("Consult step: ", "");
      return {
        step: stepName,
        verdict: "PASS",
        artifacts: [`<run>/positions/${agent}.md`],
      };
    }),
    setRunId: vi.fn(),
    setStepContext: vi.fn(),
    markStepComplete: vi.fn(),
    setAgentLineCallback: vi.fn(),
  };
  return { team, order, getMaxConcurrent: () => maxConcurrent };
}

describe("Phase 4 consult workflow", () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "consult-"));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  it("parseConsultArgs: bare topic defaults to 1 round and undefined teams", () => {
    const r = parseConsultArgs("Should we adopt Drizzle?");
    expect(r.topic).toBe("Should we adopt Drizzle?");
    expect(r.rounds).toBe(1);
    expect(r.teams).toBeUndefined();
  });

  it("parseConsultArgs: --rounds N parses correctly", () => {
    const r = parseConsultArgs("Topic --rounds 2");
    expect(r.rounds).toBe(2);
    expect(r.topic).toBe("Topic");
  });

  it("parseConsultArgs: teams=eng,valid filters team set", () => {
    const r = parseConsultArgs("Topic teams=eng,valid");
    expect(r.teams).toEqual(["eng", "valid"]);
    expect(r.topic).toBe("Topic");
  });

  it("parseConsultArgs: invalid team values are dropped", () => {
    const r = parseConsultArgs("Topic teams=eng,bogus,invest");
    expect(r.teams).toEqual(["eng", "invest"]);
  });

  it("buildConsultWorkflow: default 3 leads produces 8 steps", () => {
    const w = buildConsultWorkflow();
    expect(w.steps.map((s) => s.name)).toEqual([
      "dispatch",
      "position-eng",
      "position-valid",
      "position-invest",
      "adversarial-eng",
      "adversarial-valid",
      "adversarial-invest",
      "synthesis",
    ]);
  });

  it("buildConsultWorkflow: subset teams=eng,valid produces 6 steps with adjusted dependsOn", () => {
    const w = buildConsultWorkflow(["eng", "valid"]);
    const names = w.steps.map((s) => s.name);
    expect(names).toEqual([
      "dispatch",
      "position-eng",
      "position-valid",
      "adversarial-eng",
      "adversarial-valid",
      "synthesis",
    ]);
    const advEng = w.steps.find((s) => s.name === "adversarial-eng")!;
    expect(advEng.dependsOn).toEqual(["position-eng", "position-valid"]);
    const synth = w.steps.find((s) => s.name === "synthesis")!;
    expect(synth.dependsOn).toEqual(["adversarial-eng", "adversarial-valid"]);
  });

  it("ADWEngine validates consult workflow without throwing", () => {
    const team: any = { setRunId: vi.fn(), setStepContext: vi.fn(), markStepComplete: vi.fn(), setAgentLineCallback: vi.fn(), deliver: vi.fn() };
    const observer: any = { emit: vi.fn(), subscribeToBus: vi.fn(() => () => {}) };
    expect(
      () => new ADWEngine({ runsDir, workflows: new Map([["consult", consult]]), team, observer }),
    ).not.toThrow();
  });

  it("end-to-end DAG execution: positions run concurrently after dispatch, adversarial after positions, synthesis last", async () => {
    const { team, order } = makeTeam([]);
    const observer: any = { emit: vi.fn(), subscribeToBus: vi.fn(() => () => {}) };
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map([["consult", consult]]),
      team,
      observer,
    });
    const run = await engine.startRun({ workflow: "consult", goal: "is X a good idea?", budget: {} });
    await bootstrapConsultRun(join(runsDir, run.runId));
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("succeeded");

    // dispatch first
    expect(order[0]).toContain("orchestrator:Consult step: dispatch");
    // positions all happen before any adversarial
    const posIdx = order
      .map((o, i) => (o.includes("Consult step: position-") ? i : -1))
      .filter((i) => i >= 0);
    const advIdx = order
      .map((o, i) => (o.includes("Consult step: adversarial-") ? i : -1))
      .filter((i) => i >= 0);
    expect(Math.max(...posIdx)).toBeLessThan(Math.min(...advIdx));
    // synthesis is last
    expect(order[order.length - 1]).toContain("Consult step: synthesis");
  });

  it("partial failure in one position does not abort other positions; synthesis still runs", async () => {
    const observer: any = { emit: vi.fn(), subscribeToBus: vi.fn(() => () => {}) };
    const team: any = {
      deliver: vi.fn(async (agent: string, msg: any): Promise<VerdictPayload> => {
        const stepName = msg.summary.replace("Consult step: ", "");
        if (stepName === "position-valid") {
          return { step: stepName, verdict: "FAIL", issues: ["validation lead crashed"] };
        }
        return { step: stepName, verdict: "PASS", artifacts: [`<run>/x/${agent}.md`] };
      }),
      setRunId: vi.fn(),
      setStepContext: vi.fn(),
      markStepComplete: vi.fn(),
      setAgentLineCallback: vi.fn(),
    };
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map([["consult", consult]]),
      team,
      observer,
    });
    const run = await engine.startRun({ workflow: "consult", goal: "topic", budget: {} });
    await bootstrapConsultRun(join(runsDir, run.runId));
    const final = await engine.executeRun(run.runId);
    // any non-PASS step marks the run failed in DAG mode
    expect(final.status).toBe("failed");
    // but synthesis was still attempted
    const calls = team.deliver.mock.calls.map((c: any[]) => c[1].summary);
    expect(calls.some((s: string) => s.includes("Consult step: synthesis"))).toBe(true);
  });

  it("subset teams: workflow runs only the selected leads", async () => {
    const { team, order } = makeTeam([]);
    const observer: any = { emit: vi.fn(), subscribeToBus: vi.fn(() => () => {}) };
    const wf = buildConsultWorkflow(["eng", "invest"]);
    const engine = new ADWEngine({
      runsDir,
      workflows: new Map([[wf.name, wf]]),
      team,
      observer,
    });
    const run = await engine.startRun({ workflow: wf.name, goal: "topic", budget: {} });
    await bootstrapConsultRun(join(runsDir, run.runId));
    await engine.executeRun(run.runId);
    expect(order.some((o) => o.includes("position-valid"))).toBe(false);
    expect(order.some((o) => o.includes("position-eng"))).toBe(true);
    expect(order.some((o) => o.includes("position-invest"))).toBe(true);
  });

  it("bootstrapConsultRun creates positions/ and adversarial/ directories", async () => {
    const dir = join(runsDir, "boot-r1");
    await mkdir(dir, { recursive: true });
    await bootstrapConsultRun(dir);
    const { stat } = await import("fs/promises");
    expect((await stat(join(dir, "positions"))).isDirectory()).toBe(true);
    expect((await stat(join(dir, "adversarial"))).isDirectory()).toBe(true);
  });
});
