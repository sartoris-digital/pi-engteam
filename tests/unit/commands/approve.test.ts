import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { runApprove } from "../../../src/commands/approve.js";
import { writeQueue } from "../../../src/commands/enqueue.js";
import { steerDecisionPath, type SteerDecisionFile } from "../../../src/steer/stage.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import type { RunState } from "../../../src/engine/types.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { ensureRunDir } from "../../../src/home.js";

describe("runApprove", () => {
  let home: string;
  let runs: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sdlc-appr-"));
    runs = join(home, "runs");
    await mkdir(join(runs, "_factory"), { recursive: true });
    process.env.PI_SDLC_HOME = home;
    await ensureRunDir("r1", home);
  });
  afterEach(async () => {
    delete process.env.PI_SDLC_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("writes the steer decision before resumeRun and refuses non-waiting_user entries", async () => {
    const order: string[] = [];
    const resumed: RunState = fakeRunState({ runId: "r1", status: "succeeded" });
    const deps = {
      home,
      runsDir: runs,
      projectRootDefault: "/pkg",
      engine: {
        registerWorkflow: () => {
          order.push("register");
        },
        resumeRun: async (id: string) => {
          order.push("resume");
          expect(id).toBe("r1");
          const raw = JSON.parse(await readFile(steerDecisionPath(join(runs, "r1")), "utf8")) as SteerDecisionFile;
          expect(raw.action).toBe("approve");
          expect(raw.by).toBe("command");
          expect(raw.notes).toBe("looks right to me");
          return fakeRunState({ runId: "r1", status: "waiting_user" });
        },
        executeRun: async () => {
          order.push("execute");
          return resumed;
        },
        getRun: async () => fakeRunState({ runId: "r1", status: "waiting_user" }),
      },
      executor: {} as FactoryDeps["executor"],
      provider: {} as FactoryDeps["provider"],
      tracker: {} as FactoryDeps["tracker"],
      agents: [],
      lanes: {},
      piBinary: "pi",
      repos: ["/repo"],
    } as unknown as FactoryDeps;

    await writeQueue(runs, {
      schemaVersion: 1,
      entries: [
        {
          key: "local:/repo:local-1",
          tracker: "local",
          repo: "/repo",
          ref: "local-1",
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

    const state = await runApprove(parseFactoryArgs("approve local-1 looks right to me"), deps);
    expect(state.status).toBe("succeeded");
    expect(order).toEqual(["resume", "execute"]);

    await writeQueue(runs, {
      schemaVersion: 1,
      entries: [
        {
          key: "local:/repo:local-1",
          tracker: "local",
          repo: "/repo",
          ref: "local-1",
          priority: "p2",
          state: "published",
          kind: "chore",
          runId: "r1",
          enqueuedAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    await expect(runApprove(parseFactoryArgs("approve local-1"), deps)).rejects.toThrow(
      "approve: local-1 is published, not waiting_user",
    );
  });
});
