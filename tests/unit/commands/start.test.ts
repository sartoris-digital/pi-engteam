import { describe, it, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { readQueue, runEnqueue } from "../../../src/commands/enqueue.js";
import { queueStateFor, runStart } from "../../../src/commands/start.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import { writeGlobalConfig } from "../../../src/setup/writers.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

describe("queueStateFor", () => {
  it("maps engine statuses onto queue states without re-queuing a pause", () => {
    expect(queueStateFor("running")).toBe("running");
    expect(queueStateFor("waiting_user")).toBe("awaiting-steer");
    expect(queueStateFor("paused")).toBe("running");
    expect(queueStateFor("succeeded")).toBe("published");
    expect(queueStateFor("failed")).toBe("blocked");
    expect(queueStateFor("cancelled")).toBe("closed");
    expect(queueStateFor("pending")).toBe("running");
  });
});

describe("runStart", () => {
  it("rewrites a running queue entry to failed when runTicket throws", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        await writeGlobalConfig(home, {
          repos: [{ path: fixture.repo, remote: "origin", tracker: "local", project: "f", label: "factory:ready" }],
        });
        const runs = join(home, "runs");
        await mkdir(join(runs, "_factory"), { recursive: true });
        const deps = {
          home,
          runsDir: runs,
          projectRootDefault: fixture.repo,
          engine: {},
          executor: {},
          provider: { create: async () => { throw new Error("create failed"); } },
          tracker: new LocalAdapter(runs),
          agents: [],
          lanes: {
            chore: {
              class: "build",
              match: { kind: "chore" },
              priority: 100,
              budget: { fixRounds: 2, maxWallSeconds: 1, maxCostUsd: 1 },
              stages: [],
            },
          },
          piBinary: "pi",
          repos: [fixture.repo],
        } as unknown as FactoryDeps;
        await runEnqueue(parseFactoryArgs(`enqueue --task "x" --repo ${fixture.repo} --kind chore`), deps);
        await expect(runStart(parseFactoryArgs("start"), deps)).rejects.toThrow(/create failed/);
        const queue = await readQueue(runs);
        expect(queue.entries[0]?.state).toBe("blocked");
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
