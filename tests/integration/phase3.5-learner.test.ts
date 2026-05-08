import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLearner, type GapEntry } from "../../src/learner/LearnerOrchestrator.js";
import type { VerdictPayload } from "../../src/types.js";

// Same shim as the unit test: replace `uv run --script` with `bash` so we can
// exercise the orchestrator's spawn pipeline without a uv install in CI.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: any) => {
      if (cmd === "uv" && args[0] === "run" && args[1] === "--script") {
        return actual.spawn("bash", [args[2], ...args.slice(3)], opts);
      }
      return actual.spawn(cmd, args, opts);
    },
  };
});

const STUB = `#!/usr/bin/env bash
fixture=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixture) fixture="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -f "$fixture" ]] || exit 2
[[ "$(cat "$fixture")" == "ok" ]] && exit 0 || exit 1
`;

async function setupEnv() {
  const work = await mkdtemp(join(tmpdir(), "phase3.5-"));
  const scriptsDir = join(work, "verifier-scripts");
  const stagingDir = join(scriptsDir, ".staging");
  const versionsDir = join(scriptsDir, ".versions");
  const fixturesDir = join(scriptsDir, ".fixtures");
  const changelogPath = join(scriptsDir, "CHANGELOG.md");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(versionsDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(changelogPath, "# CHANGELOG\n");
  const runsDir = join(work, "runs");
  const runId = "run-int";
  const runDir = join(runsDir, runId);
  const learningDir = join(runDir, "learning");
  await mkdir(learningDir, { recursive: true });
  return { work, scriptsDir, stagingDir, versionsDir, fixturesDir, changelogPath, runsDir, runId, runDir, learningDir };
}

function makeTeam(judgeApprove: boolean, proposalFn: (env: any) => any[]) {
  return {
    deliver: vi.fn(async (agent: string, _msg: any) => {
      if (agent === "learner") {
        return { step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposalFn((makeTeam as any).env)) } as VerdictPayload;
      }
      if (agent === "judge") {
        return judgeApprove
          ? { step: "approve", verdict: "PASS" } as VerdictPayload
          : { step: "approve", verdict: "FAIL", issues: ["denied"] } as VerdictPayload;
      }
      return undefined;
    }),
    setRunId: vi.fn(),
    setStepContext: vi.fn(),
    markStepComplete: vi.fn(),
  } as any;
}

describe("Phase 3.5 Learner end-to-end", () => {
  let env: Awaited<ReturnType<typeof setupEnv>>;

  beforeEach(async () => {
    env = await setupEnv();
    (makeTeam as any).env = env;
  });

  afterEach(async () => {
    await rm(env.work, { recursive: true }).catch(() => {});
  });

  async function writeGaps(gaps: GapEntry[]) {
    await writeFile(
      join(env.learningDir, "gaps.jsonl"),
      gaps.map((g) => JSON.stringify(g)).join("\n") + "\n",
    );
  }

  async function preStage(name: string, fixtureContent: string): Promise<{ stagedPath: string; fixturePath: string }> {
    const stagedPath = join(env.stagingDir, name);
    const fixturePath = join(env.fixturesDir, name.replace(/\.[^.]+$/, "") + "_fixture.txt");
    await writeFile(stagedPath, STUB);
    await chmod(stagedPath, 0o755);
    await writeFile(fixturePath, fixtureContent);
    return { stagedPath, fixturePath };
  }

  it("end-to-end: gaps.jsonl → staging → judge approves → script promoted", async () => {
    const sampleGap: GapEntry = {
      runId: env.runId, step: "build",
      claim: "FK created", reason: "PARTIAL",
      ts: new Date().toISOString(),
    };
    await writeGaps([sampleGap]);
    const { fixturePath } = await preStage("verify_fk.py", "ok");

    const team = makeTeam(true, () => ([{
      gap: sampleGap, category: "new-domain-script",
      scriptName: "verify_fk.py", approach: "FK presence",
      fixturePath, regressionCommand: "x",
    }]));

    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir,
      versionsDir: env.versionsDir, fixturesDir: env.fixturesDir,
      changelogPath: env.changelogPath,
      gapsPaths: [join(env.learningDir, "gaps.jsonl")],
      reportRunDir: env.learningDir,
    });

    expect(result.scriptsPromoted).toBe(1);
    expect(existsSync(join(env.scriptsDir, "verify_fk.py"))).toBe(true);
    expect(existsSync(join(env.stagingDir, "verify_fk.py"))).toBe(false);
  });

  it("end-to-end: judge denies → no active file written", async () => {
    const gap: GapEntry = { runId: env.runId, step: "build", claim: "x", reason: "y", ts: "2026-05-07T00:00:00Z" };
    await writeGaps([gap]);
    const { fixturePath } = await preStage("verify_x.py", "ok");
    const team = makeTeam(false, () => ([{
      gap, category: "new-domain-script", scriptName: "verify_x.py",
      approach: "x", fixturePath, regressionCommand: "x",
    }]));
    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir,
      versionsDir: env.versionsDir, fixturesDir: env.fixturesDir,
      changelogPath: env.changelogPath,
      gapsPaths: [join(env.learningDir, "gaps.jsonl")],
      reportRunDir: env.learningDir,
    });
    expect(result.scriptsPromoted).toBe(0);
    expect(existsSync(join(env.scriptsDir, "verify_x.py"))).toBe(false);
  });

  it("end-to-end: regression fixture failure blocks promotion BEFORE Judge is called", async () => {
    const gap: GapEntry = { runId: env.runId, step: "build", claim: "x", reason: "y", ts: "2026-05-07T00:00:00Z" };
    await writeGaps([gap]);
    const { fixturePath } = await preStage("verify_y.py", "ok");
    // existing fixture causes regression
    await writeFile(join(env.fixturesDir, "broken.txt"), "fail");

    const team = makeTeam(true, () => ([{
      gap, category: "new-domain-script", scriptName: "verify_y.py",
      approach: "x", fixturePath, regressionCommand: "x",
    }]));
    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir,
      versionsDir: env.versionsDir, fixturesDir: env.fixturesDir,
      changelogPath: env.changelogPath,
      gapsPaths: [join(env.learningDir, "gaps.jsonl")],
      reportRunDir: env.learningDir,
    });
    expect(result.scriptsPromoted).toBe(0);
    expect(team.deliver).toHaveBeenCalledTimes(1); // only learner; judge skipped
  });

  it("end-to-end: archives prior version when promoting an existing script", async () => {
    const gap: GapEntry = { runId: env.runId, step: "build", claim: "extend", reason: "y", ts: "2026-05-07T00:00:00Z" };
    await writeGaps([gap]);
    const stagedName = "verify_existing.py";
    await writeFile(join(env.scriptsDir, stagedName), "# v0\n");
    const { fixturePath } = await preStage(stagedName, "ok");

    const team = makeTeam(true, () => ([{
      gap, category: "existing-script-extension", scriptName: stagedName,
      approach: "x", fixturePath, regressionCommand: "x",
    }]));
    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir,
      versionsDir: env.versionsDir, fixturesDir: env.fixturesDir,
      changelogPath: env.changelogPath,
      gapsPaths: [join(env.learningDir, "gaps.jsonl")],
      reportRunDir: env.learningDir,
    });
    expect(result.scriptsPromoted).toBe(1);
    const dirs = await readdir(env.versionsDir);
    expect(dirs.length).toBe(1);
    const archived = await readFile(join(env.versionsDir, dirs[0], stagedName), "utf8");
    expect(archived).toContain("# v0");
  });

  it("end-to-end: empty gaps file produces a report with zero counts", async () => {
    await writeGaps([]);
    const team = makeTeam(true, () => []);
    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir,
      versionsDir: env.versionsDir, fixturesDir: env.fixturesDir,
      changelogPath: env.changelogPath,
      gapsPaths: [join(env.learningDir, "gaps.jsonl")],
      reportRunDir: env.learningDir,
    });
    expect(result.gapsProcessed).toBe(0);
    expect(result.scriptsPromoted).toBe(0);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Gaps processed: 0");
  });

  it("end-to-end: CHANGELOG entry appended on promotion", async () => {
    const gap: GapEntry = { runId: env.runId, step: "build", claim: "FK", reason: "y", ts: "2026-05-07T00:00:00Z" };
    await writeGaps([gap]);
    const { fixturePath } = await preStage("verify_log.py", "ok");
    const team = makeTeam(true, () => ([{
      gap, category: "new-domain-script", scriptName: "verify_log.py",
      approach: "x", fixturePath, regressionCommand: "x",
    }]));
    await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir,
      versionsDir: env.versionsDir, fixturesDir: env.fixturesDir,
      changelogPath: env.changelogPath,
      gapsPaths: [join(env.learningDir, "gaps.jsonl")],
      reportRunDir: env.learningDir,
    });
    const log = await readFile(env.changelogPath, "utf8");
    expect(log).toContain("verify_log.py");
    expect(log).toContain("category: new-domain-script");
  });
});
