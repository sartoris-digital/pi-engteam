import { access, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { HerdrCli } from "../workspace/herdr.js";
import { buildWorkerEnv, createScrubDirs, verdictFilePath } from "./env.js";
import { installLauncher } from "./launcher.js";
import { promptPointer } from "./prompt.js";
import type { WorkerExecutor, WorkerRequest, WorkerResult } from "./types.js";
import { waitForVerdictFile } from "./verdict.js";

export interface VisibleExecutorOptions {
  cli: HerdrCli;
  home?: string;
  pollMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
}

export class VisibleExecutor implements WorkerExecutor {
  constructor(private readonly opts: VisibleExecutorOptions) {}

  async run(req: WorkerRequest): Promise<WorkerResult> {
    const startedAt = Date.now();
    await access(req.promptPath);
    const verdictFile = verdictFilePath(req.runDir, req.stage, req.round);
    await mkdir(dirname(verdictFile), { recursive: true });
    await rm(verdictFile, { force: true });
    if (this.opts.home !== undefined) await installLauncher(this.opts.home);

    const scrub = createScrubDirs();
    const env = buildWorkerEnv(this.opts.baseEnv ?? process.env, req, {
      scrub,
      extra: this.opts.extraEnv,
    });
    const listed = await this.opts.cli.worktreeList(req.projectRoot);
    const ws = listed.find((row) => row.path === req.cwd) ?? listed[0];
    const workspaceId = ws?.workspaceId ?? req.cwd;
    const pane = await this.opts.cli.paneSplit({ workspaceId, env });
    let timedOut = false;
    try {
      await this.opts.cli.agentStart({ name: req.agent.name, paneId: pane.paneId, extraArgs: [] });
      await this.opts.cli.agentPrompt({
        name: req.agent.name,
        text: promptPointer(req.promptPath),
        timeoutMs: req.timeoutMs,
      });
      const pollAbort = new AbortController();
      const onAbort = (): void => pollAbort.abort();
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        pollAbort.abort();
      }, req.timeoutMs);
      const verdict = await waitForVerdictFile(verdictFile, { signal: pollAbort.signal, pollMs: this.opts.pollMs ?? 50 });
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      return {
        verdict,
        exitCode: verdict !== null ? 0 : null,
        timedOut: timedOut && verdict === null,
        stderrTail: "",
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await this.opts.cli.paneClose(pane.paneId).catch(() => undefined);
      await rm(scrub.root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
