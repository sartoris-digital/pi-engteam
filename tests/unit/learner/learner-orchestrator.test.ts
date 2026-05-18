import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runLearner,
  parseProposalsFromVerdict,
  _testing,
  type GapEntry,
  type ProposedChange,
} from "../../../src/learner/LearnerOrchestrator.js";
import type { VerdictPayload } from "../../../src/types.js";

// We avoid invoking `uv` in unit tests by replacing the staged "script" with a
// small bash script that reads a fixture path and exits 0/1 based on a marker.
// The orchestrator passes `--fixture <path>` to the script — our shim accepts
// that flag.
const STUB_SCRIPT_BODY = `#!/usr/bin/env bash
# Fixture-driver: pass when fixture content equals "ok", fail otherwise.
fixture=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixture) fixture="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ ! -f "$fixture" ]]; then exit 2; fi
content="$(cat "$fixture")"
if [[ "$content" == "ok" ]]; then exit 0; else exit 1; fi
`;

// Replace the imported runScript with one that interprets the staged file as a
// bash script directly. We do this by monkey-patching the module's spawn import.
// vi.mock keeps the swap localized to this test file.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: any) => {
      // Convert "uv run --script <path> --fixture <fixture>" → "bash <path> --fixture <fixture>"
      if (cmd === "uv" && args[0] === "run" && args[1] === "--script") {
        const scriptPath = args[2];
        const rest = args.slice(3);
        return actual.spawn("bash", [scriptPath, ...rest], opts);
      }
      return actual.spawn(cmd, args, opts);
    },
  };
});

type DeliverArgs = { agent: string; message: any; opts?: any };

function makeMockTeam(responses: Array<(args: DeliverArgs) => Promise<VerdictPayload | undefined> | VerdictPayload | undefined>) {
  let idx = 0;
  const calls: DeliverArgs[] = [];
  const team: any = {
    deliver: vi.fn(async (agent: string, message: any, opts?: any) => {
      calls.push({ agent, message, opts });
      const fn = responses[idx] ?? responses[responses.length - 1];
      idx++;
      return await fn({ agent, message, opts });
    }),
    setRunId: vi.fn(),
    setStepContext: vi.fn(),
    markStepComplete: vi.fn(),
  };
  return { team, calls };
}

async function setupScriptsDir(): Promise<{
  scriptsDir: string;
  stagingDir: string;
  versionsDir: string;
  fixturesDir: string;
  changelogPath: string;
}> {
  const scriptsDir = await mkdtemp(join(tmpdir(), "learner-scripts-"));
  const stagingDir = join(scriptsDir, ".staging");
  const versionsDir = join(scriptsDir, ".versions");
  const fixturesDir = join(scriptsDir, ".fixtures");
  const changelogPath = join(scriptsDir, "CHANGELOG.md");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(versionsDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(changelogPath, "# CHANGELOG\n");
  return { scriptsDir, stagingDir, versionsDir, fixturesDir, changelogPath };
}

async function writeStub(path: string): Promise<void> {
  await writeFile(path, STUB_SCRIPT_BODY);
  await chmod(path, 0o755);
}

async function writeGapsFile(path: string, gaps: GapEntry[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await writeFile(path, gaps.map((g) => JSON.stringify(g)).join("\n") + "\n");
}

const SAMPLE_GAP: GapEntry = {
  runId: "run-1",
  step: "build",
  claim: "FK created in users table",
  reason: "verifier reported PARTIAL",
  ts: "2026-05-07T00:00:00.000Z",
};

describe("LearnerOrchestrator", () => {
  let workdir: string;
  let env: Awaited<ReturnType<typeof setupScriptsDir>>;
  let gapsPath: string;
  let runDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "learner-work-"));
    env = await setupScriptsDir();
    runDir = join(workdir, "runs", "run-1");
    await mkdir(join(runDir, "learning"), { recursive: true });
    gapsPath = join(runDir, "learning", "gaps.jsonl");
    await writeGapsFile(gapsPath, [SAMPLE_GAP]);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true }).catch(() => {});
    await rm(env.scriptsDir, { recursive: true }).catch(() => {});
  });

  it("dispatches gather/classify to the learner agent and parses proposals", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    const proposals: Array<Partial<ProposedChange>> = [{
      gap: SAMPLE_GAP,
      category: "new-domain-script",
      scriptName: stagedName,
      approach: "verify FK presence via sqlite pragma",
      fixturePath,
      regressionCommand: `uv run --script ${stagedPath} --fixture ${fixturePath}`,
    }];

    // Pre-create the staged script and fixture so validation passes.
    await writeStub(stagedPath);
    await writeFile(fixturePath, "ok");

    const { team, calls } = makeMockTeam([
      // Learner returns proposals via handoffHint JSON.
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
      // Judge approves.
      async () => ({ step: "approve", verdict: "PASS" }),
    ]);

    const result = await runLearner({
      team,
      learnerAgentName: "learner",
      judgeAgentName: "judge",
      scriptsDir: env.scriptsDir,
      stagingDir: env.stagingDir,
      versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir,
      changelogPath: env.changelogPath,
      gapsPaths: [gapsPath],
      reportRunDir: join(runDir, "learning"),
    });

    expect(result.gapsProcessed).toBe(1);
    expect(result.scriptsProposed).toBe(1);
    expect(result.scriptsApproved).toBe(1);
    expect(result.scriptsPromoted).toBe(1);
    expect(calls[0].agent).toBe("learner");
    expect(calls[1].agent).toBe("judge");
  });

  it("requests Judge approval per script, with diff and validation in the message", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    await writeStub(stagedPath);
    await writeFile(fixturePath, "ok");

    const proposals = [{
      gap: SAMPLE_GAP, category: "new-domain-script",
      scriptName: stagedName, approach: "x", fixturePath, regressionCommand: "x",
    }];

    const { team, calls } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
      async () => ({ step: "approve", verdict: "PASS" }),
    ]);

    await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });

    const judgeCall = calls.find((c) => c.agent === "judge")!;
    expect(judgeCall.message.message).toContain("Diff:");
    expect(judgeCall.message.message).toContain("Validation:");
    expect(judgeCall.message.message).toContain(stagedName);
  });

  it("passes cfg.runId to learner and judge dispatches", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    await writeStub(stagedPath);
    await writeFile(fixturePath, "ok");

    const proposals = [{
      gap: SAMPLE_GAP, category: "new-domain-script",
      scriptName: stagedName, approach: "x", fixturePath, regressionCommand: "x",
    }];

    const { team, calls } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
      async () => ({ step: "approve", verdict: "FAIL", issues: ["no token"] }),
    ]);

    await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
      runId: "learner-run-1",
      runsDir: join(workdir, "runs"),
    });

    expect(calls.map((c) => [c.agent, c.opts])).toEqual([
      ["learner", { runId: "learner-run-1" }],
      ["judge", { runId: "learner-run-1" }],
    ]);
  });

  it("promotes only on Judge approval (rejection path leaves no active script)", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    await writeStub(stagedPath);
    await writeFile(fixturePath, "ok");

    const proposals = [{
      gap: SAMPLE_GAP, category: "new-domain-script",
      scriptName: stagedName, approach: "x", fixturePath, regressionCommand: "x",
    }];

    const { team } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
      // Judge denies.
      async () => ({ step: "approve", verdict: "FAIL", issues: ["unsafe shape"] }),
    ]);

    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });

    expect(result.scriptsApproved).toBe(0);
    expect(result.scriptsPromoted).toBe(0);
    expect(result.escalations.some((e) => e.includes("judge-denied"))).toBe(true);
    expect(existsSync(join(env.scriptsDir, stagedName))).toBe(false);
  });

  it("blocks promotion when the new fixture itself fails validation", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    await writeStub(stagedPath);
    // Fixture content NOT "ok" → stub returns exit 1.
    await writeFile(fixturePath, "bad");

    const proposals = [{
      gap: SAMPLE_GAP, category: "new-domain-script",
      scriptName: stagedName, approach: "x", fixturePath, regressionCommand: "x",
    }];

    const { team, calls } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
    ]);

    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });

    expect(result.scriptsApproved).toBe(0);
    expect(result.scriptsPromoted).toBe(0);
    expect(result.escalations.some((e) => e.includes("validation-failed"))).toBe(true);
    // Judge was never asked.
    expect(calls.some((c) => c.agent === "judge")).toBe(false);
  });

  it("blocks promotion when an existing fixture starts failing (regression guard)", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    const existingFixture = join(env.fixturesDir, "preexisting.txt");
    await writeStub(stagedPath);
    await writeFile(fixturePath, "ok");
    await writeFile(existingFixture, "fail-me"); // stub returns 1 on this

    const proposals = [{
      gap: SAMPLE_GAP, category: "new-domain-script",
      scriptName: stagedName, approach: "x", fixturePath, regressionCommand: "x",
    }];
    const { team } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
    ]);

    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });

    expect(result.scriptsPromoted).toBe(0);
    expect(result.escalations.some((e) => e.includes("validation-failed"))).toBe(true);
  });

  it("archives prior version of an active script and appends to CHANGELOG", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    const activePath = join(env.scriptsDir, stagedName);
    // Pre-existing active script.
    await writeFile(activePath, "# prior version\n");
    await writeStub(stagedPath);
    await writeFile(fixturePath, "ok");

    const proposals = [{
      gap: SAMPLE_GAP, category: "existing-script-extension",
      scriptName: stagedName, approach: "x", fixturePath, regressionCommand: "x",
    }];
    const { team } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
      async () => ({ step: "approve", verdict: "PASS" }),
    ]);

    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });

    expect(result.scriptsPromoted).toBe(1);
    const versions = await readdir(env.versionsDir);
    expect(versions.length).toBeGreaterThan(0);
    const archivedFiles = await readdir(join(env.versionsDir, versions[0]));
    expect(archivedFiles).toContain(stagedName);
    const changelog = await readFile(env.changelogPath, "utf8");
    expect(changelog).toContain(stagedName);
  });

  it("escalates unaddressable-escalation gaps without promoting anything", async () => {
    const proposals = [{
      gap: SAMPLE_GAP, category: "unaddressable-escalation",
      scriptName: "ignored.py", approach: "needs new infra",
      fixturePath: "x", regressionCommand: "x",
    }];
    const { team, calls } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
    ]);

    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });

    expect(result.scriptsPromoted).toBe(0);
    expect(result.escalations.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.agent === "judge")).toBe(false);
  });

  it("writes a learning report with summary counts and escalations", async () => {
    const proposals: Array<Partial<ProposedChange>> = [];
    const { team } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
    ]);
    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });
    expect(existsSync(result.reportPath)).toBe(true);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Gaps processed: 1");
    expect(report).toContain("Scripts promoted: 0");
  });

  it("returns 0 gaps when the gap file is missing", async () => {
    const { team } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: "[]" }),
    ]);
    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: ["/nonexistent/gaps.jsonl"], reportRunDir: join(runDir, "learning"),
    });
    expect(result.gapsProcessed).toBe(0);
    expect(result.scriptsProposed).toBe(0);
  });

  it("invokes onPromote callback after each successful promotion", async () => {
    const stagedName = "verify_fk.py";
    const stagedPath = join(env.stagingDir, stagedName);
    const fixturePath = join(env.fixturesDir, "fk_fixture.txt");
    await writeStub(stagedPath);
    await writeFile(fixturePath, "ok");

    const proposals = [{
      gap: SAMPLE_GAP, category: "new-domain-script",
      scriptName: stagedName, approach: "x", fixturePath, regressionCommand: "x",
    }];
    const { team } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
      async () => ({ step: "approve", verdict: "PASS" }),
    ]);
    const onPromote = vi.fn();
    await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
      onPromote,
    });
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote.mock.calls[0][0]).toBe(stagedName);
  });

  it("escalates when the learner reports a script but the staged file is missing", async () => {
    const proposals = [{
      gap: SAMPLE_GAP, category: "new-domain-script",
      scriptName: "ghost.py", approach: "x",
      fixturePath: join(env.fixturesDir, "ghost_fixture.txt"),
      regressionCommand: "x",
    }];
    const { team } = makeMockTeam([
      async () => ({ step: "learn", verdict: "PASS", handoffHint: JSON.stringify(proposals) }),
    ]);
    const result = await runLearner({
      team, learnerAgentName: "learner", judgeAgentName: "judge",
      scriptsDir: env.scriptsDir, stagingDir: env.stagingDir, versionsDir: env.versionsDir,
      fixturesDir: env.fixturesDir, changelogPath: env.changelogPath,
      gapsPaths: [gapsPath], reportRunDir: join(runDir, "learning"),
    });
    expect(result.scriptsPromoted).toBe(0);
    expect(result.escalations.some((e) => e.includes("missing staged file"))).toBe(true);
  });

  it("parseProposalsFromVerdict ignores malformed handoffHint", () => {
    expect(parseProposalsFromVerdict({ step: "x", verdict: "PASS" }, [])).toEqual([]);
    expect(parseProposalsFromVerdict(undefined, [])).toEqual([]);
    expect(parseProposalsFromVerdict({ step: "x", verdict: "PASS", handoffHint: "not json" }, [])).toEqual([]);
  });

  it("buildDiff includes both active and staged file bodies", async () => {
    const active = join(env.scriptsDir, "active.py");
    const staged = join(env.stagingDir, "active.py");
    await writeFile(active, "OLD\n");
    await writeFile(staged, "NEW\n");
    const diff = await _testing.buildDiff(active, staged);
    expect(diff).toContain("OLD");
    expect(diff).toContain("NEW");
  });
});
