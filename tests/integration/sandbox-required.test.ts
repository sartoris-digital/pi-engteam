import { describe, it, expect } from "vitest";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runTicket, type FactoryDeps } from "../../src/controller/lane-runner.js";
import { makeEngine } from "../../src/controller/register.js";
import { loadAgentDefs, packageRoot } from "../../src/controller/agents.js";
import { loadEffectiveLanes } from "../../src/lanes/index.js";
import { HeadlessExecutor } from "../../src/runtime/headless.js";
import { probeSandbox, profileForRequest, wrapArgv } from "../../src/runtime/sandbox.js";
import { LocalAdapter } from "../../src/trackers/local.js";
import { GitWorktreeProvider } from "../../src/workspace/git-provider.js";
import { writeRepoConfig } from "../../src/setup/writers.js";
import { makeWorkerRequest } from "../helpers/worker-request.js";
import { makeFixtureRepo } from "../helpers/fixture-repo.js";
import { withTmpHome } from "../helpers/tmp-home.js";

describe("sandbox: required", () => {
  it("fails the run with env-setup-failed and never calls the executor when the probe is down", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        await writeRepoConfig(fixture.repo, { defaults: { sandbox: "required" } }, { local: true });
        const runs = join(home, "runs");
        await mkdir(join(runs, "_factory"), { recursive: true, mode: 0o700 });
        const root = packageRoot();
        let execCalls = 0;
        const deps: FactoryDeps = {
          home,
          runsDir: runs,
          projectRootDefault: root,
          engine: makeEngine(runs, { coAuthoredBy: false }),
          executor: {
            run: async () => {
              execCalls += 1;
              return { verdict: null, exitCode: 0, timedOut: false, stderrTail: "", durationMs: 0 };
            },
          },
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
          probeSandbox: async () => ({ available: false, provider: null, detail: "no provider" }),
        };
        const state = await runTicket(
          {
            ref: { tracker: "local", id: "local-sandbox-req" },
            title: "sandbox required",
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
        expect(state.escalation?.detail).toMatch(/no provider/);
        expect(execCalls).toBe(0);
      });
    } finally {
      await fixture.cleanup();
    }
  }, 60_000);

  it("wrapArgv writes sandbox.sb (or bwrap profile) under the run dir when the machine probe is available", async () => {
    const probe = await probeSandbox();
    if (!probe.available) {
      expect(probe.available).toBe(false);
      return;
    }
    await withTmpHome(async (home) => {
      const runDir = join(home, "runs", "run-sb");
      const cwd = join(home, "ws");
      await mkdir(cwd, { recursive: true });
      const profile = profileForRequest(makeWorkerRequest({ runId: "run-sb", runDir, cwd }), { home });
      wrapArgv(["pi", "-p"], profile);
      const expected = process.platform === "linux" ? join(runDir, "sandbox.bwrap") : join(runDir, "sandbox.sb");
      await access(expected);
    });
  });
});
