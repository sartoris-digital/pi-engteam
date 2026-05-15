import { spawn } from "child_process";

// Default timeout for UseSecret-spawned commands. Codex round-3 HIGH: a
// hanging command (e.g. `sleep 999999`, or a network call to an unreachable
// host) used to outlive the agent because we had no timeout. Five minutes
// is generous for real secret-bearing operations (gh auth, terraform apply
// fragments) and bounds the orphan window deterministically.
const DEFAULT_SPAWN_TIMEOUT_MS = 5 * 60 * 1000;
// Grace window between SIGTERM and SIGKILL when we time out a child.
const KILL_GRACE_MS = 5_000;

export async function defaultSpawn(opts: {
  cmd: string;
  env: Record<string, string>;
  cwd?: string;
  /** Override timeout in milliseconds. Falls back to DEFAULT_SPAWN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Caller-supplied abort signal — fires the same TERM/KILL escalation. */
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...opts.env,
    };

    // detached:true puts the child in its own process group so we can kill
    // the whole group with kill(-pid). Without this a command like
    // `bash -c 'sleep 999 & wait'` would leave the inner `sleep` running
    // when only the bash wrapper was signaled.
    const child = spawn(opts.cmd, {
      shell: true,
      cwd: opts.cwd,
      env,
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* already dead */ }
      }
    };

    const escalate = () => {
      killGroup("SIGTERM");
      sigkillTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
    killTimer = setTimeout(escalate, timeoutMs);

    const abortHandler = () => { if (!settled) escalate(); };
    opts.signal?.addEventListener("abort", abortHandler);

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      opts.signal?.removeEventListener("abort", abortHandler);
    };

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (sig) {
        reject(new Error(`Secret-bearing command terminated by signal ${sig} (timeout or abort).`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
