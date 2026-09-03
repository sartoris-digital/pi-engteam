// src/git/checkpoint.ts — host checkpoint commit at every stage boundary (spec §5.9). Never judge-gated.
// Generated-doc globs are injected by the caller (cfg.generatedDocPatterns) rather than imported from
// src/gate/generated-docs.ts, so this module stays a leaf and does not depend on the gate group.
import { assertNoDrift } from "../workspace/drift.js";
import { withRepoLock } from "../workspace/lock.js";
import type { Workspace } from "../workspace/types.js";
import { hostGit, hostGitOk } from "./host-git.js";

export const CHECKPOINT_EXCLUDES: readonly string[] = [".pi/*.local.*"];
export const MAX_COMMIT_MESSAGE_CHARS = 4000;

export interface CheckpointTrailers {
  runId: string;
  /** Rendered as `Co-Authored-By: <value>` when present. */
  coAuthoredBy?: string;
}

export interface CheckpointOptions {
  /** Extra glob patterns to keep out of the commit. Callers pass cfg.generatedDocPatterns. */
  excludePatterns?: readonly string[];
  lockTimeoutMs?: number;
}

/** Pathspecs that select everything except the glob patterns. */
export function excludePathspecs(patterns: readonly string[]): string[] {
  return [".", ...patterns.map((p) => `:(exclude,glob)${p}`)];
}

export function checkpointExcludes(opts: CheckpointOptions = {}): string[] {
  return [...CHECKPOINT_EXCLUDES, ...(opts.excludePatterns ?? [])];
}

/** Worker-supplied text: normalise newlines, drop control characters, cap length, never empty or option-shaped. */
export function sanitizeCommitMessage(message: string): string {
  let m = message.replace(/\r\n?/g, "\n").replace(/[^\P{C}\n\t]/gu, "").trim();
  if (m.length > MAX_COMMIT_MESSAGE_CHARS) m = m.slice(0, MAX_COMMIT_MESSAGE_CHARS).trimEnd();
  if (m === "") return "checkpoint";
  return m.startsWith("-") ? `checkpoint ${m}` : m;
}

export function trailerArgs(trailers: CheckpointTrailers): string[] {
  const out: string[] = [];
  if (trailers.coAuthoredBy) out.push("--trailer", `Co-Authored-By: ${trailers.coAuthoredBy}`);
  out.push("--trailer", `Factory-Run: ${trailers.runId}`);
  return out;
}

/** `git status --porcelain` lines for paths not covered by the exclude patterns. */
export async function statusExcluding(ws: Workspace, patterns: readonly string[]): Promise<string[]> {
  const out = await hostGitOk(["status", "--porcelain", "--untracked-files=all", "--", ...excludePathspecs(patterns)], { cwd: ws.path });
  return out === "" ? [] : out.split("\n");
}

export async function checkpointCommit(ws: Workspace, message: string, trailers: CheckpointTrailers, opts: CheckpointOptions = {}): Promise<string | null> {
  await assertNoDrift(ws);
  const excludes = checkpointExcludes(opts);
  return withRepoLock(ws.gitCommonDir, async () => {
    await hostGitOk(["add", "-A", "--", ...excludePathspecs(excludes)], { cwd: ws.path });
    const staged = await hostGit(["diff", "--cached", "--quiet"], { cwd: ws.path });
    if (staged.code === 0) return null;
    await hostGitOk(["commit", "-m", sanitizeCommitMessage(message), ...trailerArgs(trailers)], { cwd: ws.path });
    return hostGitOk(["rev-parse", "HEAD"], { cwd: ws.path });
  }, { timeoutMs: opts.lockTimeoutMs ?? 60_000 });
}
