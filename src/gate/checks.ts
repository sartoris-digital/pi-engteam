import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Workspace } from "../workspace/types.js";
import { parseJunit, type JunitReport } from "./junit.js";

export interface CheckSpec {
  name: string;
  argv: string[];
  reporter: "junit" | "none";
  timeoutSeconds: number;
  junitPath?: string;
}

export interface CheckRunOptions {
  timeoutMs: number;
  concurrency: number;
  rerunFailedOnce?: boolean;
  env?: Record<string, string>;
}

export interface CheckResult {
  name: string;
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
  report: JunitReport | null;
  flaky: string[];
  reran: boolean;
}

export const OUTPUT_TAIL_BYTES = 4096;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface ExecOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

function tailOf(text: string): string {
  return text.length <= OUTPUT_TAIL_BYTES ? text : text.slice(text.length - OUTPUT_TAIL_BYTES);
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

function execArgv(argv: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    if (cmd === undefined) {
      resolve({ exitCode: null, timedOut: false, durationMs: 0, outputTail: "empty argv" });
      return;
    }
    const started = Date.now();
    execFile(
      cmd,
      args,
      { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const combined = `${stdout}${stderr}`;
        if (err === null) {
          resolve({ exitCode: 0, timedOut: false, durationMs, outputTail: tailOf(combined) });
          return;
        }
        const e = err as Error & { code?: number | string; killed?: boolean };
        const exitCode = typeof e.code === "number" ? e.code : null;
        const timedOut = e.killed === true;
        const source = combined.length > 0 ? combined : e.message;
        resolve({ exitCode, timedOut, durationMs, outputTail: tailOf(source) });
      },
    );
  });
}

async function runAttempt(
  ws: Workspace,
  check: CheckSpec,
  junitFile: string | null,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ exec: ExecOutcome; report: JunitReport | null }> {
  if (junitFile !== null) await rm(junitFile, { force: true });
  const exec = await execArgv(check.argv, ws.path, timeoutMs, env);
  let report: JunitReport | null = null;
  if (junitFile !== null) {
    try {
      report = parseJunit(await readFile(junitFile, "utf8"));
    } catch {
      report = null;
    }
  }
  return { exec, report };
}

async function runOne(ws: Workspace, check: CheckSpec, opts: CheckRunOptions, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const perCheckMs = check.timeoutSeconds > 0 ? check.timeoutSeconds * 1000 : opts.timeoutMs;
  const timeoutMs = Math.min(opts.timeoutMs, perCheckMs);
  const junitFile =
    check.reporter === "junit" && check.junitPath !== undefined
      ? isAbsolute(check.junitPath)
        ? check.junitPath
        : join(ws.path, check.junitPath)
      : null;

  const first = await runAttempt(ws, check, junitFile, timeoutMs, env);
  const result: CheckResult = {
    name: check.name,
    argv: [...check.argv],
    exitCode: first.exec.exitCode,
    timedOut: first.exec.timedOut,
    durationMs: first.exec.durationMs,
    outputTail: first.exec.outputTail,
    report: first.report,
    flaky: [],
    reran: false,
  };

  const failedIds =
    first.report === null
      ? []
      : first.report.cases.filter((c) => c.status === "failed" || c.status === "error").map((c) => c.id);
  if (opts.rerunFailedOnce === true && !first.exec.timedOut && failedIds.length > 0) {
    const second = await runAttempt(ws, check, junitFile, timeoutMs, env);
    result.reran = true;
    result.durationMs += second.exec.durationMs;
    if (second.report !== null) {
      const passedNow = new Set(second.report.cases.filter((c) => c.status === "passed").map((c) => c.id));
      result.flaky = failedIds.filter((id) => passedNow.has(id));
      result.report = second.report;
      result.exitCode = second.exec.exitCode;
      result.timedOut = second.exec.timedOut;
      result.outputTail = second.exec.outputTail;
    }
  }
  return result;
}

export async function runChecks(ws: Workspace, checks: CheckSpec[], opts: CheckRunOptions): Promise<CheckResult[]> {
  const semaphore = new Semaphore(Math.max(1, Math.floor(opts.concurrency)));
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}), CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  return Promise.all(
    checks.map(async (check) => {
      const release = await semaphore.acquire();
      try {
        return await runOne(ws, check, opts, env);
      } finally {
        release();
      }
    }),
  );
}
