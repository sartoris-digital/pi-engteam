import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { rawGit } from "../../helpers/raw-git.js";
import {
  GitWorktreeProvider, parseWorktreeList, repoSlug, sanitizeSlug, worktreePathFor, WorkspaceRemoveRefusedError, WORKTREE_META_FILE,
} from "../../../src/workspace/git-provider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function setup() {
  const f = await makeFixtureRepo();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "factory-home-")));
  cleanups.push(f.cleanup, () => rm(home, { recursive: true, force: true }));
  const provider = new GitWorktreeProvider({ home, lockTimeoutMs: 10_000 });
  const req = { repoRoot: f.repo, branch: "factory/local-1-add-readme", base: "main", slug: "local-1-add-readme", lockReason: "factory:local-1" };
  return { ...f, home, provider, req };
}

describe("parseWorktreeList", () => {
  it("parses records with branch, lock reason and bare/detached/prunable flags", () => {
    const text = [
      "worktree /r", "HEAD aaaa", "branch refs/heads/main", "",
      "worktree /h/worktrees/r-1/local-1", "HEAD bbbb", "branch refs/heads/factory/local-1", "locked factory:local-1", "",
      "worktree /r/other", "HEAD cccc", "detached", "",
      "worktree /gone", "HEAD dddd", "branch refs/heads/x", "prunable gitdir file points to non-existent location", "", "",
    ].join("\n");
    expect(parseWorktreeList(text)).toEqual([
      { path: "/r", head: "aaaa", branch: "main", locked: null, bare: false, detached: false, prunable: false },
      { path: "/h/worktrees/r-1/local-1", head: "bbbb", branch: "factory/local-1", locked: "factory:local-1", bare: false, detached: false, prunable: false },
      { path: "/r/other", head: "cccc", branch: null, locked: null, bare: false, detached: true, prunable: false },
      { path: "/gone", head: "dddd", branch: "x", locked: null, bare: false, detached: false, prunable: true },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("repoSlug / sanitizeSlug / worktreePathFor", () => {
  it("builds <home>/worktrees/<repo-slug>/<slug> from sanitised names", () => {
    const slug = repoSlug("/tmp/My Repo");
    expect(slug).toMatch(/^my-repo-[0-9a-f]{8}$/);
    expect(worktreePathFor("/h", "/tmp/My Repo", "Local 1/Fix It")).toBe(`/h/worktrees/${slug}/local-1-fix-it`);
    expect(sanitizeSlug("..Evil//Path..")).toBe("evil-path");
    expect(() => sanitizeSlug("///")).toThrow(/invalid workspace slug/);
  });

  it("distinguishes same-named repos at different paths", () => {
    expect(repoSlug("/a/proj")).not.toBe(repoSlug("/b/proj"));
    expect(repoSlug("/a/proj")).toBe(repoSlug("/a/proj/"));
  });
});

describe("GitWorktreeProvider.create", () => {
  it("adds a locked worktree on a new branch from origin/<base> under <home>/worktrees/<repo-slug>/<slug>", async () => {
    const { repo, home, provider, req } = await setup();
    const ws = await provider.create(req);
    expect(ws.provider).toBe("git");
    expect(ws.path).toBe(worktreePathFor(home, repo, req.slug));
    expect(ws.branch).toBe(req.branch);
    expect(ws.repoRoot).toBe(path.resolve(repo));
    expect(ws.gitCommonDir).toBe(path.join(path.resolve(repo), ".git"));
    expect(ws.baseSha).toBe(await rawGit(repo, "rev-parse", "origin/main"));
    expect(await rawGit(ws.path, "rev-parse", "HEAD")).toBe(ws.baseSha);
    expect(await rawGit(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(req.branch);
    expect(ws.configSha).toMatch(/^[0-9a-f]{64}$/);
    expect(ws.remote).toBe("origin");
    expect(ws.remoteUrl).toBe(await rawGit(repo, "remote", "get-url", "origin"));
    const porcelain = await rawGit(repo, "worktree", "list", "--porcelain");
    expect(porcelain).toContain(`worktree ${ws.path}`);
    expect(porcelain).toContain("locked factory:local-1");
    const gitDir = await rawGit(ws.path, "rev-parse", "--git-dir");
    await expect(stat(path.join(gitDir, WORKTREE_META_FILE))).resolves.toBeTruthy();
  });

  it("reuses an existing branch whose tip is the last host commit", async () => {
    const { repo, provider, req } = await setup();
    const first = await provider.create(req);
    await writeFile(path.join(first.path, "x.txt"), "x\n");
    await rawGit(first.path, "add", "-A");
    await rawGit(first.path, "commit", "-q", "-m", "host checkpoint");
    const tip = await rawGit(first.path, "rev-parse", "HEAD");
    await rm(first.path, { recursive: true, force: true }); // simulate a lost worktree directory
    await rawGit(repo, "worktree", "prune");
    const again = await provider.create({ ...req, lastHostCommit: tip });
    expect(again.branch).toBe(req.branch);
    expect(again.path).toBe(first.path);
    expect(await rawGit(again.path, "rev-parse", "HEAD")).toBe(tip);
  });

  it("cuts <branch>-r1 from origin/<base> when the branch exists with a different tip", async () => {
    const { repo, provider, req } = await setup();
    await rawGit(repo, "branch", req.branch, "origin/main");
    const ws = await provider.create({ ...req, lastHostCommit: "0".repeat(40) });
    expect(ws.branch).toBe(`${req.branch}-r1`);
    expect(await rawGit(ws.path, "rev-parse", "HEAD")).toBe(ws.baseSha);
    expect(await rawGit(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`${req.branch}-r1`);
  });

  it("cuts <branch>-r1 when the branch exists and no lastHostCommit is known", async () => {
    const { repo, provider, req } = await setup();
    await rawGit(repo, "branch", req.branch, "origin/main");
    const ws = await provider.create(req);
    expect(ws.branch).toBe(`${req.branch}-r1`);
  });

  it("refuses when the workspace path already exists", async () => {
    const { provider, req } = await setup();
    await provider.create(req);
    await expect(provider.create({ ...req, branch: `${req.branch}-b` })).rejects.toThrow(/already exists/);
  });
});

describe("GitWorktreeProvider.remove", () => {
  it("refuses a dirty worktree unless forced, then removes it and deletes the branch", async () => {
    const { repo, provider, req } = await setup();
    const ws = await provider.create(req);
    await writeFile(path.join(ws.path, "dirty.txt"), "d\n");
    const p = provider.remove(ws, { force: false });
    await expect(p).rejects.toBeInstanceOf(WorkspaceRemoveRefusedError);
    await expect(p).rejects.toMatchObject({ code: "workspace-dirty", detail: expect.stringContaining("dirty.txt") });
    await expect(stat(ws.path)).resolves.toBeTruthy();
    await provider.remove(ws, { force: true });
    await expect(stat(ws.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await rawGit(repo, "worktree", "list", "--porcelain")).not.toContain(ws.path);
    await expect(rawGit(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${ws.branch}`)).rejects.toThrow();
  });

  it("refuses a worktree holding commits not on the remote unless forced", async () => {
    const { repo, provider, req } = await setup();
    const ws = await provider.create(req);
    await rawGit(ws.path, "commit", "-q", "--allow-empty", "-m", "local only");
    await expect(provider.remove(ws, { force: false })).rejects.toThrow(/not on origin/);
    await rawGit(ws.path, "push", "-q", "origin", `HEAD:refs/heads/${ws.branch}`);
    await provider.remove(ws, { force: false });
    expect(await rawGit(repo, "worktree", "list", "--porcelain")).not.toContain(ws.path);
  });

  it("removes a clean, pushed-nothing worktree whose HEAD is still the base", async () => {
    const { provider, req } = await setup();
    const ws = await provider.create(req);
    await provider.remove(ws, { force: false });
    await expect(stat(ws.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("GitWorktreeProvider.list", () => {
  it("lists factory worktrees with their recorded metadata and skips the main checkout and foreign worktrees", async () => {
    const { repo, provider, req } = await setup();
    const ws = await provider.create(req);
    const foreignRoot = await mkdtemp(path.join(tmpdir(), "foreign-wt-"));
    cleanups.push(() => rm(foreignRoot, { recursive: true, force: true }));
    await rawGit(repo, "worktree", "add", "-q", "-b", "not-factory", path.join(foreignRoot, "wt"), "origin/main");
    const listed = await provider.list(repo);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(ws);
  });

  it("returns [] when the repo has no factory worktrees", async () => {
    const { repo, provider } = await setup();
    expect(await provider.list(repo)).toEqual([]);
  });
});
