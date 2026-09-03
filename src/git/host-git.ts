// src/git/host-git.ts — the only way the controller runs git (spec §5.9).
// Hooks, fsmonitor, pagers, external diff and credential helpers are disabled per invocation;
// prompts are impossible (GIT_TERMINAL_PROMPT=0) and the system config is ignored.
import { execFile } from "node:child_process";

export interface HostGitOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Kill git after this long (default 120 000 ms). */
  timeoutMs?: number;
  /** Back-off schedule for `index.lock` collisions (default [200, 400, 800]). */
  retryDelaysMs?: number[];
  /** Skip the `-c` overrides. Only for `git config` reads whose answer they would mask. */
  noOverrides?: boolean;
}

export interface HostGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class HostGitError extends Error {
  constructor(readonly args: string[], readonly result: HostGitResult) {
    super(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    this.name = "HostGitError";
  }
}

export const HOST_GIT_CONFIG: readonly string[] = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "credential.helper=",
  "-c", "diff.external=",
];

export const HOST_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

const NO_VERIFY_SUBCOMMANDS = new Set(["commit", "push"]);
const DEFAULT_RETRY_DELAYS = [200, 400, 800];
const DEFAULT_TIMEOUT_MS = 120_000;

/** argv after the `git` executable: overrides + args, with --no-verify forced on commit/push. */
export function buildHostGitArgv(args: readonly string[], noOverrides = false): string[] {
  const prefix = noOverrides ? [] : [...HOST_GIT_CONFIG];
  const out = [...prefix, ...args];
  const sub = args[0];
  if (sub !== undefined && NO_VERIFY_SUBCOMMANDS.has(sub) && !args.includes("--no-verify")) {
    out.splice(prefix.length + 1, 0, "--no-verify");
  }
  return out;
}

export function hostGitEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  return { ...base, ...HOST_GIT_ENV, ...(extra ?? {}) };
}

function runOnce(argv: string[], opts: HostGitOptions): Promise<HostGitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      argv,
      { cwd: opts.cwd, env: hostGitEnv(opts.env), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (typeof e.code === "string") return reject(e); // spawn failure: ENOENT, EACCES
        const code = typeof e.code === "number" ? e.code : -1;
        const killed = e.killed === true ? `\n[hostGit] killed by ${e.signal ?? "signal"} after ${timeoutMs} ms` : "";
        resolve({ stdout, stderr: stderr + killed, code });
      },
    );
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs git hook-free. Resolves with the exit code; rejects only when git itself cannot be spawned. */
export async function hostGit(args: readonly string[], opts: HostGitOptions): Promise<HostGitResult> {
  const argv = buildHostGitArgv(args, opts.noOverrides === true);
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  let result = await runOnce(argv, opts);
  for (const delay of delays) {
    if (result.code === 0 || !/index\.lock/.test(result.stderr)) break;
    await sleep(delay);
    result = await runOnce(argv, opts);
  }
  return result;
}

/** Like hostGit but throws HostGitError on a non-zero exit and returns trimmed stdout. */
export async function hostGitOk(args: readonly string[], opts: HostGitOptions): Promise<string> {
  const result = await hostGit(args, opts);
  if (result.code !== 0) throw new HostGitError([...args], result);
  return result.stdout.trim();
}
