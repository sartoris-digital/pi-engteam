import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LAUNCHER_SCRIPT, installLauncher, renderLauncherScript } from "../../../src/runtime/launcher.js";

const execFileAsync = promisify(execFile);

describe("launcher shim", () => {
  let root: string;
  let home: string;
  let runsDir: string;
  let fakePi: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sdlc-launcher-"));
    home = join(root, "home");
    runsDir = join(root, "runs");
    await mkdir(join(runsDir, "run-1"), { recursive: true });
    fakePi = join(root, "fake-pi");
    await writeFile(fakePi, '#!/bin/sh\nenv | sort\necho "ARGS:$*"\n');
    await chmod(fakePi, 0o755);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function workerEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GITHUB_TOKEN: "ghp_leak",
      GH_TOKEN: "gho_leak",
      AWS_SECRET_ACCESS_KEY: "aws-leak",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      ANTHROPIC_API_KEY: "sk-ant-ok",
      PI_SDLC_AGENT_MODE: "1",
      PI_SDLC_RUN_ID: "run-1",
      PI_SDLC_RUNS_DIR: runsDir,
      PI_SDLC_STEP: "implement",
      PI_SDLC_REAL_PI: fakePi,
      ...extra,
    };
  }

  it("installs <home>/bin/pi as an executable bash script", async () => {
    const path = await installLauncher(home);
    expect(path).toBe(join(home, "bin", "pi"));
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    const text = await readFile(path, "utf8");
    expect(text).toBe(LAUNCHER_SCRIPT);
    expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(text).toContain("exec env -i");
    expect(text).toContain('sandbox-exec -f "$run_dir/sandbox.sb"');
    expect(text).toContain("compgen -A variable PI_SDLC_");
    expect(text).toContain("for v in PATH HOME USER LANG TERM TMPDIR ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do");
    expect(text).toContain('"GIT_CONFIG_NOSYSTEM=1"');
    expect(text).toContain('"NPM_CONFIG_USERCONFIG=/dev/null"');
    expect(text).not.toContain("GITHUB_TOKEN");
  });

  it("re-installs over an existing file and keeps the mode", async () => {
    const path = await installLauncher(home);
    await chmod(path, 0o644);
    await installLauncher(home, { providerKeys: ["OPENAI_API_KEY"] });
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect(await readFile(path, "utf8")).toContain("for v in PATH HOME USER LANG TERM TMPDIR OPENAI_API_KEY; do");
  });

  it("rejects provider key names that are not environment identifiers", () => {
    expect(() => renderLauncherScript(["BAD KEY"])).toThrow(/not a valid environment variable name/);
    expect(() => renderLauncherScript(["x; rm -rf /"])).toThrow(/not a valid environment variable name/);
  });

  it("execs the real pi under env -i with only the allowlist and PI_SDLC_* variables", async () => {
    const launcher = await installLauncher(home);
    await writeFile(join(runsDir, "run-1", "sandbox.off"), "");
    const { stdout } = await execFileAsync("/bin/bash", [launcher, "-p", "--no-session", "Read x and execute it."], { env: workerEnv() });
    expect(stdout).not.toContain("GITHUB_TOKEN=");
    expect(stdout).not.toContain("GH_TOKEN=");
    expect(stdout).not.toContain("AWS_SECRET_ACCESS_KEY=");
    expect(stdout).not.toContain("SSH_AUTH_SOCK=");
    expect(stdout).toContain("ANTHROPIC_API_KEY=sk-ant-ok\n");
    expect(stdout).toContain("PI_SDLC_RUN_ID=run-1\n");
    expect(stdout).toContain("PI_SDLC_STEP=implement\n");
    expect(stdout).toContain("GIT_CONFIG_NOSYSTEM=1\n");
    expect(stdout).toContain("GIT_TERMINAL_PROMPT=0\n");
    expect(stdout).toContain("GIT_ASKPASS=/usr/bin/false\n");
    expect(stdout).toContain("NPM_CONFIG_USERCONFIG=/dev/null\n");
    expect(stdout).toMatch(/GH_CONFIG_DIR=.*pi-sdlc-scrub\.[^/]+\/gh\n/);
    expect(stdout).toMatch(/GIT_CONFIG_GLOBAL=.*pi-sdlc-scrub\.[^/]+\/gitconfig\n/);
    expect(stdout).toContain("ARGS:-p --no-session Read x and execute it.\n");
  });

  it("refuses to start outside a factory run", async () => {
    const launcher = await installLauncher(home);
    await expect(execFileAsync("/bin/bash", [launcher], { env: { PATH: "/usr/bin:/bin" } })).rejects.toMatchObject({ code: 64 });
  });

  it("refuses to start when no sandbox profile has been written", async () => {
    const launcher = await installLauncher(home);
    await expect(execFileAsync("/bin/bash", [launcher], { env: workerEnv() })).rejects.toMatchObject({ code: 66 });
  });
});
