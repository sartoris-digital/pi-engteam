// src/workspace/drift.ts — fingerprint of everything in a worktree's git configuration that could
// run code or redirect a push (spec §5.5 step 1, §5.9). Recomputed before every host git write.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { hostGit, hostGitOk } from "../git/host-git.js";
import type { Workspace } from "./types.js";

export class ConfigTamperedError extends Error {
  readonly code = "config-tampered" as const;
  constructor(readonly detail: string) {
    super(`config tampered: ${detail}`);
    this.name = "ConfigTamperedError";
  }
}

export interface GitDirs {
  worktree: string;
  /** `.git` for a main checkout; `<common>/worktrees/<name>` for a linked worktree. Absolute. */
  gitDir: string;
  /** The shared `.git` directory. Absolute. */
  gitCommonDir: string;
}

export async function resolveGitDirs(worktree: string): Promise<GitDirs> {
  const gitDir = path.resolve(worktree, await hostGitOk(["rev-parse", "--git-dir"], { cwd: worktree }));
  const gitCommonDir = path.resolve(worktree, await hostGitOk(["rev-parse", "--git-common-dir"], { cwd: worktree }));
  return { worktree, gitDir, gitCommonDir };
}

async function fileOrEmpty(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}

/** Sorted `name\tsha256` lines for every regular file directly inside dir; "" when the dir is missing. */
export async function hooksDirDigest(dir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const name of names) {
    const p = path.join(dir, name);
    const s = await stat(p);
    if (!s.isFile()) continue;
    lines.push(`${name}\t${createHash("sha256").update(await readFile(p)).digest("hex")}`);
  }
  return lines.join("\n");
}

/** core.hooksPath (as git resolves it for this worktree, overrides skipped) or the shared hooks dir. */
export async function effectiveHooksDir(dirs: GitDirs): Promise<string> {
  const res = await hostGit(["config", "core.hooksPath"], { cwd: dirs.worktree, noOverrides: true });
  const configured = res.code === 0 ? res.stdout.trim() : "";
  return configured ? path.resolve(dirs.worktree, configured) : path.join(dirs.gitCommonDir, "hooks");
}

export async function computeConfigSha(worktree: string): Promise<string> {
  const dirs = await resolveGitDirs(worktree);
  const remote = await hostGit(["remote", "get-url", "origin"], { cwd: worktree });
  const parts: Array<[string, string]> = [
    ["config", await fileOrEmpty(path.join(dirs.gitCommonDir, "config"))],
    ["config.worktree", await fileOrEmpty(path.join(dirs.gitDir, "config.worktree"))],
    ["gitmodules", await fileOrEmpty(path.join(worktree, ".gitmodules"))],
    ["hooks", await hooksDirDigest(await effectiveHooksDir(dirs))],
    ["remote", remote.code === 0 ? remote.stdout.trim() : ""],
  ];
  const h = createHash("sha256");
  for (const [label, content] of parts) h.update(`${label}\n${Buffer.byteLength(content)}\n${content}\n`);
  return h.digest("hex");
}

export async function assertNoDrift(ws: Workspace): Promise<void> {
  const now = await computeConfigSha(ws.path);
  if (now !== ws.configSha) {
    throw new ConfigTamperedError(`workspace ${ws.path} configSha ${now.slice(0, 12)} != claimed ${ws.configSha.slice(0, 12)}`);
  }
}

/** §5.5 step 1: the worktree's core.hooksPath must equal the main checkout's and must not come from config.worktree. */
export async function assertHookSanity(worktree: string, repoRoot: string): Promise<void> {
  const wt = await hostGit(["config", "--show-origin", "core.hooksPath"], { cwd: worktree, noOverrides: true });
  const main = await hostGit(["config", "core.hooksPath"], { cwd: repoRoot, noOverrides: true });
  const wtLine = wt.code === 0 ? wt.stdout.trim() : "";
  const tab = wtLine.indexOf("\t");
  const wtOrigin = tab === -1 ? wtLine : wtLine.slice(0, tab);
  const wtValue = tab === -1 ? "" : wtLine.slice(tab + 1);
  const mainValue = main.code === 0 ? main.stdout.trim() : "";
  if (wtOrigin.endsWith("config.worktree")) throw new ConfigTamperedError(`worktree-level core.hooksPath set in ${wtOrigin}`);
  if (wtValue !== mainValue) throw new ConfigTamperedError(`core.hooksPath differs: worktree "${wtValue}" vs main checkout "${mainValue}"`);
}
