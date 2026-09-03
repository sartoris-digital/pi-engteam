// src/git/publish.ts — preflight then push, then optional PR + handoff.json (spec §6.3).
// Never force-pushes. Omit opts.pr to keep the v0 push-only path.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveRepoConfig } from "../config/schema.js";
import type { RunState } from "../engine/types.js";
import { withRepoLock } from "../workspace/lock.js";
import type { Workspace } from "../workspace/types.js";
import { writeHandoff, type Handoff } from "./handoff.js";
import { hostGit, hostGitOk } from "./host-git.js";
import { isDraftPr, renderPrTitle, type PrClient } from "./pr.js";
import { composePrBody } from "./prbody.js";
import { publishPreflight, type PreflightDeps, type PreflightFailureCode } from "./preflight.js";

export type PublishResult =
  | {
      pushed: true;
      sha: string;
      branch: string;
      remote: string;
      pushTarget: string;
      pr?: { number: number; url: string };
      handoffPath?: string;
    }
  | { pushed: false; code: PreflightFailureCode | "push-rejected"; detail: string };

export interface PublishOptions {
  deps?: PreflightDeps;
  lockTimeoutMs?: number;
  /** Injected PR client. null/undefined → push only (v0). */
  pr?: PrClient | null;
  runDir?: string;
  prRepo?: string;
  prBody?: string;
  prTitle?: string;
  draft?: boolean;
  ticketLine?: string;
  now?: () => Date;
}

function ticketLineFor(state: RunState, override?: string): string {
  if (override !== undefined) return override;
  if (state.ticket.tracker === "local") return `Source: local task ${state.ticket.ref}`;
  const m = state.ticket.ref.match(/#(\d+)\s*$/);
  if (m !== null) return `Fixes #${m[1]}`;
  return `Source: ${state.ticket.ref}`;
}

export async function publish(state: RunState, cfg: EffectiveRepoConfig, ws: Workspace, opts: PublishOptions = {}): Promise<PublishResult> {
  return withRepoLock(ws.gitCommonDir, async () => {
    const pre = await publishPreflight(state, cfg, ws, opts.deps);
    if (!pre.ok) return { pushed: false, code: pre.code, detail: pre.detail };

    const pushTarget = ws.remoteUrl ?? pre.remote;
    const refspec = `${pre.headSha}:refs/heads/${pre.branch}`;
    const push = await hostGit(["push", pushTarget, refspec], { cwd: ws.path });
    if (push.code !== 0) {
      const tail = push.stderr.trim().split("\n").slice(-4).join(" | ");
      return { pushed: false, code: "push-rejected", detail: `git push ${pushTarget} ${refspec} exited ${push.code}: ${tail}` };
    }

    const lsRemote = await hostGitOk(["ls-remote", pushTarget, `refs/heads/${pre.branch}`], { cwd: ws.path });
    const remoteTip = lsRemote.split("\t")[0] ?? "";
    if (remoteTip !== pre.headSha) {
      return { pushed: false, code: "push-rejected", detail: `remote ${pre.branch} is ${remoteTip.slice(0, 12)} after push, expected ${pre.headSha.slice(0, 12)}` };
    }

    const pushed: PublishResult = { pushed: true, sha: pre.headSha, branch: pre.branch, remote: pre.remote, pushTarget };
    if (opts.pr == null) return pushed;

    const ticketLine = ticketLineFor(state, opts.ticketLine);
    const body =
      opts.prBody ??
      composePrBody({
        run: {
          runId: state.runId,
          wallSeconds: state.wallSecondsUsed,
          iteration: state.iteration,
          costUsd: state.costUsd,
        },
        ticketLine,
      });
    if (opts.runDir !== undefined) {
      await mkdir(opts.runDir, { recursive: true, mode: 0o700 });
      await writeFile(join(opts.runDir, "pr-body.md"), body, { encoding: "utf8" });
    }

    const title =
      opts.prTitle ??
      renderPrTitle(cfg.branching.titleTemplate, {
        kind: state.kind,
        title: state.ticket.title,
        slug: state.ticket.title,
        ref: state.ticket.ref,
      });
    const draft = opts.draft ?? isDraftPr({ tier: state.tier, draftPolicy: cfg.branching.draftPolicy });
    const repo = opts.prRepo ?? "local";
    const created = await opts.pr.create({
      repo,
      base: cfg.branching.base,
      head: pre.branch,
      title,
      body,
      draft,
    });

    let handoffPath: string | undefined;
    if (opts.runDir !== undefined) {
      const changed = await hostGitOk(["diff", "--name-only", `${state.baseSha}...${pre.headSha}`], { cwd: ws.path }).catch(() => "");
      const handoff: Handoff = {
        ref: state.ticket.ref,
        runId: state.runId,
        lane: state.lane,
        branch: pre.branch,
        baseSha: state.baseSha,
        judgedSha: pre.headSha,
        hostCommits: [...state.hostCommits],
        patchIds: [],
        changedFiles: changed === "" ? [] : changed.split("\n"),
        writeGlobs: [...(cfg.writeRoots[state.kind] ?? [])],
        prUrl: created.url,
        publishedAt: (opts.now ?? (() => new Date()))().toISOString(),
      };
      handoffPath = await writeHandoff(opts.runDir, handoff);
    }

    return { ...pushed, pr: created, ...(handoffPath === undefined ? {} : { handoffPath }) };
  }, { timeoutMs: opts.lockTimeoutMs ?? 120_000 });
}
