import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { fakeRepoCfg } from "../../helpers/fake-repo-cfg.js";
import { GitWorktreeProvider } from "../../../src/workspace/git-provider.js";
import { checkpointCommit } from "../../../src/git/checkpoint.js";
import { hostGitOk } from "../../../src/git/host-git.js";
import type { Workspace } from "../../../src/workspace/types.js";
import type { QueueEntry } from "../../../src/scheduler/queue.js";
import { afterLand, landReconcile } from "../../../src/scheduler/land-reconcile.js";
import { runRebaseCycle, type RebaseDeps } from "../../../src/scheduler/rebase-cycle.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface SiblingWorld {
  repo: string;
  home: string;
  cfg: ReturnType<typeof fakeRepoCfg>;
  landed: { ws: Workspace; sha: string; entry: QueueEntry };
  other: { ws: Workspace; sha: string; entry: QueueEntry };
}

async function twoConflictingPublished(): Promise<SiblingWorld> {
  const f = await makeFixtureRepo();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "factory-home-")));
  cleanups.push(f.cleanup, () => rm(home, { recursive: true, force: true }));
  const provider = new GitWorktreeProvider({ home, lockTimeoutMs: 10_000 });

  const make = async (slug: string, content: string, runId: string) => {
    const ws = await provider.create({
      repoRoot: f.repo,
      branch: `factory/${slug}`,
      base: "main",
      slug,
      lockReason: `factory:${slug}`,
    });
    await writeFile(path.join(ws.path, "src/index.ts"), content);
    const sha = await checkpointCommit(ws, `feat: ${slug}`, { runId });
    if (sha === null) throw new Error("checkpoint produced no commit");
    await hostGitOk(["push", "origin", `HEAD:refs/heads/${ws.branch}`], { cwd: ws.path });
    const entry: QueueEntry = {
      key: `local:${f.repo}:${slug}`,
      tracker: "local",
      repo: f.repo,
      ref: slug,
      priority: "p2",
      state: "published",
      kind: "chore",
      lane: "chore",
      runId,
      hostCommits: [sha],
      judgedSha: sha,
      baseSha: ws.baseSha,
      rebaseCount: 0,
      workspace: { provider: "git", path: ws.path, branch: ws.branch, lane: "chore" },
      enqueuedAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    return { ws, sha, entry };
  };

  const landed = await make("ado-1-slug", "export const a = 1;\n", "run-1");
  const other = await make("ado-2-slug", "export const b = 2;\n", "run-2");

  const merge = await f.git(["merge", "--no-ff", "-m", `merge ${landed.ws.branch}`, landed.ws.branch]);
  if (merge.code !== 0) throw new Error(`merge failed: ${merge.stderr}`);
  const push = await f.git(["push", "-q", "origin", "main"]);
  if (push.code !== 0) throw new Error(`push failed: ${push.stderr}`);

  return { repo: f.repo, home, cfg: fakeRepoCfg({ repoRoot: f.repo, remote: "origin" }), landed, other };
}

function rebaseDeps(home: string, over: Partial<RebaseDeps> = {}): RebaseDeps {
  return {
    home,
    resolve: async (ws) => {
      await writeFile(path.join(ws.path, "src/index.ts"), "export const resolved = true;\n");
      await hostGitOk(["add", "src/index.ts"], { cwd: ws.path });
      return { ok: true };
    },
    checks: async () => ({ ok: true }),
    review: async () => ({ ok: true }),
    judge: async () => ({ ok: true, judgedSha: "e".repeat(40) }),
    publish: async () => ({ ok: true }),
    ...over,
  };
}

describe("scheduler landReconcile", () => {
  it("marks a merge on origin/main as a git ancestor landing", async () => {
    const world = await twoConflictingPublished();
    const out = await landReconcile(world.landed.entry, {
      cwd: world.repo,
      base: "main",
      abandonDays: 7,
      others: [world.landed.entry, world.other.entry],
      autoRebase: false,
    });
    expect(out.state).toBe("landed");
    expect(out.landedAs).toBe("clean");
    expect(out.landedBy).toBe("git");
  });

  it("marks a conflicting sibling needs-rebase, labels it, and cuts -r1 when autoRebase", async () => {
    const world = await twoConflictingPublished();
    const original = await hostGitOk(["rev-parse", world.other.ws.branch], { cwd: world.other.ws.path });
    const labels: string[] = [];
    const comments: string[] = [];
    const out = await landReconcile(world.landed.entry, {
      cwd: world.repo,
      base: "main",
      abandonDays: 7,
      others: [world.landed.entry, world.other.entry],
      autoRebase: true,
      cfg: world.cfg,
      workspaceOf: (e) => (e.runId === "run-2" ? world.other.ws : world.landed.ws),
      rebaseDeps: rebaseDeps(world.home),
      adapter: {
        addLabel: async (_ref, label) => {
          labels.push(label);
        },
        comment: async (_ref, body) => {
          comments.push(body);
          return "c1";
        },
      },
    });
    expect(out.state).toBe("landed");
    expect(world.other.entry.workspace?.branch).toBe("factory/ado-2-slug-r1");
    expect(world.other.entry.rebaseCount).toBe(1);
    expect(await hostGitOk(["rev-parse", "factory/ado-2-slug"], { cwd: world.repo })).toBe(original);
    expect(labels).toContain("factory:needs-rebase");
    expect(comments.length).toBeGreaterThan(0);
  });

  it("leaves the sibling in needs-rebase when autoRebase is false", async () => {
    const world = await twoConflictingPublished();
    const labels: string[] = [];
    await landReconcile(world.landed.entry, {
      cwd: world.repo,
      base: "main",
      abandonDays: 7,
      others: [world.landed.entry, world.other.entry],
      autoRebase: false,
      adapter: {
        addLabel: async (_ref, label) => {
          labels.push(label);
        },
        comment: async () => "c1",
      },
    });
    expect(world.other.entry.state).toBe("needs-rebase");
    expect(world.other.entry.waitingOn).toBe("rebase");
    expect(world.other.entry.workspace?.branch).toBe("factory/ado-2-slug");
    expect(labels).toContain("factory:needs-rebase");
    const missing = await hostGitOk(["rev-parse", "--verify", "--quiet", "factory/ado-2-slug-r1"], { cwd: world.repo }).catch(() => "");
    expect(missing).toBe("");
  });

  it("returns rebase-conflict once rebaseMaxCycles is exhausted", async () => {
    const world = await twoConflictingPublished();
    world.other.entry.rebaseCount = 2;
    await landReconcile(world.landed.entry, {
      cwd: world.repo,
      base: "main",
      abandonDays: 7,
      others: [world.landed.entry, world.other.entry],
      autoRebase: true,
      rebaseMaxCycles: 2,
      cfg: world.cfg,
      workspaceOf: (e) => (e.runId === "run-2" ? world.other.ws : world.landed.ws),
      rebaseDeps: rebaseDeps(world.home),
    });
    expect(world.other.entry.escalations?.some((e) => e.code === "rebase-conflict")).toBe(true);
    expect(world.other.entry.workspace?.branch).toBe("factory/ado-2-slug");
  });

  it("is a seam over git landReconcile and does not rewrite it", async () => {
    const src = await readFile(fileURLToPath(new URL("../../../src/scheduler/land-reconcile.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/from ["'].*git\/reconcile\.js["']/);
    expect(src).not.toMatch(/merge-base --is-ancestor/);
    expect(src).not.toMatch(/prHint/);
    expect(typeof afterLand).toBe("function");
    expect(typeof runRebaseCycle).toBe("function");
  });
});
