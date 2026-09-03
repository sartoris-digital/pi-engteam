import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTicket, type FactoryDeps } from "../../../src/controller/lane-runner.js";
import { packageRoot } from "../../../src/controller/agents.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { withTmpHome } from "../../helpers/tmp-home.js";
import { loadEffectiveLanes } from "../../../src/lanes/index.js";
import type { CreateWorkspaceRequest } from "../../../src/workspace/types.js";

describe("runTicket grill", () => {
  it("does not call provider.create and uses the main checkout as workspaceDir", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        const runs = join(home, "runs");
        await mkdir(join(runs, "_factory"), { recursive: true, mode: 0o700 });
        const created: CreateWorkspaceRequest[] = [];
        const started: Array<{ workspaceDir: string; lane: string }> = [];
        const root = packageRoot();
        const deps = {
          home,
          runsDir: runs,
          projectRootDefault: root,
          engine: {
            startRun: async (params: { workspaceDir: string; lane: string; ticket: { ref: string } }) => {
              started.push({ workspaceDir: params.workspaceDir, lane: params.lane });
              await mkdir(join(runs, "grill-1"), { recursive: true, mode: 0o700 });
              return fakeRunState({
                runId: "grill-1",
                lane: params.lane,
                workspaceDir: params.workspaceDir,
                mainCheckout: fixture.repo,
                status: "succeeded",
              });
            },
            executeRun: async () =>
              fakeRunState({
                runId: "grill-1",
                lane: "grill",
                workspaceDir: fixture.repo,
                status: "succeeded",
              }),
            getRun: async () => fakeRunState({ runId: "grill-1", lane: "grill", status: "succeeded" }),
            registerWorkflow: () => undefined,
          },
          executor: { run: async () => ({ verdict: null, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 0 }) },
          provider: {
            create: async (req: CreateWorkspaceRequest) => {
              created.push(req);
              throw new Error("grill must not create a worktree");
            },
            remove: async () => undefined,
            list: async () => [],
          },
          tracker: {},
          agents: [],
          lanes: await loadEffectiveLanes([join(root, "src", "assets", "lanes.yaml")]),
          piBinary: "pi",
          repos: [fixture.repo],
        } as unknown as FactoryDeps;

        const state = await runTicket(
          {
            ref: { tracker: "local", id: "local-grill-1" },
            title: "thin idea",
            body: "we should maybe add a thing",
            labels: [],
            author: "test",
            kind: "chore",
          },
          fixture.repo,
          deps,
          { lane: "grill" },
        );
        expect(created).toEqual([]);
        expect(started[0]?.lane).toBe("grill");
        expect(started[0]?.workspaceDir).toBe(fixture.repo);
        expect(state.workspaceDir === fixture.repo || started[0]?.workspaceDir === fixture.repo).toBe(true);
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
