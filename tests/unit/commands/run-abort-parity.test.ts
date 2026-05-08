import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createRunState, loadRunState, saveRunState } from "../../../src/adw/RunState.js";
import { registerRunCancelCommand } from "../../../src/commands/run-cancel.js";
import { registerRunAbortCommand } from "../../../src/commands/run-abort.js";
import { registerRunRollbackCommand } from "../../../src/commands/run-rollback.js";

type CommandHandler = (
  args: string,
  ctx: { ui: { notify: (msg: string, type?: string) => void } },
) => Promise<void>;
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
  return {
    notes,
    notify: (msg: string, type?: string) => {
      notes.push({ msg, type });
    },
  };
}

async function bootstrap(runsDir: string, runId: string, status: string = "running") {
  const state = await createRunState({ runId, workflow: "wf", goal: "g", budget: {} });
  await saveRunState(runsDir, { ...state, status: status as any, currentStep: "step", phase: "active" });
}

describe("/run-abort behavioral parity with /run-cancel — Phase 4.5 M-3", () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "abort-parity-"));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  it("/run-abort sets phase=cancelling identical to /run-cancel", async () => {
    await bootstrap(runsDir, "rA");
    await bootstrap(runsDir, "rB");
    const piA = makeFakePi() as any;
    const piB = makeFakePi() as any;
    registerRunCancelCommand(piA, runsDir);
    registerRunAbortCommand(piB, runsDir);
    const a = makeNotify();
    const b = makeNotify();
    await piA.commands.get("run-cancel")!("rA", { ui: { notify: a.notify } });
    await piB.commands.get("run-abort")!("rB", { ui: { notify: b.notify } });
    const sA = await loadRunState(runsDir, "rA");
    const sB = await loadRunState(runsDir, "rB");
    expect(sA?.phase).toBe("cancelling");
    expect(sB?.phase).toBe("cancelling");
  });

  it("/run-abort warns on terminal status without overwriting", async () => {
    await bootstrap(runsDir, "rT", "succeeded");
    const pi = makeFakePi() as any;
    registerRunAbortCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-abort")!("rT", { ui: { notify } });
    expect(notes[0].type).toBe("warning");
    const s = await loadRunState(runsDir, "rT");
    expect(s?.phase).not.toBe("cancelling");
  });

  it("/run-abort errors on missing runId or unknown run", async () => {
    const pi = makeFakePi() as any;
    registerRunAbortCommand(pi, runsDir);
    const empty = makeNotify();
    await pi.commands.get("run-abort")!("", { ui: { notify: empty.notify } });
    expect(empty.notes[0].type).toBe("error");
    const ghost = makeNotify();
    await pi.commands.get("run-abort")!("does-not-exist", { ui: { notify: ghost.notify } });
    expect(ghost.notes[0].type).toBe("error");
  });
});

describe("/run-rollback symlink/quarantine defense — Phase 4.5 M-3", () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "rollback-symlink-"));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  it("refuses rollback when runDir is itself a symlink", async () => {
    // Build a real outside-target dir we'd prefer NOT to be touched.
    const outsideTarget = await mkdtemp(join(tmpdir(), "outside-target-"));
    await writeFile(join(outsideTarget, "important.txt"), "do not delete");
    // Create a symlink runDir -> outsideTarget inside runsDir.
    await symlink(outsideTarget, join(runsDir, "evil"));

    const pi = makeFakePi() as any;
    registerRunRollbackCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-rollback")!("evil", { ui: { notify } });
    expect(notes[0].type).toBe("error");
    expect(notes[0].msg.toLowerCase()).toContain("symlink");
    // outsideTarget contents must be untouched.
    const remaining = await readdir(outsideTarget);
    expect(remaining).toContain("important.txt");
    await rm(outsideTarget, { recursive: true }).catch(() => {});
  });

  it("rejects runIds that don't match the safe pattern", async () => {
    const pi = makeFakePi() as any;
    registerRunRollbackCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-rollback")!("../escape", { ui: { notify } });
    expect(notes[0].type).toBe("error");
    expect(notes[0].msg).toMatch(/Invalid runId/);
  });

  it("quarantine-rename leaves only cancelled.log when an inner symlink exists", async () => {
    await bootstrap(runsDir, "rS");
    const dir = join(runsDir, "rS");
    await writeFile(join(dir, "events.jsonl"), "x\n");
    await mkdir(join(dir, "positions"), { recursive: true });
    await writeFile(join(dir, "positions", "eng.md"), "ignore");
    // Create an inner symlink pointing outside the run dir.
    const outside = await mkdtemp(join(tmpdir(), "outside-inner-"));
    await writeFile(join(outside, "keep.txt"), "should survive");
    await symlink(outside, join(dir, "swapped"));

    const pi = makeFakePi() as any;
    registerRunRollbackCommand(pi, runsDir);
    const { notify, notes } = makeNotify();
    await pi.commands.get("run-rollback")!("rS", { ui: { notify } });
    expect(notes[0].type).toBe("info");

    const remaining = await readdir(dir);
    expect(remaining).toEqual(["cancelled.log"]);
    // The symlink-target directory must NOT have been recursed into.
    const outsideEntries = await readdir(outside);
    expect(outsideEntries).toContain("keep.txt");
    await rm(outside, { recursive: true }).catch(() => {});
  });
});
