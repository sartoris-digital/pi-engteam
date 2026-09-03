import { loadEffectiveConfig } from "../config/effective.js";
import type { EffectiveRepoConfig } from "../config/schema.js";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { hostGitOk } from "../git/host-git.js";
import { runRebaseCycle, type RebaseDeps } from "../scheduler/rebase-cycle.js";
import { computeConfigSha, resolveGitDirs } from "../workspace/drift.js";
import type { Workspace } from "../workspace/types.js";
import { findQueueEntry, readQueue, writeQueue, type QueueEntry } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export interface RebaseCommandOpts {
  cycle?: typeof runRebaseCycle;
  rebaseDeps?: RebaseDeps;
  cfg?: EffectiveRepoConfig;
  ws?: Workspace;
}

async function workspaceFromEntry(entry: QueueEntry): Promise<Workspace> {
  const wt = entry.workspace?.path;
  const branch = entry.workspace?.branch;
  if (wt === undefined || branch === undefined) throw new Error(`rebase: ${entry.ref} has no workspace`);
  const dirs = await resolveGitDirs(wt);
  const remote = "origin";
  const remoteUrl = entry.remoteUrl ?? (await hostGitOk(["remote", "get-url", remote], { cwd: wt }));
  const baseSha = entry.baseSha ?? (await hostGitOk(["rev-parse", "HEAD"], { cwd: wt }));
  const configSha = entry.configSha ?? (await computeConfigSha(wt));
  return {
    provider: entry.workspace?.provider ?? "git",
    path: wt,
    branch,
    baseSha,
    repoRoot: entry.repo,
    gitCommonDir: dirs.gitCommonDir,
    configSha,
    remote,
    remoteUrl,
  };
}

/** Manual `/factory rebase <ref>` — always runs the cycle, even when autoRebase is false. */
export async function runRebase(
  parsed: ParsedFactoryArgs,
  deps: FactoryDeps,
  opts: RebaseCommandOpts = {},
): Promise<QueueEntry> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("rebase: missing ref");
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`rebase: ${ref} not in queue`);
  const branch = entry.workspace?.branch;
  if (branch === undefined) throw new Error(`rebase: ${ref} has no branch`);

  const cfg = opts.cfg ?? (await loadEffectiveConfig(entry.repo, { home: deps.home })).repo;
  const ws = opts.ws ?? (await workspaceFromEntry(entry));
  const cycle = opts.cycle ?? runRebaseCycle;
  const result = await cycle(
    {
      entry: {
        key: entry.key,
        runId: entry.runId ?? "",
        branch,
        repo: entry.repo,
        ref: entry.ref,
        hostCommits: entry.hostCommits,
      },
      ws,
      cfg,
      nameTemplate: cfg.branching.nameTemplate,
      rebaseCount: entry.rebaseCount ?? 0,
    },
    opts.rebaseDeps ?? { home: deps.home },
  );

  const at = new Date().toISOString();
  if (result.ok) {
    if (entry.workspace !== undefined) entry.workspace = { ...entry.workspace, branch: result.branch };
    entry.rebaseCount = (entry.rebaseCount ?? 0) + 1;
    entry.state = "published";
    delete entry.waitingOn;
  } else if (result.code === "human-owned") {
    entry.state = "human-owned";
    delete entry.waitingOn;
    entry.escalations = [...(entry.escalations ?? []), { code: "human-owned", at }];
  } else {
    entry.escalations = [...(entry.escalations ?? []), { code: "rebase-conflict", at }];
  }
  entry.updatedAt = at;
  await writeQueue(deps.runsDir, queue);
  return entry;
}
