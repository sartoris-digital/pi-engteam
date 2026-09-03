// src/git/reconcile.ts — land-reconcile from git history only (spec §6.5). Never reads PR state.
import { isAbsolute, resolve } from "node:path";
import type { QueueEntry } from "../commands/enqueue.js";
import { repoSlug } from "../workspace/git-provider.js";
import { withRepoLock } from "../workspace/lock.js";
import { hostGit, hostGitOk } from "./host-git.js";
import { patchIdCachePath, readPatchIdCache, stableDiffPatchId, stablePatchId, windowPatchIds } from "./patch-id.js";

export type LandedAs = "clean" | "human-modified" | "partial";

export interface LandReconcileOptions {
  cwd: string;
  remote?: string;
  base: string;
  abandonDays: number;
  now?: () => Date;
  lastReconciledSha?: string;
  runsDir?: string;
  others?: QueueEntry[];
}

function ticketNeedles(entry: QueueEntry): string[] {
  const out = [entry.ref];
  const hash = entry.ref.match(/#(\d+)\s*$/);
  if (hash !== null && hash[1] !== undefined) {
    out.push(`#${hash[1]}`);
    out.push(`Fixes #${hash[1]}`);
  }
  if (entry.prNumber !== undefined) {
    out.push(`#${entry.prNumber}`);
    out.push(`/pull/${entry.prNumber}`);
  }
  if (entry.workspace?.branch !== undefined) out.push(entry.workspace.branch);
  return out.filter((s) => s.length > 0);
}

function messageHits(message: string, needles: string[]): boolean {
  return needles.some((n) => message.includes(n));
}

function parseChangedLines(diff: string): Map<string, Set<string>> {
  const files = new Map<string, Set<string>>();
  let file = "";
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header?.[2] !== undefined) {
      file = header[2];
      if (!files.has(file)) files.set(file, new Set());
      continue;
    }
    if (file === "" || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) files.get(file)?.add(line);
  }
  return files;
}

function hunkOverlap(judged: Map<string, Set<string>>, other: Map<string, Set<string>>): number {
  let total = 0;
  let hit = 0;
  for (const [file, lines] of judged) {
    const theirs = other.get(file);
    for (const line of lines) {
      total += 1;
      if (theirs?.has(line) === true) hit += 1;
    }
  }
  return total === 0 ? 0 : hit / total;
}

async function gitCommonDir(cwd: string): Promise<string> {
  const raw = await hostGitOk(["rev-parse", "--git-common-dir"], { cwd });
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

async function changedFilesOf(entry: QueueEntry, cwd: string): Promise<string[]> {
  if (entry.changedFiles !== undefined && entry.changedFiles.length > 0) return entry.changedFiles;
  if (entry.baseSha === undefined || entry.judgedSha === undefined) return [];
  const out = await hostGitOk(["diff", "--name-only", `${entry.baseSha}...${entry.judgedSha}`], { cwd }).catch(() => "");
  return out === "" ? [] : out.split("\n");
}

async function land(
  entry: QueueEntry,
  as: LandedAs,
  sha: string,
  lastReconciledSha: string,
  opts: { others?: QueueEntry[]; cwd: string; remote: string; base: string },
): Promise<QueueEntry> {
  entry.state = "landed";
  entry.landedAs = as;
  entry.landedBy = "git";
  entry.landedSha = sha;
  entry.lastReconciledSha = lastReconciledSha;
  entry.updatedAt = new Date().toISOString();
  if (opts.others !== undefined) await markNeedsRebase(entry, opts.others, opts.cwd, opts.remote, opts.base);
  return entry;
}

async function markNeedsRebase(landed: QueueEntry, others: QueueEntry[], cwd: string, remote: string, base: string): Promise<void> {
  const baseRef = `${remote}/${base}`;
  for (const other of others) {
    if (other === landed || other.state !== "published") continue;
    if (other.repo !== landed.repo) continue;
    const branch = other.workspace?.branch;
    if (branch === undefined) continue;
    const head = (await hostGitOk(["rev-parse", "--verify", "--quiet", `${remote}/${branch}`], { cwd }).catch(() => ""))
      || (await hostGitOk(["rev-parse", "--verify", "--quiet", branch], { cwd }).catch(() => ""));
    if (head === "") continue;
    const mt = await hostGit(["merge-tree", "--write-tree", "--name-only", baseRef, head], { cwd });
    if (mt.code === 1) {
      other.state = "needs-rebase";
      other.updatedAt = new Date().toISOString();
    }
  }
}

/** Ancestor → patch-id → file-set/message → vanished branch. Never consults PR state. */
export async function landReconcile(entry: QueueEntry, opts: LandReconcileOptions): Promise<QueueEntry> {
  if (entry.state !== "published") return entry;
  const remote = opts.remote ?? "origin";
  const base = opts.base;
  const cwd = opts.cwd;
  const now = opts.now ?? (() => new Date());
  const common = await gitCommonDir(cwd);
  return withRepoLock(common, async () => {
    const fetch = await hostGit(["fetch", "--no-tags", remote, base], { cwd });
    if (fetch.code !== 0) return entry;
    const baseRef = `${remote}/${base}`;
    const tip = await hostGitOk(["rev-parse", "--verify", baseRef], { cwd });
    const last = opts.lastReconciledSha ?? entry.lastReconciledSha ?? entry.baseSha;

    const landOpts = { others: opts.others, cwd, remote, base };
    if (entry.judgedSha !== undefined) {
      const anc = await hostGit(["merge-base", "--is-ancestor", entry.judgedSha, baseRef], { cwd });
      if (anc.code === 0) return land(entry, "clean", tip, tip, landOpts);
    }

    const range = last !== undefined && last !== "" ? `${last}..${baseRef}` : `${entry.baseSha ?? ""}..${baseRef}`;
    let cache: { path: string; map: Map<string, string> } | undefined;
    if (opts.runsDir !== undefined) {
      const slug = repoSlug(entry.repo || cwd);
      const path = patchIdCachePath(opts.runsDir, slug);
      cache = { path, map: await readPatchIdCache(path) };
    }
    const window = range.startsWith("..") ? { shas: [] as string[], ids: [] as string[] } : await windowPatchIds(cwd, range, cache);
    const windowSet = new Set(window.ids);

    const hostIds: string[] = [];
    for (const sha of entry.hostCommits ?? []) {
      const ids = await stablePatchId(cwd, `${sha}^!`);
      if (ids[0] !== undefined) hostIds.push(ids[0]);
    }
    const squashId =
      entry.baseSha !== undefined && entry.judgedSha !== undefined
        ? await stableDiffPatchId(cwd, entry.baseSha, entry.judgedSha)
        : null;

    if ((squashId !== null && windowSet.has(squashId)) || (hostIds.length > 0 && hostIds.every((id) => windowSet.has(id)))) {
      return land(entry, "clean", tip, tip, landOpts);
    }
    const matchedHost = hostIds.filter((id) => windowSet.has(id));
    if (matchedHost.length > 0 && matchedHost.length < hostIds.length) {
      return land(entry, "partial", tip, tip, landOpts);
    }

    const files = await changedFilesOf(entry, cwd);
    const needles = ticketNeedles(entry);
    const judgedDiff =
      entry.baseSha !== undefined && entry.judgedSha !== undefined
        ? (await hostGit(["diff", entry.baseSha, entry.judgedSha], { cwd })).stdout
        : "";
    const judgedLines = parseChangedLines(judgedDiff);
    for (const sha of window.shas) {
      const namesRaw = await hostGitOk(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], { cwd }).catch(() => "");
      const names = namesRaw === "" ? [] : namesRaw.split("\n");
      const intersects = files.some((f) => names.includes(f));
      const message = await hostGitOk(["log", "-1", "--format=%B", sha], { cwd }).catch(() => "");
      if (intersects && messageHits(message, needles)) return land(entry, "human-modified", sha, tip, landOpts);
      const commitDiff = (await hostGit(["show", "--format=", sha], { cwd })).stdout;
      if (hunkOverlap(judgedLines, parseChangedLines(commitDiff)) >= 0.5) {
        return land(entry, "human-modified", sha, tip, landOpts);
      }
    }

    const branch = entry.workspace?.branch;
    if (branch !== undefined) {
      const ls = await hostGitOk(["ls-remote", remote, `refs/heads/${branch}`], { cwd }).catch(() => "");
      const gone = ls.trim() === "";
      const ageMs = now().getTime() - Date.parse(entry.updatedAt);
      if (gone && Number.isFinite(ageMs) && ageMs > opts.abandonDays * 86_400_000) {
        entry.state = "closed";
        entry.lastReconciledSha = tip;
        entry.updatedAt = now().toISOString();
        return entry;
      }
    }

    entry.lastReconciledSha = tip;
    return entry;
  }, { timeoutMs: 120_000 });
}

export async function reconcilePublished(
  entries: QueueEntry[],
  opts: Omit<LandReconcileOptions, "others">,
): Promise<QueueEntry[]> {
  const published = entries.filter((e) => e.state === "published");
  const updated: QueueEntry[] = [];
  for (const e of published) {
    updated.push(await landReconcile(e, { ...opts, others: published }));
  }
  return updated;
}
