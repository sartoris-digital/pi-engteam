// src/git/preflight.ts — publish preflight (spec §6.3, v0 push-only subset). Every step is a hard stop.
import type { EffectiveRepoConfig } from "../config/schema.js";
import type { RunState } from "../engine/types.js";
import { findGeneratedDocs } from "../gate/generated-docs.js";
import { computeConfigSha } from "../workspace/drift.js";
import type { Workspace } from "../workspace/types.js";
import { checkpointExcludes, statusExcluding } from "./checkpoint.js";
import { hostGit, hostGitOk } from "./host-git.js";

export type PreflightFailureCode = "publish-refused" | "rebase-conflict" | "config-tampered";

export type PreflightResult =
  | { ok: true; headSha: string; baseSha: string; branch: string; remote: string }
  | { ok: false; code: PreflightFailureCode; detail: string };

export interface PreflightDeps {
  findGeneratedDocs: (ws: Workspace, changedFiles: string[]) => Promise<string[]>;
}

const defaultDeps: PreflightDeps = { findGeneratedDocs };

const refuse = (code: PreflightFailureCode, detail: string): PreflightResult => ({ ok: false, code, detail });
const short = (sha: string) => sha.slice(0, 12);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Read-only apart from `git fetch`; publish() holds the repo lock around it.
 * Order follows spec §6.3: judgedSha → configSha → host commits → remote url → clean tree → generated docs → fetch/ls-remote → merge-tree.
 */
export async function publishPreflight(state: RunState, cfg: EffectiveRepoConfig, ws: Workspace, deps: PreflightDeps = defaultDeps): Promise<PreflightResult> {
  const remote = ws.remote ?? cfg.remote;
  const base = cfg.branching.base;
  const baseRef = `${remote}/${base}`;
  const cwd = ws.path;

  // 1. HEAD is exactly the sha the judge passed
  const headSha = await hostGitOk(["rev-parse", "HEAD"], { cwd });
  if (!state.judgedSha) return refuse("publish-refused", "no judgedSha recorded: a judge PASS must precede publish");
  if (headSha !== state.judgedSha) return refuse("publish-refused", `HEAD ${short(headSha)} != judgedSha ${short(state.judgedSha)}`);

  // 2. workspace config fingerprint unchanged since claim
  const configSha = await computeConfigSha(cwd);
  if (configSha !== ws.configSha) return refuse("config-tampered", `workspace configSha ${short(configSha)} != claimed ${short(ws.configSha)}`);

  // 3. every commit since base is a recorded host checkpoint
  const listed = await hostGitOk(["rev-list", "--reverse", `${baseRef}..HEAD`], { cwd });
  const commits = listed === "" ? [] : listed.split("\n");
  if (!sameSet(commits, state.hostCommits)) {
    const foreign = commits.filter((c) => !state.hostCommits.includes(c)).map(short);
    const missing = state.hostCommits.filter((c) => !commits.includes(c)).map(short);
    return refuse("publish-refused", `branch commits differ from hostCommits (foreign: ${foreign.join(",") || "-"}; missing: ${missing.join(",") || "-"})`);
  }

  // 4. remote url equals the claim-time value
  const url = await hostGitOk(["remote", "get-url", remote], { cwd });
  if (ws.remoteUrl !== undefined && url !== ws.remoteUrl) return refuse("config-tampered", `remote ${remote} url changed: ${url} != ${ws.remoteUrl}`);

  // 5. working tree clean (generated docs and .pi/*.local.* are never committed, so they do not count as dirt)
  const dirty = await statusExcluding(ws, checkpointExcludes({ excludePatterns: cfg.generatedDocPatterns }));
  if (dirty.length > 0) return refuse("publish-refused", `working tree not clean:\n${dirty.join("\n")}`);

  // 6. no generated planning docs in the diff (built-in rule r-builtin-no-generated-docs)
  const changed = await hostGitOk(["diff", "--name-only", `${baseRef}...HEAD`], { cwd });
  const changedFiles = changed === "" ? [] : changed.split("\n");
  const generated = await deps.findGeneratedDocs(ws, changedFiles);
  if (generated.length > 0) return refuse("publish-refused", `generated planning docs in diff: ${generated.join(", ")}`);

  // 7. fetch and ls-remote agree on the base
  const fetch = await hostGit(["fetch", "--no-tags", remote, base], { cwd });
  if (fetch.code !== 0) return refuse("publish-refused", `git fetch ${remote} ${base} failed: ${fetch.stderr.trim()}`);
  const baseSha = await hostGitOk(["rev-parse", "--verify", baseRef], { cwd });
  const lsRemote = await hostGitOk(["ls-remote", remote, `refs/heads/${base}`], { cwd });
  const remoteSha = lsRemote.split("\t")[0] ?? "";
  if (remoteSha !== baseSha) return refuse("publish-refused", `${baseRef} ${short(baseSha)} disagrees with ls-remote ${short(remoteSha)}`);

  // 8. merge-tree clean against the (possibly moved) base
  const mt = await hostGit(["merge-tree", "--write-tree", "--name-only", baseRef, "HEAD"], { cwd });
  if (mt.code === 1) {
    const conflicted = mt.stdout.split("\n").slice(1).filter((l) => l !== "" && !/^(Auto-merging|CONFLICT)/.test(l));
    return refuse("rebase-conflict", `merge conflict against ${baseRef}: ${conflicted.join(", ")}`);
  }
  if (mt.code !== 0) return refuse("publish-refused", `git merge-tree failed: ${mt.stderr.trim()}`);

  return { ok: true, headSha, baseSha, branch: state.branch, remote };
}
