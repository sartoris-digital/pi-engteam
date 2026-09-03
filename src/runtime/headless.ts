import { spawn } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerEnv, createScrubDirs, verdictFilePath } from "./env.js";
import { promptPointer } from "./prompt.js";
import { wrapArgv, type SandboxProfile } from "./sandbox.js";
import type { VerdictPayload, WorkerExecutor, WorkerRequest, WorkerResult } from "./types.js";
import { readVerdictFileOnce, waitForVerdictFile } from "./verdict.js";

/** The extension entry loaded into every worker with `-e`; src/index.ts switches to agent mode from the env. */
export const DEFAULT_EXTENSION_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
/** How long a worker may linger after its verdict file appeared before the group is terminated. */
export const DEFAULT_VERDICT_GRACE_MS = 2_000;

export interface HeadlessExecutorOptions {
  extensionEntry?: string;
  baseEnv?: NodeJS.ProcessEnv;
  providerKeys?: readonly string[];
  /** Extra PI_SDLC_* variables (tests: PI_SDLC_STUB_SCENARIO). Parent PI_SDLC_* variables are dropped by env -i. */
  extraEnv?: Record<string, string>;
  /** Builds the sandbox profile for a request; null (or a null return) runs unwrapped (tests, sandbox: off). */
  sandbox?: ((req: WorkerRequest) => SandboxProfile | null) | null;
  killGraceMs?: number;
  pollMs?: number;
  stderrTailBytes?: number;
  verdictGraceMs?: number;
  /** Observes every spawn (child registry hook for Task 9.x). */
  onSpawn?: (info: { pid: number; argv: string[]; startedAt: string }) => void;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

class StderrTail {
  private buf = Buffer.alloc(0);
  constructor(private readonly cap: number) {}
  push(chunk: Buffer | string): void {
    this.buf = Buffer.concat([this.buf, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    if (this.buf.length > this.cap) this.buf = this.buf.subarray(this.buf.length - this.cap);
  }
  toString(): string {
    // Strip terminal escape sequences and control characters (keep newline and tab) so a worker
    // cannot smuggle terminal control into the controller's logs.
    return this.buf
      .toString("utf8")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  }
}

export class HeadlessExecutor implements WorkerExecutor {
  constructor(private readonly opts: HeadlessExecutorOptions = {}) {}

  async run(req: WorkerRequest): Promise<WorkerResult> {
    const startedAt = Date.now();
    await access(req.promptPath);

    const verdictFile = verdictFilePath(req.runDir, req.stage, req.round);
    await mkdir(dirname(verdictFile), { recursive: true });
    await rm(verdictFile, { force: true });

    const scrub = createScrubDirs();
    const env = buildWorkerEnv(this.opts.baseEnv ?? process.env, req, {
      providerKeys: this.opts.providerKeys,
      scrub,
      extra: this.opts.extraEnv,
    });

    let argv = [req.piBinary, "-p", "--no-session", "-e", this.opts.extensionEntry ?? DEFAULT_EXTENSION_ENTRY, promptPointer(req.promptPath)];
    const profile = this.opts.sandbox?.(req) ?? null;
    if (profile) argv = wrapArgv(argv, profile);
    const [cmd, ...args] = argv;
    if (cmd === undefined) throw new Error("HeadlessExecutor: empty argv");

    const tail = new StderrTail(this.opts.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES);
    const child = spawn(cmd, args, { cwd: req.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => tail.push(chunk));
    if (child.pid !== undefined) this.opts.onSpawn?.({ pid: child.pid, argv, startedAt: new Date(startedAt).toISOString() });

    const exited = new Promise<ExitInfo>((resolve) => {
      child.once("error", (err) => {
        tail.push(`[spawn] ${err.message}\n`);
        resolve({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const escalate = (): void => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      escalate();
    }, req.timeoutMs);
    const onAbort = (): void => escalate();
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener("abort", onAbort, { once: true });

    const pollAbort = new AbortController();
    const verdictSeen = waitForVerdictFile(verdictFile, { signal: pollAbort.signal, pollMs: this.opts.pollMs ?? 250 });

    let exitInfo: ExitInfo;
    const first = await Promise.race([
      exited.then((info) => ({ kind: "exit" as const, info })),
      verdictSeen.then((verdict) => ({ kind: "verdict" as const, verdict })),
    ]);
    if (first.kind === "exit") {
      exitInfo = first.info;
    } else {
      if (first.verdict !== null) clearTimeout(timeoutTimer); // the step delivered; a slow exit is not a timeout
      const grace = new Promise<null>((resolve) => setTimeout(() => resolve(null), this.opts.verdictGraceMs ?? DEFAULT_VERDICT_GRACE_MS));
      const raced = await Promise.race([exited, grace]);
      if (raced === null) {
        escalate();
        exitInfo = await exited;
      } else {
        exitInfo = raced;
      }
    }

    pollAbort.abort();
    await verdictSeen;
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    req.signal.removeEventListener("abort", onAbort);

    let verdict: VerdictPayload | null = null;
    if (timedOut) {
      tail.push(`\n[executor] stage timed out after ${req.timeoutMs} ms; any verdict is ignored\n`);
    } else {
      const final = await readVerdictFileOnce(verdictFile);
      if (final?.ok) verdict = final.payload;
      else if (final) tail.push(`\n[verdict] ${final.error}\n`);
    }

    await rm(scrub.root, { recursive: true, force: true });
    return {
      verdict,
      exitCode: exitInfo.code,
      timedOut,
      stderrTail: tail.toString(),
      durationMs: Date.now() - startedAt,
    };
  }
}
