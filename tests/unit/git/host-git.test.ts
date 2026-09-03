import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rawGit } from "../../helpers/raw-git.js";
import {
  buildHostGitArgv, hostGit, hostGitEnv, hostGitOk, HostGitError, HOST_GIT_CONFIG, HOST_GIT_ENV,
} from "../../../src/git/host-git.js";

async function tmpRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hostgit-"));
  await rawGit(dir, "init", "-q", "-b", "main");
  await rawGit(dir, "config", "user.name", "Fixture");
  await rawGit(dir, "config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(dir, "a.txt"), "a\n");
  await rawGit(dir, "add", "-A");
  await rawGit(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("buildHostGitArgv", () => {
  it("prefixes the hook-free config overrides", () => {
    expect(buildHostGitArgv(["status"])).toEqual([...HOST_GIT_CONFIG, "status"]);
    expect(HOST_GIT_CONFIG).toContain("core.hooksPath=/dev/null");
    expect(HOST_GIT_CONFIG).toContain("credential.helper=");
  });

  it("forces --no-verify on commit and push exactly once, never on other subcommands", () => {
    expect(buildHostGitArgv(["commit", "-m", "x"])).toEqual([...HOST_GIT_CONFIG, "commit", "--no-verify", "-m", "x"]);
    expect(buildHostGitArgv(["push", "--no-verify", "origin", "HEAD"])).toEqual([...HOST_GIT_CONFIG, "push", "--no-verify", "origin", "HEAD"]);
    expect(buildHostGitArgv(["fetch", "origin"])).not.toContain("--no-verify");
  });

  it("omits the overrides when noOverrides is set", () => {
    expect(buildHostGitArgv(["config", "core.hooksPath"], true)).toEqual(["config", "core.hooksPath"]);
  });
});

describe("hostGit", () => {
  it("returns stdout and the exit code without throwing on failure", async () => {
    const repo = await tmpRepo();
    const ok = await hostGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe("main");
    const bad = await hostGit(["rev-parse", "--verify", "--quiet", "refs/heads/nope"], { cwd: repo });
    expect(bad.code).not.toBe(0);
  });

  it("hostGitOk returns trimmed stdout and throws HostGitError carrying args and result", async () => {
    const repo = await tmpRepo();
    expect(await hostGitOk(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })).toBe("main");
    const p = hostGitOk(["rev-parse", "--verify", "--quiet", "refs/heads/nope"], { cwd: repo });
    await expect(p).rejects.toBeInstanceOf(HostGitError);
    await expect(p).rejects.toMatchObject({ args: ["rev-parse", "--verify", "--quiet", "refs/heads/nope"] });
  });

  it("does not run repo hooks on commit", async () => {
    const repo = await tmpRepo();
    const hooks = path.join(repo, "evil-hooks");
    await mkdir(hooks, { recursive: true });
    const marker = path.join(repo, "HOOK_RAN");
    await writeFile(path.join(hooks, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    await chmod(path.join(hooks, "pre-commit"), 0o755);
    await rawGit(repo, "config", "core.hooksPath", hooks);
    await writeFile(path.join(repo, "b.txt"), "b\n");
    await rawGit(repo, "add", "-A");
    const res = await hostGit(["commit", "-m", "host commit"], { cwd: repo });
    expect(res.code).toBe(0);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("masks config reads with the overrides unless noOverrides is set", async () => {
    const repo = await tmpRepo();
    await rawGit(repo, "config", "core.hooksPath", ".githooks");
    expect(await hostGitOk(["config", "core.hooksPath"], { cwd: repo })).toBe("/dev/null");
    expect(await hostGitOk(["config", "core.hooksPath"], { cwd: repo, noOverrides: true })).toBe(".githooks");
  });

  it("retries while index.lock is held and succeeds once it is gone", async () => {
    const repo = await tmpRepo();
    const lock = path.join(repo, ".git", "index.lock");
    await writeFile(lock, "");
    await writeFile(path.join(repo, "c.txt"), "c\n");
    setTimeout(() => { void unlink(lock); }, 30);
    const res = await hostGit(["add", "-A"], { cwd: repo, retryDelaysMs: [20, 20, 20, 20] });
    expect(res.code).toBe(0);
    expect(await rawGit(repo, "diff", "--cached", "--name-only")).toBe("c.txt");
  });

  it("sets GIT_TERMINAL_PROMPT=0 and GIT_CONFIG_NOSYSTEM=1 in the child environment", async () => {
    const repo = await tmpRepo();
    const res = await hostGit(["-c", "alias.printenv=!env", "printenv"], { cwd: repo });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
    expect(res.stdout).toMatch(/^GIT_CONFIG_NOSYSTEM=1$/m);
  });

  it("does not copy GIT_DIR or credential vars from the parent env or opts.env", () => {
    const env = hostGitEnv(
      { GIT_DIR: "/tmp/opts.git", GH_TOKEN: "from-opts", GITHUB_TOKEN: "gho_opts", EXTRA: "keep-me" },
      {
        PATH: "/bin",
        HOME: "/home/op",
        USER: "op",
        GIT_DIR: "/tmp/leaked.git",
        GIT_WORK_TREE: "/tmp/leaked-wt",
        GH_TOKEN: "ghp_parent",
        GITHUB_TOKEN: "gho_parent",
        JIRA_API_TOKEN: "jira",
        AZURE_DEVOPS_EXT_PAT: "ado",
        SHELL: "/bin/zsh",
      },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/op");
    expect(env.EXTRA).toBe("keep-me");
    expect(env).toMatchObject(HOST_GIT_ENV);
    for (const key of [
      "GIT_DIR", "GIT_WORK_TREE", "GH_TOKEN", "GITHUB_TOKEN", "JIRA_API_TOKEN", "AZURE_DEVOPS_EXT_PAT", "SHELL",
    ]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it("does not leak injected GIT_DIR or GH_TOKEN into the child env", async () => {
    const repo = await tmpRepo();
    const prev = { GIT_DIR: process.env.GIT_DIR, GH_TOKEN: process.env.GH_TOKEN };
    process.env.GIT_DIR = "/tmp/leaked.git";
    process.env.GH_TOKEN = "ghp_leaked";
    try {
      const res = await hostGit(["-c", "alias.printenv=!env", "printenv"], {
        cwd: repo,
        env: { GIT_DIR: "/tmp/also-leaked", GH_TOKEN: "also" },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).not.toMatch(/^GIT_DIR=/m);
      expect(res.stdout).not.toMatch(/^GH_TOKEN=/m);
      expect(res.stdout).not.toMatch(/^GITHUB_TOKEN=/m);
      expect(res.stdout).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
    } finally {
      if (prev.GIT_DIR === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev.GIT_DIR;
      if (prev.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prev.GH_TOKEN;
    }
  });
});
