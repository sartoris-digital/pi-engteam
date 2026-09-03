import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverFactory } from "../../../src/scheduler/recover.js";
import { writeQueue } from "../../../src/scheduler/queue.js";
import { saveRunState } from "../../../src/engine/state.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { ensureRunDir } from "../../../src/home.js";
import { FACTORY_EVENTS } from "../../../src/observer/events.js";

describe("recoverFactory", () => {
  it("blocks a running queue entry whose worktree dir was deleted", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sdlc-recov-"));
    const runs = join(home, "runs");
    try {
      process.env.PI_SDLC_HOME = home;
      await ensureRunDir("run-live", home);
      const missing = join(home, "deleted-ws");
      await writeQueue(runs, {
        schemaVersion: 1,
        entries: [
          {
            key: "local:/repo:local-1",
            tracker: "local",
            repo: "/repo",
            ref: "local-1",
            priority: "p2",
            state: "running",
            kind: "chore",
            runId: "run-live",
            workspace: { provider: "git", path: missing, branch: "factory/x", lane: "chore" },
            enqueuedAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:00.000Z",
          },
        ],
      });
      await saveRunState(runs, fakeRunState({ runId: "run-live", status: "running", workspaceDir: missing }));
      const killed: Array<{ pid: number; sig: NodeJS.Signals }> = [];
      const result = await recoverFactory({
        runsDir: runs,
        kill: (pid, sig) => {
          killed.push({ pid, sig });
        },
      });
      expect(result.recovered).toContain("run-live");
      const { readQueue } = await import("../../../src/scheduler/queue.js");
      const queue = await readQueue(runs);
      expect(queue.entries[0]?.state).toBe("blocked");
      expect(queue.entries[0]?.escalations?.some((e) => e.code === "workspace-lost")).toBe(true);
    } finally {
      delete process.env.PI_SDLC_HOME;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not SIGTERM children in unit tests unless kill is injected", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sdlc-orph-"));
    const runs = join(home, "runs");
    try {
      process.env.PI_SDLC_HOME = home;
      await ensureRunDir("run-live", home);
      await writeFile(join(runs, "run-live", "_children.json"), JSON.stringify([{ pid: 1, pgid: 1 }]));
      await saveRunState(runs, fakeRunState({ runId: "run-live", status: "running" }));
      const without = await recoverFactory({ runsDir: runs });
      expect(without.orphansKilled).toBe(0);
      const killed: number[] = [];
      const withKill = await recoverFactory({
        runsDir: runs,
        kill: (pid) => {
          killed.push(pid);
        },
      });
      expect(withKill.orphansKilled).toBe(1);
      expect(killed).toEqual([1]);
    } finally {
      delete process.env.PI_SDLC_HOME;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("FACTORY_EVENTS", () => {
  it("keeps v0 names and includes factory.ticket.claimed", () => {
    expect(FACTORY_EVENTS).toContain("run.start");
    expect(FACTORY_EVENTS).toContain("run.published");
    expect(FACTORY_EVENTS).toContain("factory.ticket.claimed");
  });
});
