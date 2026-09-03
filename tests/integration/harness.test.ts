import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stubPiPath, vitestCheckArgv, writeScenario } from "./harness.js";

const exec = promisify(execFile);

describe("stub-pi runDirFiles", () => {
  it("writes run-dir files without touching the workspace", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-sdlc-stub-"));
    const runs = join(base, "runs");
    const runDir = join(runs, "run-1");
    const ws = join(base, "ws");
    await mkdir(runDir, { recursive: true });
    await mkdir(ws, { recursive: true });
    const promptPath = join(runDir, "plan-r0.prompt.md");
    await writeFile(promptPath, "prompt\n", "utf8");
    const scenarioPath = await writeScenario(base, {
      plan: {
        verdict: "PASS",
        runDirFiles: { "plan.md": "## Goal\nno behaviour change\n" },
      },
    });

    await exec(process.execPath, [stubPiPath(), "-p", promptPath], {
      env: {
        ...process.env,
        PI_SDLC_AGENT_MODE: "1",
        PI_SDLC_RUN_ID: "run-1",
        PI_SDLC_RUNS_DIR: runs,
        PI_SDLC_STEP: "plan",
        PI_SDLC_WORKSPACE_DIR: ws,
        PI_SDLC_VERDICT_FILE: join(runDir, "verdict.json"),
        PI_SDLC_STUB_SCENARIO: scenarioPath,
      },
    });

    await expect(readFile(join(runDir, "plan.md"), "utf8")).resolves.toContain("## Goal");
    await expect(stat(join(ws, "plan.md"))).rejects.toThrow();
    const verdict = JSON.parse(await readFile(join(runDir, "verdict.json"), "utf8")) as {
      step: string;
      verdict: string;
    };
    expect(verdict).toMatchObject({ step: "plan", verdict: "PASS" });
  });

  it("still writes workspace files from the files map", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-sdlc-stub-"));
    const runs = join(base, "runs");
    const runDir = join(runs, "run-2");
    const ws = join(base, "ws");
    await mkdir(runDir, { recursive: true });
    await mkdir(ws, { recursive: true });
    const promptPath = join(runDir, "implement-r0.prompt.md");
    await writeFile(promptPath, "prompt\n", "utf8");
    const scenarioPath = await writeScenario(base, {
      implement: { verdict: "PASS", files: { "src/added.ts": "export const x = 1;\n" } },
    });

    await exec(process.execPath, [stubPiPath(), "-p", promptPath], {
      env: {
        ...process.env,
        PI_SDLC_AGENT_MODE: "1",
        PI_SDLC_RUN_ID: "run-2",
        PI_SDLC_RUNS_DIR: runs,
        PI_SDLC_STEP: "implement",
        PI_SDLC_WORKSPACE_DIR: ws,
        PI_SDLC_VERDICT_FILE: join(runDir, "verdict.json"),
        PI_SDLC_STUB_SCENARIO: scenarioPath,
      },
    });

    await expect(readFile(join(ws, "src", "added.ts"), "utf8")).resolves.toContain("export const x");
  });
});

describe("vitestCheckArgv", () => {
  it("points at a resolvable vitest CLI and requests junit output", () => {
    const argv = vitestCheckArgv("reports/junit.xml");
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toMatch(/vitest/);
    expect(argv).toContain("run");
    expect(argv).toContain("--globals");
    expect(argv).toContain("--reporter=junit");
    expect(argv).toContain("--outputFile=reports/junit.xml");
  });
});
