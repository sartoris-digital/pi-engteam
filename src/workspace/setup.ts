// src/workspace/setup.ts — post-create dependency install (spec §5.5 step 3). Fail-closed: any failure
// is an env-setup-failed escalation before a single token is spent.
import { spawn } from "node:child_process";
import type { EffectiveRepoConfig } from "../config/schema.js";
import { withRepoLock } from "./lock.js";
import type { Workspace } from "./types.js";

export interface SetupResult {
  ran: boolean;
  argv: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export interface RunSetupOptions {
  timeoutMs: number;
  env?: Record<string, string>;
  /** Repo lock wait (default timeoutMs + 60 000). */
  lockTimeoutMs?: number;
}

export class EnvSetupFailedError extends Error {
  readonly code = "env-setup-failed" as const;
  constructor(readonly detail: string, readonly result: SetupResult) {
    super(`env-setup-failed: ${detail}`);
    this.name = "EnvSetupFailedError";
  }
}

const SCRIPT_RUNNERS = new Set(["npm", "pnpm"]);
const TAIL_CHARS = 4096;

/** Argv to run, or null when the repo declares no setup command. */
export function setupArgv(cfg: Pick<EffectiveRepoConfig, "setupCommand" | "allowInstallScripts">): string[] | null {
  const cmd = cfg.setupCommand;
  if (!cmd || cmd.length === 0) return null;
  const argv = [...cmd];
  const bin = argv[0] ?? "";
  if (SCRIPT_RUNNERS.has(bin) && !cfg.allowInstallScripts && !argv.includes("--ignore-scripts")) argv.push("--ignore-scripts");
  return argv;
}

function tail(s: string): string {
  return s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s;
}

function runProcess(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<SetupResult> {
  const started = Date.now();
  const [bin, ...rest] = argv;
  if (bin === undefined) throw new Error("runProcess: empty argv");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { out = tail(out + d.toString("utf8")); });
    child.stderr?.on("data", (d: Buffer) => { out = tail(out + d.toString("utf8")); });
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ ran: true, argv, code, signal, timedOut, durationMs: Date.now() - started, outputTail: out });
    });
  });
}

/** Runs the repo's setupCommand inside the worktree under the repo lock. */
export async function runSetupCommand(ws: Workspace, cfg: EffectiveRepoConfig, opts: RunSetupOptions): Promise<SetupResult> {
  const argv = setupArgv(cfg);
  if (argv === null) return { ran: false, argv: [], code: 0, signal: null, timedOut: false, durationMs: 0, outputTail: "" };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { CI: "1", GIT_TERMINAL_PROMPT: "0" }, opts.env ?? {});

  let result: SetupResult;
  try {
    result = await withRepoLock(ws.gitCommonDir, () => runProcess(argv, ws.path, env, opts.timeoutMs), {
      timeoutMs: opts.lockTimeoutMs ?? opts.timeoutMs + 60_000,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const empty: SetupResult = { ran: true, argv, code: null, signal: null, timedOut: false, durationMs: 0, outputTail: "" };
    throw new EnvSetupFailedError(`cannot run ${argv.join(" ")}: ${e.code ?? e.message}`, empty);
  }
  if (result.timedOut) throw new EnvSetupFailedError(`${argv.join(" ")} timed out after ${opts.timeoutMs} ms`, result);
  if (result.code !== 0) throw new EnvSetupFailedError(`${argv.join(" ")} exited ${result.code ?? `by signal ${result.signal ?? "?"}`}`, result);
  return result;
}
