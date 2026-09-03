import { describe, it, expect } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { probeSandbox } from "../../src/runtime/sandbox.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeFixtureRepo } from "../helpers/fixture-repo.js";
import { withTmpHome } from "../helpers/tmp-home.js";
import { generatedMarker, runDir } from "../../src/home.js";
import { readGeneratedFile, readGeneratedJson } from "../../src/engine/state.js";
import { verifyRecord } from "../../src/safety/evidence-sign.js";
import { parseFactoryArgs } from "../../src/commands/router.js";
import { runApprove } from "../../src/commands/approve.js";
import { runEnqueue } from "../../src/commands/enqueue.js";
import { runStart } from "../../src/commands/start.js";
import { steerDecisionsDir, type SteerDecisionFile } from "../../src/steer/index.js";
import type { RunState } from "../../src/engine/types.js";
import {
  branchTree,
  buildTestDeps,
  remoteTip,
  writeFactoryTestConfig,
  writeScenario,
} from "./harness.js";

async function assertJudgedPush(state: RunState, bare: string): Promise<void> {
  const head = (
    await exec("git", ["-C", state.workspaceDir, "rev-parse", "HEAD"], { encoding: "utf8" })
  ).stdout.trim();
  expect(head).toBe(state.judgedSha);
  expect(state.judgedSha).toBe(state.hostCommits.at(-1));
  await expect(remoteTip(bare, state.branch)).resolves.toBe(state.judgedSha);
  const listed = (
    await exec("git", ["-C", state.workspaceDir, "rev-list", "--reverse", `${state.baseSha}..HEAD`], {
      encoding: "utf8",
    })
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  expect(listed).toEqual(state.hostCommits);
}

const exec = promisify(execFile);
const JUNIT = "reports/junit.xml";

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

describe("chore lane end to end (unattended)", () => {
  it("runs scope-check → plan → steer → implement → test → review → judge → publish", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        await writeFactoryTestConfig(home, fixture.repo, { steering: "never", junitPath: JUNIT });
        const scenarioPath = await writeScenario(home, UNATTENDED_SCENARIO);
        const deps = await buildTestDeps({ home, repo: fixture.repo, scenarioPath });

        const { ticket } = await runEnqueue(
          parseFactoryArgs(`enqueue --task "add a greeting helper" --repo ${fixture.repo} --kind chore`),
          deps,
        );
        const states = await runStart(parseFactoryArgs("start"), deps);
        expect(states).toHaveLength(1);
        const state = states[0];
        if (state === undefined) throw new Error("no run state");

        expect(state.status).toBe("succeeded");
        expect(state.workspaceDir.startsWith(join(home, "worktrees"))).toBe(true);
        await expect(stat(state.workspaceDir)).resolves.toBeTruthy();

        const dir = runDir(state.runId);
        const planText = await readFile(join(dir, "plan.md"), "utf8");
        expect(planText.split("\n")[0]).toBe(generatedMarker(state.runId));
        expect(state.hostCommits).toHaveLength(1);
        const subjects = (
          await exec("git", ["-C", state.workspaceDir, "log", "--format=%s", `${state.baseSha}..HEAD`], {
            encoding: "utf8",
          })
        ).stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        expect(subjects).toEqual(["chore: add a greeting helper"]);
        const planEvidence = (await readGeneratedJson<{ headSha: string }>(
          join(dir, "evidence", "stage-plan-r0.json"),
        ))!;
        expect(planEvidence.headSha).toBe(state.baseSha);

        const secret = (await readFile(join(dir, ".secret"), "utf8")).trim();
        const evidenceNames = (await readdir(join(dir, "evidence"))).filter((name) => name.endsWith(".json"));
        const stages = ["scope-check", "plan", "steer", "implement", "test", "review", "judge", "publish"];
        for (const stage of stages) {
          expect(evidenceNames.some((name) => name.startsWith(`stage-${stage}-r`))).toBe(true);
        }
        for (const name of evidenceNames) {
          const record = (await readGeneratedJson<Record<string, unknown>>(join(dir, "evidence", name)))!;
          const sig = ((await readGeneratedFile(join(dir, "evidence", name.replace(/\.json$/, ".sig")))) ?? "").trim();
          expect(verifyRecord(record, sig, secret)).toBe(true);
        }

        expect(state.judgedSha).toBeTypeOf("string");
        await assertJudgedPush(state, fixture.bare);

        const tree = await branchTree(join(state.workspaceDir, ".git"), state.branch).catch(() =>
          branchTree(fixture.bare, state.branch),
        );
        expect(tree).not.toContain("plan.md");
        expect(tree).not.toContain("steer-packet.md");
        expect(tree).toContain("src/added.ts");

        const events = (await readFile(join(dir, "events.jsonl"), "utf8"))
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as { type: string; step?: string });
        const types = events.map((event) => event.type);
        expect(types).toContain("run.start");
        expect(types).toContain("stage.start");
        expect(types).toContain("stage.end");
        expect(types).toContain("run.end");
        expect(types).toContain("run.published");
        expect(types).not.toContain("run.escalate");
        expect(events.filter((e) => e.type === "stage.end").map((e) => e.step)).toEqual(
          expect.arrayContaining(["plan", "implement", "review", "judge", "publish"]),
        );

        const queue = JSON.parse(
          await readFile(join(deps.runsDir, "_factory", "queue.json"), "utf8"),
        ) as { entries: { ref: string; state: string; runId?: string }[] };
        const entry = queue.entries.find((candidate) => candidate.ref === ticket.ref.id);
        expect(entry?.state).toBe("published");
        expect(entry?.runId).toBe(state.runId);
      });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});

describe("chore lane end to end (steer gate)", () => {
  it("pauses at steer and resumes to completion on /factory approve", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        await writeFactoryTestConfig(home, fixture.repo, { steering: "always", junitPath: JUNIT });
        const scenarioPath = await writeScenario(home, UNATTENDED_SCENARIO);
        const deps = await buildTestDeps({ home, repo: fixture.repo, scenarioPath });

        const { ticket } = await runEnqueue(
          parseFactoryArgs(`enqueue --task "add a greeting helper" --repo ${fixture.repo} --kind chore`),
          deps,
        );

        const paused = await runStart(parseFactoryArgs("start"), deps);
        expect(paused).toHaveLength(1);
        const pausedState = paused[0];
        if (pausedState === undefined) throw new Error("no run state");
        expect(pausedState.status).toBe("waiting_user");
        expect(pausedState.currentStep).toBe("steer");
        expect(pausedState.pauseForUser?.reason).toBe("steer");

        const dir = runDir(pausedState.runId);
        const packetPath = pausedState.pauseForUser?.packetPath;
        expect(packetPath).toBeTypeOf("string");
        const packet = await readFile(packetPath ?? "", "utf8");
        expect(packet.split("\n")[0]).toBe(generatedMarker(pausedState.runId));

        await expect(remoteTip(fixture.bare, pausedState.branch)).rejects.toThrow();
        const queueWhilePaused = JSON.parse(
          await readFile(join(deps.runsDir, "_factory", "queue.json"), "utf8"),
        ) as { entries: { ref: string; state: string }[] };
        expect(queueWhilePaused.entries.find((e) => e.ref === ticket.ref.id)?.state).toBe("waiting_user");

        const resumed = await runApprove(
          parseFactoryArgs(`approve ${ticket.ref.id} looks right to me`),
          deps,
        );
        expect(resumed.status).toBe("succeeded");
        expect(resumed.runId).toBe(pausedState.runId);

        const decision = JSON.parse(
          await readFile(join(steerDecisionsDir(dir), "steer-1.json"), "utf8"),
        ) as SteerDecisionFile;
        expect(decision.schemaVersion).toBe(1);
        expect(decision.action).toBe("approve");
        expect(decision.notes).toBe("looks right to me");
        expect(decision.by).toBe("command");

        expect(resumed.judgedSha).toBeTypeOf("string");
        await assertJudgedPush(resumed, fixture.bare);

        const tree = await branchTree(fixture.bare, resumed.branch);
        expect(tree).not.toContain("steer-packet.md");
        expect(tree).not.toContain("plan.md");

        const queueAfter = JSON.parse(
          await readFile(join(deps.runsDir, "_factory", "queue.json"), "utf8"),
        ) as { entries: { ref: string; state: string }[] };
        expect(queueAfter.entries.find((e) => e.ref === ticket.ref.id)?.state).toBe("published");
      });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  it("refuses approve for a run that is not waiting_user", async () => {
    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        await writeFactoryTestConfig(home, fixture.repo, { steering: "never", junitPath: JUNIT });
        const scenarioPath = await writeScenario(home, UNATTENDED_SCENARIO);
        const deps = await buildTestDeps({ home, repo: fixture.repo, scenarioPath });
        const { ticket } = await runEnqueue(
          parseFactoryArgs(`enqueue --task "add a greeting helper" --repo ${fixture.repo} --kind chore`),
          deps,
        );
        await runStart(parseFactoryArgs("start"), deps);
        const ref = ticket.ref.id;
        await expect(runApprove(parseFactoryArgs(`approve ${ref}`), deps)).rejects.toThrow(
          `approve: ${ref} is published, not waiting_user`,
        );
      });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});

describe("chore lane end to end (sandbox)", () => {
  it("completes with sandbox required when the provider probe works", async () => {
    const probe = await probeSandbox();
    if (!probe.available) {
      console.warn(`skipping sandbox e2e: ${probe.detail}`);
      return;
    }

    const fixture = await makeFixtureRepo();
    try {
      await withTmpHome(async (home) => {
        await writeFactoryTestConfig(home, fixture.repo, {
          steering: "never",
          junitPath: JUNIT,
          sandbox: "required",
        });
        const scenarioPath = await writeScenario(home, UNATTENDED_SCENARIO);
        const deps = await buildTestDeps({ home, repo: fixture.repo, scenarioPath, sandbox: true });

        await runEnqueue(
          parseFactoryArgs(`enqueue --task "add a greeting helper" --repo ${fixture.repo} --kind chore`),
          deps,
        );
        const states = await runStart(parseFactoryArgs("start"), deps);
        expect(states).toHaveLength(1);
        const state = states[0];
        if (state === undefined) throw new Error("no run state");

        expect(state.status).toBe("succeeded");
        const dir = runDir(state.runId);
        const profile = join(dir, probe.provider === "bwrap" ? "sandbox.bwrap" : "sandbox.sb");
        await expect(stat(profile)).resolves.toBeTruthy();
        await assertJudgedPush(state, fixture.bare);
      });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});

