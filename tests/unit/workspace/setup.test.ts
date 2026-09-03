import { describe, it, expect } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeRepoCfg } from "../../helpers/fake-repo-cfg.js";
import { setupArgv, runSetupCommand, EnvSetupFailedError } from "../../../src/workspace/setup.js";
import type { Workspace } from "../../../src/workspace/types.js";

const node = process.execPath;

/** The setup runner only needs a cwd and a lockable gitCommonDir; no git repo is required. */
async function fakeWs(): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "setup-"));
  return { provider: "git", path: dir, branch: "b", baseSha: "", repoRoot: dir, gitCommonDir: dir, configSha: "" };
}

describe("setupArgv", () => {
  it("returns null when no setupCommand is configured", () => {
    expect(setupArgv(fakeRepoCfg())).toBeNull();
    expect(setupArgv(fakeRepoCfg({ setupCommand: [] }))).toBeNull();
  });

  it("appends --ignore-scripts for npm/pnpm unless allowInstallScripts", () => {
    expect(setupArgv(fakeRepoCfg({ setupCommand: ["pnpm", "install", "--frozen-lockfile"] }))).toEqual(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]);
    expect(setupArgv(fakeRepoCfg({ setupCommand: ["npm", "ci"] }))).toEqual(["npm", "ci", "--ignore-scripts"]);
    expect(setupArgv(fakeRepoCfg({ setupCommand: ["npm", "ci", "--ignore-scripts"] }))).toEqual(["npm", "ci", "--ignore-scripts"]);
    expect(setupArgv(fakeRepoCfg({ setupCommand: ["pnpm", "install"], allowInstallScripts: true }))).toEqual(["pnpm", "install"]);
    expect(setupArgv(fakeRepoCfg({ setupCommand: ["uv", "sync"] }))).toEqual(["uv", "sync"]);
  });

  it("does not mutate the configured array", () => {
    const cfg = fakeRepoCfg({ setupCommand: ["npm", "ci"] });
    setupArgv(cfg);
    expect(cfg.setupCommand).toEqual(["npm", "ci"]);
  });
});

describe("runSetupCommand", () => {
  it("reports ran:false when nothing is configured", async () => {
    const res = await runSetupCommand(await fakeWs(), fakeRepoCfg(), { timeoutMs: 1000 });
    expect(res).toEqual({ ran: false, argv: [], code: 0, signal: null, timedOut: false, durationMs: 0, outputTail: "" });
  });

  it("runs the command in the workspace dir and captures the output tail", async () => {
    const ws = await fakeWs();
    const cfg = fakeRepoCfg({ setupCommand: [node, "-e", "console.log('cwd=' + process.cwd()); console.error('warn')"] });
    const res = await runSetupCommand(ws, cfg, { timeoutMs: 5000 });
    expect(res.ran).toBe(true);
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.outputTail).toContain(`cwd=${await realpath(ws.path)}`);
    expect(res.outputTail).toContain("warn");
  });

  it("passes extra env through", async () => {
    const cfg = fakeRepoCfg({ setupCommand: [node, "-e", "console.log(process.env.PI_SDLC_TEST_VAR)"] });
    const res = await runSetupCommand(await fakeWs(), cfg, { timeoutMs: 5000, env: { PI_SDLC_TEST_VAR: "yes" } });
    expect(res.outputTail).toContain("yes");
  });

  it("throws EnvSetupFailedError on non-zero exit, carrying the result", async () => {
    const cfg = fakeRepoCfg({ setupCommand: [node, "-e", "console.error('nope'); process.exit(3)"] });
    const p = runSetupCommand(await fakeWs(), cfg, { timeoutMs: 5000 });
    await expect(p).rejects.toBeInstanceOf(EnvSetupFailedError);
    await expect(p).rejects.toMatchObject({ code: "env-setup-failed", result: { code: 3, outputTail: expect.stringContaining("nope") } });
  });

  it("kills the command and throws on timeout", async () => {
    const cfg = fakeRepoCfg({ setupCommand: [node, "-e", "setTimeout(() => {}, 20000)"] });
    const p = runSetupCommand(await fakeWs(), cfg, { timeoutMs: 200 });
    await expect(p).rejects.toMatchObject({ code: "env-setup-failed", result: { timedOut: true } });
  });

  it("throws EnvSetupFailedError when the binary does not exist", async () => {
    const cfg = fakeRepoCfg({ setupCommand: ["/nonexistent/bin/definitely-missing", "install"] });
    const p = runSetupCommand(await fakeWs(), cfg, { timeoutMs: 1000 });
    await expect(p).rejects.toBeInstanceOf(EnvSetupFailedError);
    await expect(p).rejects.toMatchObject({ detail: expect.stringContaining("ENOENT") });
  });

  it("does not leak injected GIT_DIR or GH_TOKEN into the child env", async () => {
    const cfg = fakeRepoCfg({
      setupCommand: [
        node,
        "-e",
        [
          "console.log('GIT_DIR=' + (process.env.GIT_DIR ?? ''))",
          "console.log('GH_TOKEN=' + (process.env.GH_TOKEN ?? ''))",
          "console.log('GITHUB_TOKEN=' + (process.env.GITHUB_TOKEN ?? ''))",
          "console.log('CI=' + process.env.CI)",
          "console.log('GIT_TERMINAL_PROMPT=' + process.env.GIT_TERMINAL_PROMPT)",
        ].join(";"),
      ],
    });
    const prev = { GIT_DIR: process.env.GIT_DIR, GH_TOKEN: process.env.GH_TOKEN };
    process.env.GIT_DIR = "/tmp/leaked.git";
    process.env.GH_TOKEN = "ghp_leaked";
    try {
      const res = await runSetupCommand(await fakeWs(), cfg, {
        timeoutMs: 5000,
        env: { GIT_DIR: "from-opts", GH_TOKEN: "from-opts" },
      });
      expect(res.code).toBe(0);
      expect(res.outputTail).toMatch(/^GIT_DIR=$/m);
      expect(res.outputTail).toMatch(/^GH_TOKEN=$/m);
      expect(res.outputTail).toMatch(/^GITHUB_TOKEN=$/m);
      expect(res.outputTail).toMatch(/^CI=1$/m);
      expect(res.outputTail).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
    } finally {
      if (prev.GIT_DIR === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev.GIT_DIR;
      if (prev.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prev.GH_TOKEN;
    }
  });
});
