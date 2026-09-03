import { describe, it, expect, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { rawGit } from "../../helpers/raw-git.js";
import { computeConfigSha, assertNoDrift, assertHookSanity, ConfigTamperedError, hooksDirDigest, resolveGitDirs } from "../../../src/workspace/drift.js";
import type { Workspace } from "../../../src/workspace/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function fixture() {
  const f = await makeFixtureRepo();
  cleanups.push(f.cleanup);
  return f;
}

/** A linked worktree of the fixture repo in its own temp dir. */
async function linkedWorktree(repo: string, branch: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "drift-wt-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const wt = path.join(root, "wt");
  await rawGit(repo, "worktree", "add", "-q", "-b", branch, wt, "origin/main");
  return wt;
}

function wsFor(repo: string, configSha: string): Workspace {
  return { provider: "git", path: repo, branch: "main", baseSha: "", repoRoot: repo, gitCommonDir: path.join(repo, ".git"), configSha };
}

describe("resolveGitDirs", () => {
  it("returns absolute gitDir and gitCommonDir for a main checkout and a linked worktree", async () => {
    const { repo } = await fixture();
    const main = await resolveGitDirs(repo);
    expect(main.gitCommonDir).toBe(path.resolve(repo, ".git"));
    expect(main.gitDir).toBe(main.gitCommonDir);
    const wt = await linkedWorktree(repo, "dirs");
    const linked = await resolveGitDirs(wt);
    expect(path.isAbsolute(linked.gitDir)).toBe(true);
    expect(linked.gitDir).toMatch(/[\\/]\.git[\\/]worktrees[\\/]wt$/);
    expect(linked.gitDir).not.toBe(linked.gitCommonDir);
  });
});

describe("computeConfigSha", () => {
  it("is a stable 64-hex digest for an unchanged repo", async () => {
    const { repo } = await fixture();
    const a = await computeConfigSha(repo);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeConfigSha(repo)).toBe(a);
  });

  it("changes when .git/config changes", async () => {
    const { repo } = await fixture();
    const before = await computeConfigSha(repo);
    await rawGit(repo, "config", "pi.probe", "1");
    expect(await computeConfigSha(repo)).not.toBe(before);
  });

  it("changes when the origin url changes", async () => {
    const { repo, bare } = await fixture();
    const before = await computeConfigSha(repo);
    await rawGit(repo, "remote", "set-url", "origin", `${bare}-other`);
    expect(await computeConfigSha(repo)).not.toBe(before);
  });

  it("changes when a hook is added to the effective hooks dir", async () => {
    const { repo } = await fixture();
    const before = await computeConfigSha(repo);
    const hooks = path.join(repo, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(hooks, "pre-commit"), 0o755);
    expect(await computeConfigSha(repo)).not.toBe(before);
  });

  it("changes when .gitmodules appears", async () => {
    const { repo } = await fixture();
    const before = await computeConfigSha(repo);
    await writeFile(path.join(repo, ".gitmodules"), '[submodule "x"]\n\tpath = x\n\turl = ../x\n');
    expect(await computeConfigSha(repo)).not.toBe(before);
  });

  it("changes when a worktree-level config.worktree appears", async () => {
    const { repo } = await fixture();
    const wt = await linkedWorktree(repo, "wtcfg");
    const before = await computeConfigSha(wt);
    await rawGit(repo, "config", "extensions.worktreeConfig", "true");
    const afterExt = await computeConfigSha(wt);
    await rawGit(wt, "config", "--worktree", "core.hooksPath", "/tmp/evil-hooks");
    expect(afterExt).not.toBe(before);
    expect(await computeConfigSha(wt)).not.toBe(afterExt);
  });
});

describe("hooksDirDigest", () => {
  it("returns empty for a missing dir and sorted name/sha lines otherwise", async () => {
    expect(await hooksDirDigest("/nonexistent/hooks-dir")).toBe("");
    const dir = await mkdtemp(path.join(tmpdir(), "hooks-"));
    await writeFile(path.join(dir, "b"), "b");
    await writeFile(path.join(dir, "a"), "a");
    await mkdir(path.join(dir, "sub"));
    const lines = (await hooksDirDigest(dir)).split("\n");
    expect(lines.map((l) => l.split("\t")[0])).toEqual(["a", "b"]);
    expect(lines[0]).toMatch(/^a\t[0-9a-f]{64}$/);
  });
});

describe("assertNoDrift", () => {
  it("passes when the sha matches and throws ConfigTamperedError when it does not", async () => {
    const { repo } = await fixture();
    const ws = wsFor(repo, await computeConfigSha(repo));
    await expect(assertNoDrift(ws)).resolves.toBeUndefined();
    await rawGit(repo, "config", "pi.probe", "1");
    const p = assertNoDrift(ws);
    await expect(p).rejects.toBeInstanceOf(ConfigTamperedError);
    await expect(p).rejects.toMatchObject({ code: "config-tampered" });
  });
});

describe("assertHookSanity", () => {
  it("accepts a worktree whose hooksPath matches the main checkout (both unset)", async () => {
    const { repo } = await fixture();
    const wt = await linkedWorktree(repo, "sane");
    await expect(assertHookSanity(wt, repo)).resolves.toBeUndefined();
  });

  it("accepts a shared repo-level hooksPath", async () => {
    const { repo } = await fixture();
    await rawGit(repo, "config", "core.hooksPath", ".githooks");
    const wt = await linkedWorktree(repo, "shared");
    await expect(assertHookSanity(wt, repo)).resolves.toBeUndefined();
  });

  it("refuses a worktree-level core.hooksPath", async () => {
    const { repo } = await fixture();
    const wt = await linkedWorktree(repo, "evil");
    await rawGit(repo, "config", "extensions.worktreeConfig", "true");
    await rawGit(wt, "config", "--worktree", "core.hooksPath", "/tmp/evil-hooks");
    const p = assertHookSanity(wt, repo);
    await expect(p).rejects.toBeInstanceOf(ConfigTamperedError);
    await expect(p).rejects.toMatchObject({ detail: expect.stringContaining("config.worktree") });
  });
});
