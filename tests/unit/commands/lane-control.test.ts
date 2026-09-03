import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { readQueue, writeQueue, type QueueEntry } from "../../../src/commands/enqueue.js";
import { runCancel } from "../../../src/commands/cancel.js";
import { runClassify } from "../../../src/commands/classify.js";
import { runDrop } from "../../../src/commands/drop.js";
import { runGc } from "../../../src/commands/gc.js";
import { runRescan } from "../../../src/commands/rescan.js";
import { runResume } from "../../../src/commands/resume.js";
import { runRetry } from "../../../src/commands/retry.js";
import { runReplan } from "../../../src/commands/replan.js";
import { runStart } from "../../../src/commands/start.js";
import { runStop } from "../../../src/commands/stop.js";
import { runWatch } from "../../../src/commands/watch.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { ensureRunDir } from "../../../src/home.js";
import { humanInputPath } from "../../../src/steer/human-input.js";

function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    key: "local:/repo:local-1",
    tracker: "local",
    repo: "/repo",
    ref: "local-1",
    priority: "p2",
    state: "running",
    kind: "chore",
    lane: "chore",
    runId: "r1",
    enqueuedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

describe("lane-control verbs", () => {
  let home: string;
  let runs: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sdlc-lc-"));
    runs = join(home, "runs");
    await mkdir(join(runs, "_factory"), { recursive: true });
    process.env.PI_SDLC_HOME = home;
    await ensureRunDir("r1", home);
  });
  afterEach(async () => {
    delete process.env.PI_SDLC_HOME;
    await rm(home, { recursive: true, force: true });
  });

  function deps(over: object = {}): FactoryDeps {
    return {
      home,
      runsDir: runs,
      projectRootDefault: "/pkg",
      engine: {
        getRun: async () => fakeRunState({ runId: "r1", status: "paused", nonce: "n".repeat(32) }),
        resumeRun: async () => fakeRunState({ runId: "r1", status: "running" }),
        cancelRun: async () => fakeRunState({ runId: "r1", status: "cancelled" }),
        registerWorkflow: () => undefined,
      },
      executor: {},
      provider: { remove: async () => undefined },
      tracker: { removeLabel: async () => undefined },
      adapters: new Map(),
      agents: [],
      lanes: {},
      piBinary: "pi",
      repos: ["/repo"],
      ...over,
    } as unknown as FactoryDeps;
  }

  it("resume writes --answer into human-input and calls resumeRun --from", async () => {
    await writeQueue(runs, { schemaVersion: 1, entries: [entry({ state: "blocked" })] });
    const answer = join(home, "notes.md");
    await writeFile(answer, "please retry the implementer");
    const from: string[] = [];
    const state = await runResume(parseFactoryArgs(`resume local-1 --from implement --answer ${answer}`), deps({
      engine: {
        getRun: async () => fakeRunState({ runId: "r1", status: "failed", nonce: "n".repeat(32) }),
        resumeRun: async (_id: string, opts: { fromStep?: string }) => {
          from.push(opts.fromStep ?? "");
          return fakeRunState({ runId: "r1", status: "running" });
        },
        registerWorkflow: () => undefined,
      },
    }));
    expect(state.status).toBe("running");
    expect(from).toEqual(["implement"]);
    const notes = await readFile(humanInputPath(join(runs, "r1"), 1), "utf8");
    expect(notes).toMatch(/please retry the implementer/);
  });

  it("cancel keeps the worktree and closes the queue entry", async () => {
    let removed = 0;
    await writeQueue(runs, { schemaVersion: 1, entries: [entry()] });
    await runCancel(parseFactoryArgs("cancel local-1"), deps({
      provider: { remove: async () => { removed += 1; } },
    }));
    expect((await readQueue(runs)).entries[0]?.state).toBe("closed");
    expect(removed).toBe(0);
  });

  it("drop cancels then removes an empty worktree", async () => {
    const removed: string[] = [];
    await writeQueue(runs, {
      schemaVersion: 1,
      entries: [entry({ workspace: { provider: "git", path: "/ws", branch: "factory/x", lane: "chore" } })],
    });
    const out = await runDrop(parseFactoryArgs("drop local-1"), deps({
      provider: { remove: async (ws: { path: string }) => { removed.push(ws.path); } },
    }));
    expect(out.removed).toBe(true);
    expect(removed).toEqual(["/ws"]);
    expect((await readQueue(runs)).entries[0]?.state).toBe("closed");
  });

  it("retry moves abandoned to queued and drops factory:abandoned", async () => {
    const labels: string[] = [];
    await writeQueue(runs, { schemaVersion: 1, entries: [entry({ state: "abandoned" })] });
    const out = await runRetry(parseFactoryArgs("retry local-1"), deps({
      tracker: {
        removeLabel: async (_ref: unknown, label: string) => {
          labels.push(label);
        },
      },
    }));
    expect(out.state).toBe("queued");
    expect(labels).toEqual(["factory:abandoned"]);
  });

  it("rescan and stop drive the injected scheduler", async () => {
    let drained = 0;
    let stopped = 0;
    const scheduler = {
      start: async () => undefined,
      stop: async () => { stopped += 1; },
      drainOnce: async () => {
        drained += 1;
        return { claimed: 2, skipped: 1 };
      },
    };
    const d = deps({ scheduler });
    expect(await runRescan(parseFactoryArgs("rescan"), d)).toEqual({ claimed: 2, skipped: 1 });
    expect(drained).toBe(1);
    expect(await runStop(parseFactoryArgs("stop"), d)).toMatch(/stopped/);
    expect(stopped).toBe(1);
  });

  it("gc removes closed worktrees older than gcDays", async () => {
    const removed: string[] = [];
    await writeQueue(runs, {
      schemaVersion: 1,
      entries: [
        entry({
          state: "closed",
          updatedAt: "2020-01-01T00:00:00.000Z",
          workspace: { provider: "git", path: "/old", branch: "b", lane: "chore" },
        }),
      ],
    });
    const out = await runGc(parseFactoryArgs("gc"), deps({
      provider: { remove: async (ws: { path: string }) => { removed.push(ws.path); } },
    }));
    expect(out.removed).toBe(1);
    expect(removed).toEqual(["/old"]);
  });

  it("classify overrides kind and requeues", async () => {
    await writeQueue(runs, { schemaVersion: 1, entries: [entry({ state: "needs-info", kind: "chore" })] });
    const out = await runClassify(parseFactoryArgs("classify local-1 bug"), deps());
    expect(out.kind).toBe("bug");
    expect(out.state).toBe("queued");
  });

  it("replan writes a steer replan decision then resumeRun", async () => {
    await writeQueue(runs, { schemaVersion: 1, entries: [entry({ state: "awaiting-steer" })] });
    const actions: string[] = [];
    await runReplan(parseFactoryArgs("replan local-1 try another approach"), deps({
      engine: {
        getRun: async () => fakeRunState({ runId: "r1", status: "waiting_user" }),
        resumeRun: async (_id: string, opts: { decision?: { action: string } }) => {
          actions.push(opts.decision?.action ?? "");
          return fakeRunState({ runId: "r1", status: "running" });
        },
        registerWorkflow: () => undefined,
      },
    }));
    expect(actions).toEqual(["replan"]);
    const raw = await readFile(join(runs, "r1", "steer-decision.json"), "utf8");
    expect(raw).toMatch(/"action": "replan"/);
  });

  it("watch creates the lane stream file and returns its path", async () => {
    await writeQueue(runs, { schemaVersion: 1, entries: [entry()] });
    const path = await runWatch(parseFactoryArgs("watch local-1"), deps());
    expect(path).toBe(join(runs, "r1", "lanes", "chore.stream.jsonl"));
    expect(await readFile(path, "utf8")).toBe("");
  });

  it("start calls scheduler.start once even when the queue is empty", async () => {
    let starts = 0;
    await writeQueue(runs, { schemaVersion: 1, entries: [] });
    const started = await runStart(parseFactoryArgs("start"), deps({
      scheduler: {
        start: async () => { starts += 1; },
        stop: async () => undefined,
        drainOnce: async () => ({ claimed: 0, skipped: 0 }),
      },
    }));
    expect(starts).toBe(1);
    expect(started).toEqual([]);
  });
});
