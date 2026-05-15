// src/util/file-lock.ts
// Codex round-2 HIGH: cross-process advisory lock for files that may be
// written by sibling agent subprocesses (e.g. tasks.json under DAG fanout).
//
// Implementation: mkdir is atomic and the kernel rejects EEXIST when the
// directory exists, so it serves as a portable inter-process mutex. We
// also stamp a PID file inside the lock dir so a crashed holder can be
// recovered after a timeout.
//
// This is intentionally minimal and avoids new runtime dependencies.

import { mkdir, readFile, rmdir, unlink, writeFile, stat } from "fs/promises";
import { dirname, join } from "path";

export interface FileLockOptions {
  /** Max time to wait acquiring the lock before throwing. Default 5s. */
  timeoutMs?: number;
  /** Max age of an unrefreshed lock before it's considered stale. Default 30s. */
  staleMs?: number;
  /** Poll interval (with jitter) between acquisition attempts. Default 25ms. */
  pollMs?: number;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_STALE = 30_000;
const DEFAULT_POLL = 25;

async function tryAcquire(lockDir: string): Promise<boolean> {
  try {
    await mkdir(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  // Stamp PID so stale-lock recovery can verify the holder.
  try {
    await writeFile(join(lockDir, "pid"), String(process.pid));
  } catch {
    // best-effort; the dir is already locked
  }
  return true;
}

async function isStale(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const s = await stat(lockDir);
    const age = Date.now() - s.mtimeMs;
    if (age < staleMs) return false;
  } catch {
    return false;
  }
  // Check if PID is alive; if not, lock is dead.
  try {
    const pidStr = await readFile(join(lockDir, "pid"), "utf8");
    const pid = Number.parseInt(pidStr.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        // Process is still alive but unresponsive past staleMs window — defer
        // to it for one more cycle by treating as not-yet-stale.
        return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
      }
    }
  } catch {
    // No pid file → treat as stale.
    return true;
  }
  return true;
}

async function forceRelease(lockDir: string): Promise<void> {
  try { await unlink(join(lockDir, "pid")); } catch { /* may not exist */ }
  try { await rmdir(lockDir); } catch { /* lost the race; another holder will deal */ }
}

export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const staleMs = opts.staleMs ?? DEFAULT_STALE;
  const pollMs = opts.pollMs ?? DEFAULT_POLL;
  const lockDir = target + ".lock";
  // Lock dir's parent must exist or mkdir(lockDir) throws ENOENT. Caller may
  // be locking a not-yet-created file (e.g. first tasks.json write of a run),
  // so create the parent recursively first.
  try { await mkdir(dirname(lockDir), { recursive: true }); } catch { /* race-tolerant */ }
  const start = Date.now();

  while (true) {
    if (await tryAcquire(lockDir)) {
      try {
        return await fn();
      } finally {
        try { await unlink(join(lockDir, "pid")); } catch { /* ignore */ }
        try { await rmdir(lockDir); } catch { /* ignore */ }
      }
    }
    // Lock held — check for staleness and wait/retry.
    if (await isStale(lockDir, staleMs)) {
      await forceRelease(lockDir);
      continue;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out acquiring lock on ${target} after ${timeoutMs}ms`);
    }
    const jitter = pollMs + Math.floor(Math.random() * pollMs);
    await new Promise((r) => setTimeout(r, jitter));
  }
}
