import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { fakeRepoCfg } from "../../helpers/fake-repo-cfg.js";
import { rawGit } from "../../helpers/raw-git.js";
import { GitWorktreeProvider } from "../../../src/workspace/git-provider.js";
import { checkpointCommit } from "../../../src/git/checkpoint.js";
import { hostGit, hostGitOk } from "../../../src/git/host-git.js";
import type { Workspace } from "../../../src/workspace/types.js";
import type { QueueEntry } from "../../../src/scheduler/queue.js";
import {
  nextRebaseBranch,
  runRebaseCycle,
  type RebaseDeps,
} from "../../../src/scheduler/rebase-cycle.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function factoryHome(): Promise<string> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "factory-home-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function lane(opts: {
  content: string;
  branch: string;
  slug: string;
  runId: string;
}): Promise<{
  repo: string;
  home: string;
  ws: Workspace;
  sha: string;
  cfg: ReturnType<typeof fakeRepoCfg>;
  entry: QueueEntry;
}> {
  const f = await makeFixtureRepo();
  const home = await factoryHome();
  cleanups.push(f.cleanup);
  const provider = new GitWorktreeProvider({ home, lockTimeoutMs: 10_000 });
  const ws = await provider.create({
    repoRoot: f.repo,
    branch: opts.branch,
    base: "main",
    slug: opts.slug,
    lockReason: `factory:${opts.slug}`,
  });
  await writeFile(path.join(ws.path, "src/index.ts"), opts.content);
  const sha = await checkpointCommit(ws, `feat: ${opts.slug}`, { runId: opts.runId });
  if (sha === null) throw new Error("checkpoint produced no commit");
  await hostGitOk(["push", "origin", `HEAD:refs/heads/${ws.branch}`], { cwd: ws.path });
  const cfg = fakeRepoCfg({ repoRoot: f.repo, remote: "origin" });
  const entry: QueueEntry = {
    key: `local:${f.repo}:${opts.slug}`,
    tracker: "local",
    repo: f.repo,
    ref: opts.slug,
    priority: "p2",
    state: "published",
    kind: "chore",
    lane: "chore",
    runId: opts.runId,
    hostCommits: [sha],
    judgedSha: sha,
    baseSha: ws.baseSha,
    rebaseCount: 0,
    workspace: { provider: "git", path: ws.path, branch: ws.branch, lane: "chore" },
    enqueuedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  return { repo: f.repo, home, ws, sha, cfg, entry };
}

function recordingDeps(home: string, over: Partial<RebaseDeps> = {}): RebaseDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    home,
    calls,
    checks: async () => {
      calls.push("checks");
      return { ok: true };
    },
    review: async () => {
      calls.push("review");
      return { ok: true };
    },
    judge: async () => {
      calls.push("judge");
      return { ok: true, judgedSha: "d".repeat(40) };
    },
    publish: async (opts) => {
      calls.push(`publish:${opts.branch}`);
      return { ok: true };
    },
    ...over,
  };
}

describe("nextRebaseBranch", () => {
  it("suffixes -r<n> and increments an existing -rN", () => {
    expect(nextRebaseBranch("factory/ado-42-slug", 1)).toBe("factory/ado-42-slug-r1");
    expect(nextRebaseBranch("factory/ado-42-slug-r1", 2)).toBe("factory/ado-42-slug-r2");
    expect(nextRebaseBranch("factory/ado-42-slug-r1", 1)).toBe("factory/ado-42-slug-r2");
  });
});

describe("runRebaseCycle", () => {
  it("cuts a new -r1 branch and leaves the open PR branch untouched", async () => {
    const { home, ws, sha, cfg, entry } = await lane({
      content: "export const a = 1;\n",
      branch: "factory/ado-42-slug",
      slug: "ado-42-slug",
      runId: "run-a",
    });
    const original = await hostGitOk(["rev-parse", ws.branch], { cwd: ws.path });
    const deps = recordingDeps(home);
    const out = await runRebaseCycle(
      {
        entry: { key: entry.key, runId: "run-a", branch: ws.branch, repo: entry.repo, ref: entry.ref, hostCommits: [sha] },
        ws,
        cfg,
        nameTemplate: cfg.branching.nameTemplate,
        rebaseCount: 0,
      },
      deps,
    );
    expect(out).toEqual({ ok: true, branch: "factory/ado-42-slug-r1" });
    expect(await hostGitOk(["rev-parse", ws.branch], { cwd: ws.path })).toBe(original);
    expect(await hostGitOk(["rev-parse", "--verify", "factory/ado-42-slug-r1"], { cwd: ws.path })).toMatch(/^[0-9a-f]{40}$/);
    expect(deps.calls).toEqual(["checks", "review", "judge", "publish:factory/ado-42-slug-r1"]);
    expect(deps.calls.join(" ")).not.toMatch(/force/);
  });

  it("returns human-owned when the old branch has foreign commits and does not cut -r1", async () => {
    const { home, ws, sha, cfg, entry } = await lane({
      content: "export const a = 1;\n",
      branch: "factory/ado-42-slug",
      slug: "ado-42-slug",
      runId: "run-a",
    });
    await writeFile(path.join(ws.path, "src/index.ts"), "export const a = 1;\nexport const extra = true;\n");
    await rawGit(ws.path, "add", "src/index.ts");
    await rawGit(ws.path, "commit", "-q", "-m", "wip: human edit");
    const original = await hostGitOk(["rev-parse", ws.branch], { cwd: ws.path });
    const deps = recordingDeps(home);
    const out = await runRebaseCycle(
      {
        entry: { key: entry.key, runId: "run-a", branch: ws.branch, repo: entry.repo, ref: entry.ref, hostCommits: [sha] },
        ws,
        cfg,
        nameTemplate: cfg.branching.nameTemplate,
        rebaseCount: 0,
      },
      deps,
    );
    expect(out).toEqual({ ok: false, code: "human-owned" });
    expect(await hostGitOk(["rev-parse", ws.branch], { cwd: ws.path })).toBe(original);
    const missing = await hostGit(["rev-parse", "--verify", "--quiet", "factory/ado-42-slug-r1"], { cwd: ws.path });
    expect(missing.stdout.trim()).toBe("");
    expect(deps.calls).toEqual([]);
  });

  it("returns rebase-conflict when rebaseMaxCycles is exhausted", async () => {
    const { home, ws, sha, cfg, entry } = await lane({
      content: "export const a = 1;\n",
      branch: "factory/ado-42-slug",
      slug: "ado-42-slug",
      runId: "run-a",
    });
    const original = await hostGitOk(["rev-parse", ws.branch], { cwd: ws.path });
    const out = await runRebaseCycle(
      {
        entry: { key: entry.key, runId: "run-a", branch: ws.branch, repo: entry.repo, ref: entry.ref, hostCommits: [sha] },
        ws,
        cfg,
        nameTemplate: cfg.branching.nameTemplate,
        rebaseCount: 2,
      },
      recordingDeps(home, { rebaseMaxCycles: 2 }),
    );
    expect(out).toEqual({ ok: false, code: "rebase-conflict" });
    expect(await hostGitOk(["rev-parse", ws.branch], { cwd: ws.path })).toBe(original);
  });

  it("resolves one conflict then rebase-conflict on a second failure", async () => {
    const { home, ws, sha, cfg, entry, repo } = await lane({
      content: "export const feature = 'lane';\n",
      branch: "factory/ado-42-slug",
      slug: "ado-42-slug",
      runId: "run-a",
    });
    await writeFile(path.join(repo, "src/index.ts"), "export const feature = 'base';\n");
    await rawGit(repo, "add", "src/index.ts");
    await rawGit(repo, "commit", "-q", "-m", "feat: move base");
    await rawGit(repo, "push", "-q", "origin", "main");

    let resolveCalls = 0;
    const deps = recordingDeps(home, {
      resolve: async () => {
        resolveCalls += 1;
        return { ok: false };
      },
    });
    const out = await runRebaseCycle(
      {
        entry: { key: entry.key, runId: "run-a", branch: ws.branch, repo: entry.repo, ref: entry.ref, hostCommits: [sha] },
        ws,
        cfg,
        nameTemplate: cfg.branching.nameTemplate,
        rebaseCount: 0,
      },
      deps,
    );
    expect(out).toEqual({ ok: false, code: "rebase-conflict" });
    expect(resolveCalls).toBe(1);
    expect(deps.calls).toEqual([]);
  });

  it("never force-pushes, never merges, and never rebases the open PR branch in place", async () => {
    const src = await readFile(fileURLToPath(new URL("../../../src/scheduler/rebase-cycle.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/--force/);
    expect(src).not.toMatch(/force-with-lease/);
    expect(src).not.toMatch(/\bprHint\b/);
    expect(src).not.toMatch(/\["merge"/);
  });
});
