// src/workspace/git-provider.ts — the `git` workspace provider (spec §5.4 row "git", §5.13 cleanup rules).
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { factoryHome } from "../home.js";
import { hostGit, hostGitOk } from "../git/host-git.js";
import { assertHookSanity, computeConfigSha, resolveGitDirs } from "./drift.js";
import { withRepoLock } from "./lock.js";
import type { CreateWorkspaceRequest, Workspace, WorkspaceProvider } from "./types.js";

/** Host-owned metadata written into the worktree's private git dir so list() can rebuild a Workspace. */
export const WORKTREE_META_FILE = "pi-sdlc-factory.json";

export class WorkspaceRemoveRefusedError extends Error {
  readonly code = "workspace-dirty" as const;
  constructor(readonly detail: string) {
    super(`workspace remove refused: ${detail}`);
    this.name = "WorkspaceRemoveRefusedError";
  }
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  locked: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

/** Parses `git worktree list --porcelain` (records separated by blank lines). */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      cur = { path: value, head: "", branch: null, locked: null, bare: false, detached: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (key === "HEAD") cur.head = value;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "locked") cur.locked = value;
    else if (key === "bare") cur.bare = true;
    else if (key === "detached") cur.detached = true;
    else if (key === "prunable") cur.prunable = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

/** `<basename lowercased, [^a-z0-9._-] → "-">-<sha256(absolute path)[0:8]>`: readable and collision-free. */
export function repoSlug(repoRoot: string): string {
  const abs = path.resolve(repoRoot);
  const base = path.basename(abs).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `${base}-${createHash("sha256").update(abs).digest("hex").slice(0, 8)}`;
}

export function sanitizeSlug(slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64);
  if (s === "") throw new Error(`invalid workspace slug: ${JSON.stringify(slug)}`);
  return s;
}

export function worktreePathFor(home: string, repoRoot: string, slug: string): string {
  return path.join(home, "worktrees", repoSlug(repoRoot), sanitizeSlug(slug));
}

interface WorktreeMeta {
  branch: string;
  baseSha: string;
  remote: string;
  remoteUrl: string;
  lockReason: string;
  createdAt: string;
  /** Claim-time fingerprint; list() returns this rather than recomputing (branch tracking lines in .git/config change). */
  configSha: string;
}

export interface GitWorktreeProviderOptions {
  home?: string;
  lockTimeoutMs?: number;
  /** Override for operator.worktreeRoot; defaults to `<home>/worktrees` (D12). */
  worktreeRoot?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function branchTip(repoRoot: string, branch: string): Promise<string | null> {
  const res = await hostGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot });
  return res.code === 0 ? res.stdout.trim() : null;
}

export class GitWorktreeProvider implements WorkspaceProvider {
  private readonly home: string;
  private readonly lockTimeoutMs: number;
  private readonly worktreeRoot: string;

  constructor(opts: GitWorktreeProviderOptions = {}) {
    this.home = opts.home ?? factoryHome();
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 120_000;
    this.worktreeRoot = opts.worktreeRoot ?? path.join(this.home, "worktrees");
  }

  async create(req: CreateWorkspaceRequest): Promise<Workspace> {
    const remote = req.remote ?? "origin";
    const repoRoot = path.resolve(req.repoRoot);
    const { gitCommonDir } = await resolveGitDirs(repoRoot);
    const wsPath = path.join(this.worktreeRoot, repoSlug(repoRoot), sanitizeSlug(req.slug));
    return withRepoLock(gitCommonDir, async () => {
      await hostGitOk(["fetch", "--no-tags", remote, req.base], { cwd: repoRoot });
      await hostGitOk(["worktree", "prune"], { cwd: repoRoot });
      if (await exists(wsPath)) throw new Error(`workspace path already exists: ${wsPath}`);
      // Locked worktrees whose directory vanished are not pruned; unlock so the path can be reused.
      const lingering = parseWorktreeList(await hostGitOk(["worktree", "list", "--porcelain"], { cwd: repoRoot }))
        .some((e) => e.path === wsPath);
      if (lingering) {
        await hostGit(["worktree", "unlock", wsPath], { cwd: repoRoot });
        await hostGitOk(["worktree", "prune"], { cwd: repoRoot });
      }
      const baseRef = `${remote}/${req.base}`;
      const baseSha = await hostGitOk(["rev-parse", "--verify", baseRef], { cwd: repoRoot });
      const remoteUrl = await hostGitOk(["remote", "get-url", remote], { cwd: repoRoot });
      const branch = await this.chooseBranch(repoRoot, req);
      await mkdir(path.dirname(wsPath), { recursive: true });
      const reuse = (await branchTip(repoRoot, branch)) !== null;
      const addArgs = reuse ? ["worktree", "add", wsPath, branch] : ["worktree", "add", "-b", branch, wsPath, baseRef];
      await hostGitOk(addArgs, { cwd: repoRoot });
      await hostGitOk(["worktree", "lock", "--reason", req.lockReason, wsPath], { cwd: repoRoot });
      await assertHookSanity(wsPath, repoRoot);
      const configSha = await computeConfigSha(wsPath);
      const meta: WorktreeMeta = { branch, baseSha, remote, remoteUrl, lockReason: req.lockReason, createdAt: new Date().toISOString(), configSha };
      const { gitDir } = await resolveGitDirs(wsPath);
      await writeFile(path.join(gitDir, WORKTREE_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
      return { provider: "git", path: wsPath, branch, baseSha, repoRoot, gitCommonDir, configSha, remote, remoteUrl };
    }, { timeoutMs: this.lockTimeoutMs });
  }

  /** Missing branch → use it; existing branch whose tip is the last host commit → reuse; otherwise first free `<branch>-r<n>`. */
  private async chooseBranch(repoRoot: string, req: CreateWorkspaceRequest): Promise<string> {
    const tip = await branchTip(repoRoot, req.branch);
    if (tip === null) return req.branch;
    if (req.lastHostCommit !== undefined && tip === req.lastHostCommit) return req.branch;
    for (let n = 1; n < 100; n++) {
      const candidate = `${req.branch}-r${n}`;
      if ((await branchTip(repoRoot, candidate)) === null) return candidate;
    }
    throw new Error(`no free retry branch name for ${req.branch}`);
  }

  /** Never removes dirty or unpushed work unless forced (spec §5.13 cleanup). Deletes the local branch afterwards. */
  async remove(ws: Workspace, opts: { force: boolean }): Promise<void> {
    if (!opts.force) {
      const status = await hostGitOk(["status", "--porcelain", "--untracked-files=all"], { cwd: ws.path });
      if (status !== "") throw new WorkspaceRemoveRefusedError(`${ws.path} has uncommitted changes:\n${status}`);
      const remote = ws.remote ?? "origin";
      const unpushed = await hostGitOk(["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`], { cwd: ws.path });
      if (unpushed !== "0") throw new WorkspaceRemoveRefusedError(`${ws.path} has ${unpushed} commit(s) not on ${remote}`);
    }
    await withRepoLock(ws.gitCommonDir, async () => {
      await hostGit(["worktree", "unlock", ws.path], { cwd: ws.repoRoot });
      const args = opts.force ? ["worktree", "remove", "--force", ws.path] : ["worktree", "remove", ws.path];
      await hostGitOk(args, { cwd: ws.repoRoot });
      await hostGit(["branch", "-D", ws.branch], { cwd: ws.repoRoot });
      await hostGitOk(["worktree", "prune"], { cwd: ws.repoRoot });
    }, { timeoutMs: this.lockTimeoutMs });
  }

  /** Factory worktrees only (those carrying WORKTREE_META_FILE); the main checkout and foreign worktrees are skipped. */
  async list(repoRoot: string): Promise<Workspace[]> {
    const root = path.resolve(repoRoot);
    const rootReal = await realpath(root);
    const { gitCommonDir } = await resolveGitDirs(root);
    const entries = parseWorktreeList(await hostGitOk(["worktree", "list", "--porcelain"], { cwd: root }));
    const out: Workspace[] = [];
    for (const e of entries) {
      if (e.bare || e.prunable) continue;
      let entryReal: string;
      try {
        entryReal = await realpath(e.path);
      } catch {
        continue;
      }
      if (entryReal === rootReal) continue;
      let meta: WorktreeMeta;
      try {
        const { gitDir } = await resolveGitDirs(e.path);
        meta = JSON.parse(await readFile(path.join(gitDir, WORKTREE_META_FILE), "utf8")) as WorktreeMeta;
      } catch {
        continue;
      }
      out.push({
        provider: "git",
        path: e.path,
        branch: e.branch ?? meta.branch,
        baseSha: meta.baseSha,
        repoRoot: root,
        gitCommonDir,
        configSha: meta.configSha,
        remote: meta.remote,
        remoteUrl: meta.remoteUrl,
      });
    }
    return out;
  }
}
