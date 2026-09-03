import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { EffectiveRepoConfig } from "../config/schema.js";
import { hostGit, hostGitOk } from "../git/host-git.js";
import { withRepoLock } from "../workspace/lock.js";
import { sanitizeSlug, worktreePathFor } from "../workspace/git-provider.js";
import type { Workspace } from "../workspace/types.js";

export interface RebaseCycleEntry {
  key: string;
  runId: string;
  branch: string;
  repo: string;
  ref: string;
  hostCommits?: string[];
  judgedSha?: string;
  tracker?: string;
}

export interface RebaseCycleInput {
  entry: RebaseCycleEntry;
  ws: Workspace;
  cfg: EffectiveRepoConfig;
  nameTemplate: string;
  rebaseCount: number;
}

export interface RebasePublishOpts {
  branch: string;
  judgedSha: string;
  ws: Workspace;
}

export interface RebaseDeps {
  home: string;
  now?: () => Date;
  rebaseMaxCycles?: number;
  resolve?: (ws: Workspace) => Promise<{ ok: boolean }>;
  checks?: (ws: Workspace) => Promise<{ ok: boolean }>;
  review?: (ws: Workspace) => Promise<{ ok: boolean }>;
  judge?: (ws: Workspace) => Promise<{ ok: boolean; judgedSha?: string }>;
  publish?: (opts: RebasePublishOpts) => Promise<{ ok: boolean }>;
  emit?: (event: { type: string; data?: Record<string, unknown> }) => void;
}

export type RebaseCycleResult =
  | { ok: true; branch: string }
  | { ok: false; code: "rebase-conflict" | "human-owned" };

const REBASE_ENV: Record<string, string> = {
  GIT_EDITOR: "true",
  EDITOR: "true",
  GIT_AUTHOR_NAME: "Factory",
  GIT_AUTHOR_EMAIL: "factory@localhost",
  GIT_COMMITTER_NAME: "Factory",
  GIT_COMMITTER_EMAIL: "factory@localhost",
};

/** Suffix `-r<n>`. If `branch` already ends in `-rN`, increment rather than appending. */
export function nextRebaseBranch(branch: string, n: number): string {
  const m = /^(.*)-r(\d+)$/.exec(branch);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const current = Number(m[2]);
    const next = Math.max(current + 1, n);
    return `${m[1]}-r${next}`;
  }
  return `${branch}-r${n}`;
}

async function hasForeignCommits(cwd: string, baseRef: string, hostCommits: readonly string[]): Promise<boolean> {
  const listed = await hostGitOk(["rev-list", "--reverse", `${baseRef}..HEAD`], { cwd }).catch(() => "");
  const commits = listed === "" ? [] : listed.split("\n");
  const host = new Set(hostCommits);
  return commits.some((c) => !host.has(c));
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function rebaseInProgress(cwd: string): Promise<boolean> {
  const gitDirRaw = await hostGitOk(["rev-parse", "--git-dir"], { cwd });
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(cwd, gitDirRaw);
  return (await exists(join(gitDir, "rebase-merge"))) || (await exists(join(gitDir, "rebase-apply")));
}

/**
 * Cut a new `-r<n>` branch from the current factory branch onto updated origin/<base>.
 * Never rebases the open-PR branch in place, never force-pushes, never merges.
 */
export async function runRebaseCycle(input: RebaseCycleInput, deps: RebaseDeps): Promise<RebaseCycleResult> {
  const max = deps.rebaseMaxCycles ?? 2;
  if (input.rebaseCount >= max) return { ok: false, code: "rebase-conflict" };

  const remote = input.ws.remote ?? input.cfg.remote ?? "origin";
  const base = input.cfg.branching.base;
  const baseRef = `${remote}/${base}`;
  const cwd = input.ws.path;

  await hostGit(["fetch", "--no-tags", remote, base], { cwd });
  if (await hasForeignCommits(cwd, baseRef, input.entry.hostCommits ?? [])) {
    return { ok: false, code: "human-owned" };
  }

  const n = input.rebaseCount + 1;
  const newBranch = nextRebaseBranch(input.entry.branch, n);
  const dest = worktreePathFor(deps.home, input.ws.repoRoot, sanitizeSlug(newBranch));

  const cut = await withRepoLock(input.ws.gitCommonDir, async (): Promise<RebaseCycleResult | Workspace> => {
    await mkdir(dirname(dest), { recursive: true });
    const add = await hostGit(["worktree", "add", "-b", newBranch, dest, input.entry.branch], {
      cwd: input.ws.repoRoot,
    });
    if (add.code !== 0) return { ok: false, code: "rebase-conflict" };
    await hostGit(["worktree", "lock", "--reason", `factory:rebase:${input.entry.ref}`, dest], {
      cwd: input.ws.repoRoot,
    });
    const newWs: Workspace = { ...input.ws, path: dest, branch: newBranch };
    await hostGit(["fetch", "--no-tags", remote, base], { cwd: dest });
    const rb = await hostGit(["rebase", baseRef], { cwd: dest, env: REBASE_ENV });
    if (rb.code !== 0) {
      const resolved = deps.resolve !== undefined ? await deps.resolve(newWs) : { ok: false };
      if (!resolved.ok) {
        await hostGit(["rebase", "--abort"], { cwd: dest, env: REBASE_ENV });
        return { ok: false, code: "rebase-conflict" };
      }
      if (await rebaseInProgress(dest)) {
        const cont = await hostGit(["-c", "core.editor=true", "rebase", "--continue"], { cwd: dest, env: REBASE_ENV });
        if (cont.code !== 0) {
          await hostGit(["rebase", "--abort"], { cwd: dest, env: REBASE_ENV });
          return { ok: false, code: "rebase-conflict" };
        }
      }
    }
    return newWs;
  }, { timeoutMs: 120_000 });

  if (!("path" in cut)) return cut;

  const checks = deps.checks !== undefined ? await deps.checks(cut) : { ok: true };
  if (!checks.ok) return { ok: false, code: "rebase-conflict" };
  const review = deps.review !== undefined ? await deps.review(cut) : { ok: true };
  if (!review.ok) return { ok: false, code: "rebase-conflict" };
  const judged = deps.judge !== undefined ? await deps.judge(cut) : { ok: true as const };
  if (!judged.ok) return { ok: false, code: "rebase-conflict" };
  const judgedSha = judged.judgedSha ?? (await hostGitOk(["rev-parse", "HEAD"], { cwd: dest }));
  if (deps.publish !== undefined) {
    const pub = await deps.publish({ branch: newBranch, judgedSha, ws: cut });
    if (!pub.ok) return { ok: false, code: "rebase-conflict" };
  }
  deps.emit?.({ type: "factory.needs-rebase", data: { ref: input.entry.ref, branch: newBranch } });
  return { ok: true, branch: newBranch };
}
