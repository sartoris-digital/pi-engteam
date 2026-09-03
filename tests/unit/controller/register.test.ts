import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePi } from "../../helpers/fake-pi.js";
import { writeQueue } from "../../../src/commands/enqueue.js";
import { completionSnapshot, registerCommands } from "../../../src/commands/index.js";
import { recoverRunningRuns } from "../../../src/controller/register.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { saveRunState } from "../../../src/engine/state.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { ensureRunDir } from "../../../src/home.js";

describe("completionSnapshot", () => {
  it("lists lanes, repos and queued runs", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-reg-"));
    try {
      await mkdir(join(runs, "_factory"), { recursive: true });
      const deps = {
        home: join(runs, ".."),
        runsDir: runs,
        projectRootDefault: "/pkg",
        engine: {} as FactoryDeps["engine"],
        executor: {} as FactoryDeps["executor"],
        provider: {} as FactoryDeps["provider"],
        tracker: {} as FactoryDeps["tracker"],
        agents: [],
        lanes: { chore: {} as FactoryDeps["lanes"][string], bug: {} as FactoryDeps["lanes"][string] },
        piBinary: "pi",
        repos: ["/repo"],
      } satisfies FactoryDeps;

      await writeQueue(runs, {
        schemaVersion: 1,
        entries: [
          {
            key: "local:/repo:r1",
            tracker: "local",
            repo: "/repo",
            ref: "local-r1",
            priority: "p2",
            state: "waiting_user",
            kind: "chore",
            lane: "chore",
            runId: "r1",
            enqueuedAt: "2026-09-02T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z",
          },
        ],
      });

      const snapshot = await completionSnapshot(deps);
      expect(snapshot.lanes.sort()).toEqual(["bug", "chore"]);
      expect(snapshot.repos).toEqual(["/repo"]);
      expect(snapshot.runs).toEqual([
        { ref: "local-r1", runId: "r1", lane: "chore", status: "waiting_user" },
      ]);
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });
});

describe("registerCommands", () => {
  it("registers factory with a synchronous getArgumentCompletions", () => {
    const fake = new FakePi();
    const deps = {
      home: "/h",
      runsDir: "/h/runs",
      projectRootDefault: "/pkg",
      engine: {} as FactoryDeps["engine"],
      executor: {} as FactoryDeps["executor"],
      provider: {} as FactoryDeps["provider"],
      tracker: {} as FactoryDeps["tracker"],
      agents: [],
      lanes: { chore: {} as FactoryDeps["lanes"][string] },
      piBinary: "pi",
      repos: ["/repo"],
    } satisfies FactoryDeps;
    const registered = registerCommands(fake.asPi(), deps);
    expect(typeof registered.refresh).toBe("function");
    const cmd = fake.commands.get("factory") as {
      getArgumentCompletions: (prefix: string) => unknown;
    };
    const items = cmd.getArgumentCompletions("");
    expect(items).not.toBeInstanceOf(Promise);
    expect(Array.isArray(items)).toBe(true);
  });
});

describe("recoverRunningRuns", () => {
  it("pauses runs left in running and ignores _factory", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-sdlc-rec-"));
    const runs = join(home, "runs");
    try {
      process.env.PI_SDLC_HOME = home;
      await ensureRunDir("run-live", home);
      await mkdir(join(runs, "_factory"), { recursive: true });
      const state = fakeRunState({ runId: "run-live", status: "running" });
      await saveRunState(runs, state);
      const recovered = await recoverRunningRuns(runs);
      expect(recovered).toEqual(["run-live"]);
      const { loadRunState } = await import("../../../src/engine/state.js");
      expect((await loadRunState(runs, "run-live"))?.status).toBe("paused");
    } finally {
      delete process.env.PI_SDLC_HOME;
      await rm(home, { recursive: true, force: true });
    }
  });
});
