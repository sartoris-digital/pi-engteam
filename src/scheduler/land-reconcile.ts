import type { EffectiveRepoConfig } from "../config/schema.js";
import { landReconcile as gitLandReconcile, type LandReconcileOptions } from "../git/reconcile.js";
import { hostGit, hostGitOk } from "../git/host-git.js";
import type { TicketRef } from "../trackers/adapter.js";
import type { Workspace } from "../workspace/types.js";
import { runRebaseCycle, type RebaseDeps } from "./rebase-cycle.js";
import type { QueueEntry } from "./queue.js";

export interface LandAdapter {
  addLabel(ref: TicketRef, label: string): Promise<void>;
  comment(ref: TicketRef, body: string, opts: { idempotencyKey: string }): Promise<string | null>;
}

export interface SchedulerLandOpts extends LandReconcileOptions {
  autoRebase?: boolean;
  rebaseMaxCycles?: number;
  adapter?: LandAdapter;
  workspaceOf?: (entry: QueueEntry) => Workspace | undefined;
  cfg?: EffectiveRepoConfig;
  rebaseDeps?: RebaseDeps;
  runRebase?: typeof runRebaseCycle;
  emit?: (event: { type: string; data?: Record<string, unknown> }) => void;
}

function ticketRef(entry: QueueEntry): TicketRef {
  return { tracker: entry.tracker, id: entry.ref };
}

async function conflictsWithBase(
  other: QueueEntry,
  opts: { cwd: string; remote: string; base: string },
): Promise<boolean> {
  const branch = other.workspace?.branch;
  if (branch === undefined) return false;
  const head =
    (await hostGitOk(["rev-parse", "--verify", "--quiet", `${opts.remote}/${branch}`], { cwd: opts.cwd }).catch(() => ""))
    || (await hostGitOk(["rev-parse", "--verify", "--quiet", branch], { cwd: opts.cwd }).catch(() => ""));
  if (head === "") return false;
  const mt = await hostGit(["merge-tree", "--write-tree", "--name-only", `${opts.remote}/${opts.base}`, head], {
    cwd: opts.cwd,
  });
  return mt.code === 1;
}

/** Post-landing hook: merge-tree siblings vs new origin/<base>, label, comment, optional auto rebase. */
export async function afterLand(landed: QueueEntry, others: QueueEntry[], opts: SchedulerLandOpts): Promise<void> {
  const remote = opts.remote ?? "origin";
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const autoRebase = opts.autoRebase !== false;
  const max = opts.rebaseMaxCycles ?? 2;
  const cycle = opts.runRebase ?? runRebaseCycle;

  for (const other of others) {
    if (other === landed || other.key === landed.key) continue;
    if (other.repo !== landed.repo) continue;
    if (other.state !== "published" && other.state !== "needs-rebase") continue;
    const branch = other.workspace?.branch;
    if (branch === undefined) continue;

    const conflict =
      other.state === "needs-rebase" || (await conflictsWithBase(other, { cwd: opts.cwd, remote, base: opts.base }));
    if (!conflict) continue;

    other.state = "needs-rebase";
    other.waitingOn = "rebase";
    other.updatedAt = now;
    opts.emit?.({ type: "factory.needs-rebase", data: { ref: other.ref, branch } });

    if (opts.adapter !== undefined) {
      const ref = ticketRef(other);
      await opts.adapter.addLabel(ref, "factory:needs-rebase");
      await opts.adapter.comment(
        ref,
        `factory:needs-rebase — ${branch} conflicts with landed ${landed.ref} on ${opts.base}`,
        { idempotencyKey: `${other.runId ?? other.key}:needs-rebase` },
      );
    }

    if (!autoRebase) continue;
    if ((other.rebaseCount ?? 0) >= max) {
      other.escalations = [...(other.escalations ?? []), { code: "rebase-conflict", at: now }];
      continue;
    }

    const ws = opts.workspaceOf?.(other);
    if (ws === undefined || opts.cfg === undefined || opts.rebaseDeps === undefined) continue;

    const result = await cycle(
      {
        entry: {
          key: other.key,
          runId: other.runId ?? "",
          branch,
          repo: other.repo,
          ref: other.ref,
          hostCommits: other.hostCommits,
        },
        ws,
        cfg: opts.cfg,
        nameTemplate: opts.cfg.branching.nameTemplate,
        rebaseCount: other.rebaseCount ?? 0,
      },
      { ...opts.rebaseDeps, rebaseMaxCycles: max },
    );

    if (result.ok) {
      if (other.workspace !== undefined) other.workspace = { ...other.workspace, branch: result.branch };
      other.rebaseCount = (other.rebaseCount ?? 0) + 1;
      other.state = "published";
      delete other.waitingOn;
      other.updatedAt = now;
    } else if (result.code === "human-owned") {
      other.state = "human-owned";
      delete other.waitingOn;
      other.escalations = [...(other.escalations ?? []), { code: "human-owned", at: now }];
    } else {
      other.escalations = [...(other.escalations ?? []), { code: "rebase-conflict", at: now }];
    }
  }
}

/** Thin seam: git-history land-reconcile, then afterLand rebase triggers. */
export async function landReconcile(entry: QueueEntry, opts: SchedulerLandOpts): Promise<QueueEntry> {
  const out = await gitLandReconcile(entry, {
    cwd: opts.cwd,
    remote: opts.remote,
    base: opts.base,
    abandonDays: opts.abandonDays,
    now: opts.now,
    lastReconciledSha: opts.lastReconciledSha,
    runsDir: opts.runsDir,
    others: opts.others,
  });
  if (out.state === "landed") {
    opts.emit?.({ type: "factory.landed", data: { ref: out.ref, landedAs: out.landedAs } });
    await afterLand(out, opts.others ?? [], opts);
  }
  return out;
}
