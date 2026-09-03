import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRunWorkflow,
  prepareRunSandbox,
  rehydrateOpenWorkflows,
  runSandboxModes,
  runTicket,
  sandboxProfileForRun,
  type FactoryDeps,
} from "../../../src/controller/lane-runner.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";
import { makeEngine } from "../../../src/controller/register.js";
import { loadAgentDefs, packageRoot } from "../../../src/controller/agents.js";
import { saveRunState } from "../../../src/engine/state.js";
import { loadEffectiveLanes } from "../../../src/lanes/index.js";
import { HeadlessExecutor } from "../../../src/runtime/headless.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import { GitWorktreeProvider } from "../../../src/workspace/git-provider.js";
import { writeRepoConfig } from "../../../src/setup/writers.js";
import { makeRepoConfig } from "../../helpers/steer-fixtures.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

describe("prepareRunSandbox", () => {
  beforeEach(() => {
    runSandboxModes.clear();
  });
  afterEach(() => {
    runSandboxModes.clear();
  });

  it("skips the probe when sandbox is off and records the mode", async () => {
    const result = await prepareRunSandbox("run-off", makeRepoConfig({ sandbox: "off" }));
    expect(result).toEqual({ ok: true });
    expect(runSandboxModes.get("run-off")).toBe("off");
  });

  it("escalates env-setup-failed when sandbox is required and the probe is forced unavailable", async () => {
    const result = await prepareRunSandbox("run-req", makeRepoConfig({ sandbox: "required" }), {
      probe: async () => ({ available: false, provider: null, detail: "no provider" }),
    });
    expect(result).toEqual({
      ok: false,
      escalate: "env-setup-failed",
      detail: "no provider",
    });
    expect(runSandboxModes.has("run-req")).toBe(false);
  });

  it("records off when sandbox is best-effort and the probe is unavailable", async () => {
    const result = await prepareRunSandbox("run-be", makeRepoConfig({ sandbox: "best-effort" }), {
      probe: async () => ({ available: false, provider: null, detail: "no provider" }),
    });
    expect(result).toEqual({ ok: true });
    expect(runSandboxModes.get("run-be")).toBe("off");
  });

  it("records required when the probe is available", async () => {
    const result = await prepareRunSandbox("run-ok", makeRepoConfig({ sandbox: "required" }), {
      probe: async () => ({ available: true, provider: "sandbox-exec", detail: "ok" }),
    });
    expect(result).toEqual({ ok: true });
    expect(runSandboxModes.get("run-ok")).toBe("required");
  });

  it("sandboxProfileForRun wraps unless the run mode is off (buildFactoryDeps callback)", () => {
    runSandboxModes.set("run-off", "off");
    expect(sandboxProfileForRun(makeWorkerRequest({ runId: "run-off" }), "/home")).toBeNull();
    runSandboxModes.set("run-req", "required");
    const profile = sandboxProfileForRun(makeWorkerRequest({ runId: "run-req", cwd: "/ws", runDir: "/runs/run-req" }), "/home");
    expect(profile).not.toBeNull();
    expect(profile?.workspaceDir).toBe("/ws");
    expect(profile?.runDir).toBe("/runs/run-req");
  });
});

describe("runTicket setupCommand", () => {
  it("escalates env-setup-failed when setupCommand fails instead of throwing", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        await writeRepoConfig(
          fixture.repo,
          { defaults: { setupCommand: [process.execPath, "-e", "process.exit(2)"] } },
          { local: true },
        );
        const runs = join(home, "runs");
        await mkdir(join(runs, "_factory"), { recursive: true, mode: 0o700 });
        const root = packageRoot();
        const deps: FactoryDeps = {
          home,
          runsDir: runs,
          projectRootDefault: root,
          engine: makeEngine(runs, { coAuthoredBy: false }),
          executor: new HeadlessExecutor({ sandbox: null }),
          provider: new GitWorktreeProvider({ home }),
          tracker: new LocalAdapter(runs),
          agents: await loadAgentDefs({
            root,
            models: {},
            defaultModel: "stub",
            required: ["planner", "implementer", "reviewer", "judge"],
          }),
          lanes: await loadEffectiveLanes([join(root, "src", "assets", "lanes.yaml")]),
          piBinary: "pi",
          repos: [fixture.repo],
        };
        const state = await runTicket(
          {
            ref: { tracker: "local", id: "local-setup-fail" },
            title: "setup fail",
            body: "x",
            labels: [],
            author: "test",
            kind: "chore",
          },
          fixture.repo,
          deps,
        );
        expect(state.status).toBe("failed");
        expect(state.escalation?.code).toBe("env-setup-failed");
        expect(state.escalation?.detail).toMatch(/exited 2/);
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);
});

describe("attachRunWorkflow / rehydrateOpenWorkflows", () => {
  it("recompiles the saved lane and registerWorkflow before a resume can run", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        const registered: Array<{ runId: string; lane: string }> = [];
        const root = packageRoot();
        const lanes = await loadEffectiveLanes([join(root, "src", "assets", "lanes.yaml")]);
        const deps = {
          home,
          runsDir: join(home, "runs"),
          projectRootDefault: root,
          engine: {
            registerWorkflow: (runId: string, workflow: { lane: string }) => {
              registered.push({ runId, lane: workflow.lane });
            },
          },
          executor: { run: async () => ({ verdict: null, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 0 }) },
          provider: {},
          tracker: {},
          agents: await loadAgentDefs({
            root,
            models: {},
            defaultModel: "stub",
            required: ["planner", "implementer", "reviewer", "judge"],
          }),
          lanes,
          piBinary: "pi",
          repos: [fixture.repo],
        } as unknown as FactoryDeps;
        const state = fakeRunState({
          runId: "run-live",
          lane: "chore",
          mainCheckout: fixture.repo,
          status: "waiting_user",
        });
        await attachRunWorkflow(deps, state);
        expect(registered).toEqual([{ runId: "run-live", lane: "chore" }]);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rehydrates waiting_user and paused runs from disk", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        const runs = join(home, "runs");
        await mkdir(join(runs, "run-wait"), { recursive: true, mode: 0o700 });
        await mkdir(join(runs, "run-done"), { recursive: true, mode: 0o700 });
        const registered: string[] = [];
        const root = packageRoot();
        const deps = {
          home,
          runsDir: runs,
          projectRootDefault: root,
          engine: {
            registerWorkflow: (runId: string) => {
              registered.push(runId);
            },
          },
          executor: { run: async () => ({ verdict: null, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 0 }) },
          provider: {},
          tracker: {},
          agents: await loadAgentDefs({
            root,
            models: {},
            defaultModel: "stub",
            required: ["planner", "implementer", "reviewer", "judge"],
          }),
          lanes: await loadEffectiveLanes([join(root, "src", "assets", "lanes.yaml")]),
          piBinary: "pi",
          repos: [fixture.repo],
        } as unknown as FactoryDeps;
        await saveRunState(
          runs,
          fakeRunState({ runId: "run-wait", status: "waiting_user", lane: "chore", mainCheckout: fixture.repo }),
        );
        await saveRunState(
          runs,
          fakeRunState({ runId: "run-done", status: "succeeded", lane: "chore", mainCheckout: fixture.repo }),
        );
        const attached = await rehydrateOpenWorkflows(deps);
        expect(attached).toEqual(["run-wait"]);
        expect(registered).toEqual(["run-wait"]);
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
