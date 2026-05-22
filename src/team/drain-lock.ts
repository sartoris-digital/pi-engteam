// Phase E item E6: drain lock for coordinated rollback.
//
// Provides an atomic try-lock backed by a JSON file containing
// `{ pid, ts }`. The lock is acquired via O_CREAT|O_EXCL so two
// concurrent callers can never both succeed.
//
// Stale locks (owner process is no longer running) are reclaimed
// automatically on the next acquire attempt.
//
// Falls back to /var/tmp/pi-eng-rollback.lock when configDir is
// unwritable (e.g. read-only NFS mount during a broken install).
import { openSync, writeSync, closeSync, unlinkSync, readFileSync, constants } from "fs";
import { join } from "path";

const { O_CREAT, O_EXCL, O_WRONLY } = constants;

const LOCK_FILENAME = ".rollback.lock";
const FALLBACK_LOCK = "/var/tmp/pi-eng-rollback.lock";

export type DrainLockHandle = {
  release(): void;
  lockPath: string;
};

type LockPayload = { pid: number; ts: string };

/** Resolve the lock path, preferring configDir but falling back when unwritable. */
function resolveLockPath(configDir: string): string {
  // Use a separate probe file to test writability — never touch the real lock file.
  const probe = join(configDir, ".rollback.lock.probe");
  try {
    const fd = openSync(probe, O_CREAT | O_WRONLY, 0o600);
    closeSync(fd);
    try { unlinkSync(probe); } catch { /* ignore */ }
    return join(configDir, LOCK_FILENAME);
  } catch {
    return FALLBACK_LOCK;
  }
}

/** Return true when a pid is no longer alive on this OS. */
function isDeadPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false; // signal delivered → process exists
  } catch (e: unknown) {
    // ESRCH → process not found; EPERM → exists but not ours (treat as alive)
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Acquire the drain lock. Returns a handle on success, throws on failure.
 * Stale locks (dead owner pid) are reclaimed once.
 */
export function acquireDrainLock(configDir: string): DrainLockHandle {
  const lockPath = resolveLockPath(configDir);
  return acquireAt(lockPath, /* retrying */ false);
}

function acquireAt(lockPath: string, retrying: boolean): DrainLockHandle {
  let fd: number;
  try {
    fd = openSync(lockPath, O_CREAT | O_EXCL | O_WRONLY, 0o600);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      // Lock is held. Check for staleness if not already retrying.
      if (!retrying) {
        const existing = readLockPayload(lockPath);
        if (existing && isDeadPid(existing.pid)) {
          // Stale lock — safe to unlink and retry once.
          try { unlinkSync(lockPath); } catch { /* lost race; fall through */ }
          return acquireAt(lockPath, /* retrying */ true);
        }
      }
      const pid = readLockPayload(lockPath)?.pid;
      const msg = pid
        ? `drain lock already held by pid ${pid} at ${lockPath}`
        : `drain lock already held at ${lockPath}`;
      const conflict = new Error(msg) as NodeJS.ErrnoException;
      conflict.code = "EEXIST";
      throw conflict;
    }
    throw e;
  }

  const payload: LockPayload = { pid: process.pid, ts: new Date().toISOString() };
  const data = JSON.stringify(payload);
  writeSync(fd, data);
  closeSync(fd);

  return {
    lockPath,
    release() {
      try { unlinkSync(lockPath); } catch { /* already gone; that's fine */ }
    },
  };
}

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === "number"
    ) {
      return parsed as LockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether the drain lock is currently held by another process.
 * Returns `{ held: false }` when no lock file exists or the file is stale.
 */
export function checkDrainLock(configDir: string): { held: boolean; byPid?: number; since?: string } {
  const lockPath = join(configDir, LOCK_FILENAME);
  const payload = readLockPayload(lockPath);
  if (!payload) {
    // Also check fallback location.
    const fallback = readLockPayload(FALLBACK_LOCK);
    if (!fallback) return { held: false };
    if (isDeadPid(fallback.pid)) return { held: false };
    return { held: true, byPid: fallback.pid, since: fallback.ts };
  }
  if (isDeadPid(payload.pid)) return { held: false };
  return { held: true, byPid: payload.pid, since: payload.ts };
}

/**
 * Throws if the drain lock is currently held.
 * Call this at the top of every CLI/server spawn path.
 */
export function assertNoDrainLock(configDir: string): void {
  const status = checkDrainLock(configDir);
  if (status.held) {
    const detail = status.byPid ? ` by pid ${status.byPid}` : "";
    throw new Error(`rollback in progress${detail} — retry after rollback completes`);
  }
}
