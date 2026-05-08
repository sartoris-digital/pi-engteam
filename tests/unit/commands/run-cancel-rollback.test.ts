import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createRunState, saveRunState, loadRunState } from "../../../src/adw/RunState.js";
import { registerRunCancelCommand } from "../../../src/commands/run-cancel.js";
import { registerRunRollbackCommand } from "../../../src/commands/run-rollback.js";
import { ADWEngine } from "../../../src/adw/ADWEngine.js";
import type { Workflow, Step, StepContext, StepResult } from "../../../src/workflows/types.js";

type CommandHandler = (args: string, ctx: { ui: { notify: (msg: string, type?: string) => void } }) => Promise<void>;
type FakePi = {
  registerCommand: (name: string, def: { description: string; handler: CommandHandler }) => void;
  commands: Map<string, CommandHandler>;
};

function makeFakePi(): FakePi {
  const commands = new Map<string, CommandHandler>();
  return {
    commands,
    registerCommand(name, def) {
      commands.set(name, def.handler);
    },
  };
}

function makeNotify() {
  const notes: Array<{ msg: string; type?: string }> = [];
  const notify = (msg: string, type?: string) => {
    notes.push({ msg, type });
  };
  return { notify, notes };
}

async function makeRun(runsDir: string, runId: string, status = "running") {
  const state = await createRunState({ runId, workflow: "wf", goal: "g", budget: {} });
  await saveRunState(runsDir, { ...state, status: status as any, currentStep: "step-a", phase: "active" });
  return state;
}

describe("run-cancel command", () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "run-cancel-"));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  it("sets phase=cancelling on a running run", async () => {
    await makeRun(runsDir, "r1");
    const pi = makeFakePi() as any;
    registerRunCancelCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-cancel")!("r1", { ui: { notify } });
    const state = await loadRunState(runsDir, "r1");
    expect(state?.phase).toBe("cancelling");
    expect(notes[0].type).toBe("info");
  });

  it("does not modify a terminal run", async () => {
    await makeRun(runsDir, "r2", "succeeded");
    const pi = makeFakePi() as any;
    registerRunCancelCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-cancel")!("r2", { ui: { notify } });
    const state = await loadRunState(runsDir, "r2");
    expect(state?.phase).not.toBe("cancelling");
    expect(notes[0].type).toBe("warning");
  });

  it("errors with a missing runId", async () => {
    const pi = makeFakePi() as any;
    registerRunCancelCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-cancel")!("", { ui: { notify } });
    expect(notes[0].type).toBe("error");
  });

  it("errors when the run does not exist", async () => {
    const pi = makeFakePi() as any;
    registerRunCancelCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-cancel")!("nope", { ui: { notify } });
    expect(notes[0].type).toBe("error");
  });
});

describe("run-rollback command", () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "run-rollback-"));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  it("wipes the run dir except cancelled.log", async () => {
    await makeRun(runsDir, "r1");
    const dir = join(runsDir, "r1");
    await writeFile(join(dir, "events.jsonl"), "x\n");
    await mkdir(join(dir, "positions"), { recursive: true });
    await writeFile(join(dir, "positions", "eng.md"), "ignore");

    const pi = makeFakePi() as any;
    registerRunRollbackCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-rollback")!("r1", { ui: { notify } });

    const remaining = await readdir(dir);
    expect(remaining).toEqual(["cancelled.log"]);
    const log = await readFile(join(dir, "cancelled.log"), "utf8");
    expect(log).toContain('"runId": "r1"');
    expect(notes[0].type).toBe("info");
  });

  it("errors when the run dir does not exist", async () => {
    const pi = makeFakePi() as any;
    registerRunRollbackCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-rollback")!("nope", { ui: { notify } });
    expect(notes[0].type).toBe("error");
  });
});

describe("ADWEngine respects phase=cancelling at step boundary", () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "engine-cancel-"));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  it("legacy linear workflow: cancel between steps halts and marks aborted+cancelled", async () => {
    let calls = 0;
    const stepA: Step = {
      name: "a",
      required: true,
      run: async (ctx: StepContext): Promise<StepResult> => {
        calls++;
        const cur = await loadRunState(runsDir, ctx.run.runId);
        await saveRunState(runsDir, { ...cur!, phase: "cancelling" });
        return { success: true, verdict: "PASS" };
      },
    };
    const stepB: Step = {
      name: "b",
      required: true,
      run: async (): Promise<StepResult> => {
        calls++;
        return { success: true, verdict: "PASS" };
      },
    };
    const wf: Workflow = {
      name: "lin",
      description: "t",
      steps: [stepA, stepB],
      transitions: [
        { from: "a", when: () => true, to: "b" },
        { from: "b", when: () => true, to: "halt" },
      ],
      defaults: {},
    };
    const team: any = {
      setRunId: vi.fn(),
      setStepContext: vi.fn(),
      markStepComplete: vi.fn(),
      setAgentLineCallback: vi.fn(),
      deliver: vi.fn(),
    };
    const observer: any = { emit: vi.fn(), subscribeToBus: vi.fn(() => () => {}) };
    const engine = new ADWEngine({ runsDir, workflows: new Map([["lin", wf]]), team, observer });
    const run = await engine.startRun({ workflow: "lin", goal: "g", budget: {} });
    const final = await engine.executeRun(run.runId);
    expect(final.status).toBe("aborted");
    expect(final.phase).toBe("cancelled");
    expect(calls).toBe(1);
  });
});
