import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runTicket } from "../../src/controller/lane-runner.js";
import type { PrClient } from "../../src/git/pr.js";
import { readQueue } from "../../src/scheduler/queue.js";
import {
  GITHUB_FIXTURE_ISSUE,
  GITHUB_FIXTURE_REPO,
  makeGithubFactoryWorld,
} from "../helpers/github-fixture.js";
import { branchTree, buildTestDeps, remoteTip, writeScenario } from "./harness.js";

const PLAN_MD = [
  "## Goal",
  "Add a greeting helper. No intended behaviour change to existing code.",
  "",
  "## Files to touch",
  "- src/added.ts",
  "- tests/added.test.ts",
  "",
  "## Steps",
  "1. Add the helper.",
  "2. Add its test.",
  "",
  "## Verify",
  "vitest",
  "",
  "## Out of scope",
  "- everything else",
  "",
].join("\n");

const ADDED_TS = "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n";

const UNATTENDED_SCENARIO = {
  plan: {
    verdict: "PASS",
    runDirFiles: { "plan.md": PLAN_MD },
    artifacts: ["plan.md"],
  },
  implement: {
    verdict: "PASS",
    files: { "src/added.ts": ADDED_TS },
    commit_message: "chore: add a greeting helper",
  },
  review: {
    verdict: "PASS",
    runDirFiles: { "review.md": "PASS\n\nChecked src/added.ts:1. No blocking findings.\n" },
  },
  judge: { verdict: "PASS" },
};

function issueKey(): string {
  return `${GITHUB_FIXTURE_REPO}#${GITHUB_FIXTURE_ISSUE}`;
}

describe("v1 github claim → PR", () => {
  it("claims a labelled ticket, runs chore, and publishes a PR on the fixture remote", async () => {
    const world = await makeGithubFactoryWorld();
    try {
      const scenarioPath = await writeScenario(world.home, UNATTENDED_SCENARIO);
      const prCalls: Array<Parameters<PrClient["create"]>[0]> = [];
      const pr: PrClient = {
        async create(opts) {
          prCalls.push(opts);
          return { number: 9, url: `https://github.com/${GITHUB_FIXTURE_REPO}/pull/9` };
        },
      };
      const adapters = new Map([
        ["github", world.adapter],
      ]);
      const deps = await buildTestDeps({
        home: world.home,
        repo: world.fixture.repo,
        scenarioPath,
        adapters,
        pr,
        analyst: world.analyst,
      });

      const drained = await deps.scheduler!.drainOnce();
      expect(drained.claimed).toBe(1);
      expect(world.gh.issues?.[issueKey()]?.labels).toContain("factory:in-progress");
      expect(world.gh.issues?.[issueKey()]?.labels).not.toContain("factory:ready");

      const afterClaim = await readQueue(deps.runsDir);
      const claimed = afterClaim.entries.find((e) => e.key === `github:${GITHUB_FIXTURE_REPO}:${GITHUB_FIXTURE_ISSUE}`);
      expect(claimed?.state).toBe("ready");
      expect(claimed?.kind).toBe("chore");
      expect(claimed?.confidence).toBe("HIGH");

      const ticket = await world.adapter.fetch(world.issueRef);
      if (claimed?.kind !== undefined) ticket.kind = claimed.kind;
      const state = await runTicket(
        ticket,
        world.fixture.repo,
        deps,
        claimed?.lane === undefined ? undefined : { lane: claimed.lane },
      );
      expect(state.status).toBe("succeeded");
      expect(state.branch).toMatch(/^factory\/github-42-/);
      expect(state.judgedSha).toBeTypeOf("string");
      await expect(remoteTip(world.fixture.bare, state.branch)).resolves.toBe(state.judgedSha);

      expect(prCalls).toHaveLength(1);
      expect(prCalls[0]?.base).toBe("main");
      expect(prCalls[0]?.head).toBe(state.branch);
      expect(prCalls[0]?.head).toMatch(/^factory\/github-42-/);
      expect(prCalls[0]?.body).toMatch(/## Acceptance/);
      expect(prCalls[0]?.body).toContain(`Fixes #${GITHUB_FIXTURE_ISSUE}`);

      const queue = await readQueue(deps.runsDir);
      const entry = queue.entries.find((e) => e.runId === state.runId);
      expect(entry?.state).toBe("published");
      expect(entry?.prUrl).toBe(`https://github.com/${GITHUB_FIXTURE_REPO}/pull/9`);

      const handoffPath = join(deps.runsDir, state.runId, "handoff.json");
      await expect(stat(handoffPath)).resolves.toBeTruthy();
      const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as {
        branch: string;
        judgedSha: string;
        prUrl?: string;
      };
      expect(handoff.branch).toBe(state.branch);
      expect(handoff.judgedSha).toBe(state.judgedSha);
      expect(handoff.prUrl).toBe(entry?.prUrl);

      const comments = world.gh.comments?.[issueKey()] ?? [];
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toMatch(/published/);

      const tree = await branchTree(world.fixture.bare, state.branch);
      expect(tree).toContain("src/added.ts");
      expect(tree).not.toContain("plan.md");
    } finally {
      await world.cleanup();
    }
  }, 180_000);
});
