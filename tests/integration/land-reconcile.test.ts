import { describe, it, expect } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTicket, type FactoryDeps } from "../../src/controller/lane-runner.js";
import type { Handoff } from "../../src/git/handoff.js";
import type { PrClient } from "../../src/git/pr.js";
import { landReconcile } from "../../src/git/reconcile.js";
import { recoverFactory } from "../../src/scheduler/recover.js";
import { readQueue } from "../../src/scheduler/queue.js";
import {
  GITHUB_FIXTURE_ISSUE,
  GITHUB_FIXTURE_REPO,
  makeGithubFactoryWorld,
  type GithubFactoryWorld,
} from "../helpers/github-fixture.js";
import { buildTestDeps, writeScenario } from "./harness.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/v1-github-claim/", import.meta.url));

const PLAN_MD = [
  "## Goal",
  "Add a greeting helper. No intended behaviour change to existing code.",
  "",
  "## Files to touch",
  "- src/added.ts",
  "",
  "## Steps",
  "1. Add the helper.",
  "",
  "## Verify",
  "vitest",
  "",
  "## Out of scope",
  "- everything else",
  "",
].join("\n");

const UNATTENDED_SCENARIO = {
  plan: {
    verdict: "PASS",
    runDirFiles: { "plan.md": PLAN_MD },
    artifacts: ["plan.md"],
  },
  implement: {
    verdict: "PASS",
    files: { "src/added.ts": "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n" },
    commit_message: "chore: add a greeting helper",
  },
  review: {
    verdict: "PASS",
    runDirFiles: { "review.md": "PASS\n\nChecked src/added.ts:1. No blocking findings.\n" },
  },
  judge: { verdict: "PASS" },
};

interface PublishedRun {
  world: GithubFactoryWorld;
  deps: FactoryDeps;
  runId: string;
  branch: string;
  judgedSha: string;
}

async function publishGithubChore(world: GithubFactoryWorld): Promise<PublishedRun> {
  const scenarioPath = await writeScenario(world.home, UNATTENDED_SCENARIO);
  const pr: PrClient = {
    async create() {
      return { number: 9, url: `https://github.com/${GITHUB_FIXTURE_REPO}/pull/9` };
    },
  };
  const deps = await buildTestDeps({
    home: world.home,
    repo: world.fixture.repo,
    scenarioPath,
    adapters: new Map([["github", world.adapter]]),
    pr,
    analyst: world.analyst,
  });
  const drained = await deps.scheduler!.drainOnce();
  if (drained.claimed !== 1) throw new Error(`expected 1 claim, got ${drained.claimed}`);
  const ticket = await world.adapter.fetch(world.issueRef);
  ticket.kind = "chore";
  const state = await runTicket(ticket, world.fixture.repo, deps, { lane: "chore" });
  if (state.status !== "succeeded" || state.judgedSha === undefined) {
    throw new Error(`expected succeeded publish, got ${state.status}`);
  }
  return { world, deps, runId: state.runId, branch: state.branch, judgedSha: state.judgedSha };
}

describe("v1 land-reconcile after github publish", () => {
  it("marks a clean merge landed from git history and recovers a dead child pid", async () => {
    const world = await makeGithubFactoryWorld();
    try {
      const published = await publishGithubChore(world);
      const { deps, runId, branch, judgedSha } = published;

      const handoff = JSON.parse(await readFile(join(deps.runsDir, runId, "handoff.json"), "utf8")) as Handoff;
      const shape = JSON.parse(await readFile(join(FIXTURE_DIR, "handoff.json"), "utf8")) as Record<string, unknown>;
      expect(Object.keys(handoff).sort()).toEqual(Object.keys(shape).sort());
      expect(handoff.ref).toContain(`#${GITHUB_FIXTURE_ISSUE}`);
      expect(handoff.branch).toMatch(/^factory\/github-42-/);
      expect(handoff.judgedSha).toBe(judgedSha);
      expect(handoff.prUrl).toMatch(/\/pull\/9$/);

      const events = (await readFile(join(deps.runsDir, runId, "events.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { type: string });
      const types = events.map((e) => e.type);
      const expected = JSON.parse(await readFile(join(FIXTURE_DIR, "expected-events.json"), "utf8")) as string[];
      for (const type of expected) expect(types).toContain(type);

      if (process.env.PI_SDLC_RECORD === "1") {
        await mkdir(FIXTURE_DIR, { recursive: true });
        await writeFile(join(FIXTURE_DIR, "expected-events.json"), `${JSON.stringify(expected, null, 2)}\n`, "utf8");
        const recorded = {
          ...shape,
          ref: handoff.ref,
          lane: handoff.lane,
          branch: "factory/github-42-slug",
          changedFiles: handoff.changedFiles,
          writeGlobs: handoff.writeGlobs,
          prUrl: handoff.prUrl,
        };
        await writeFile(join(FIXTURE_DIR, "handoff.json"), `${JSON.stringify(recorded, null, 2)}\n`, "utf8");
      }

      const fetch = await world.fixture.git(["fetch", "-q", "origin"]);
      expect(fetch.code, fetch.stderr).toBe(0);
      const merge = await world.fixture.git(["merge", "--no-ff", "-m", `merge ${branch}`, `origin/${branch}`]);
      expect(merge.code, merge.stderr).toBe(0);
      const push = await world.fixture.git(["push", "-q", "origin", "main"]);
      expect(push.code, push.stderr).toBe(0);

      const queue = await readQueue(deps.runsDir);
      const entry = queue.entries.find((e) => e.runId === runId);
      expect(entry?.state).toBe("published");
      if (entry === undefined) throw new Error("missing published queue entry");

      const out = await landReconcile(entry, {
        cwd: world.fixture.repo,
        base: "main",
        abandonDays: 7,
        runsDir: deps.runsDir,
      });
      expect(out.state).toBe("landed");
      expect(out.landedAs).toBe("clean");
      expect(out.landedBy).toBe("git");
      expect(out.landedSha).toMatch(/^[0-9a-f]{40}$/);

      await mkdir(dirname(join(deps.runsDir, runId, "_children.json")), { recursive: true });
      await writeFile(
        join(deps.runsDir, runId, "_children.json"),
        `${JSON.stringify([{ pid: 999999999, pgid: 999999999 }])}\n`,
        "utf8",
      );
      await expect(
        recoverFactory({
          runsDir: deps.runsDir,
          kill: (pid, sig) => {
            try {
              process.kill(pid, sig);
            } catch {
              /* already gone */
            }
          },
        }),
      ).resolves.toMatchObject({ orphansKilled: 1 });
    } finally {
      await world.cleanup();
    }
  }, 180_000);
});
