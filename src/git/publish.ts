// src/git/publish.ts — v0 publish: preflight then push, FIFO per repo under the repo lock (spec §6.3).
// Never force-pushes. PR creation, handoff.json and queue transitions are v1.
import type { EffectiveRepoConfig } from "../config/schema.js";
import type { RunState } from "../engine/types.js";
import { withRepoLock } from "../workspace/lock.js";
import type { Workspace } from "../workspace/types.js";
import { hostGit, hostGitOk } from "./host-git.js";
import { publishPreflight, type PreflightDeps, type PreflightFailureCode } from "./preflight.js";

export type PublishResult =
  | { pushed: true; sha: string; branch: string; remote: string; pushTarget: string }
  | { pushed: false; code: PreflightFailureCode | "push-rejected"; detail: string };

export interface PublishOptions {
  deps?: PreflightDeps;
  lockTimeoutMs?: number;
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
    return { pushed: true, sha: pre.headSha, branch: pre.branch, remote: pre.remote, pushTarget };
  }, { timeoutMs: opts.lockTimeoutMs ?? 120_000 });
}
