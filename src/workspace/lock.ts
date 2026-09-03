// src/workspace/lock.ts — per-repo mutual exclusion for host git writes and setup commands (spec §5.9).
// mkdir(2) is atomic, so the lock directory is the lease; owner.json records the holder for stale takeover.
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const REPO_LOCK_DIRNAME = "pi-sdlc-factory.lock";
export const REPO_LOCK_OWNER_FILE = "owner.json";

export interface RepoLockOptions {
  /** Give up with RepoLockTimeoutError after this long. Must be >= the longest expected hold. */
  timeoutMs: number;
  /** A lock whose owner pid is dead (or unreadable) is only taken over once it is this old. Default 180 000 ms. */
  staleMs?: number;
  /** Base poll interval; each wait sleeps pollMs + random(0..pollMs). Default 100 ms. */
  pollMs?: number;
}

export interface RepoLockOwner {
  pid: number;
  at: string;
}

export class RepoLockTimeoutError extends Error {
  readonly code = "repo-lock-timeout" as const;
  constructor(readonly lockDir: string, readonly timeoutMs: number, readonly owner: RepoLockOwner | null) {
    super(`repo lock ${lockDir} not acquired within ${timeoutMs} ms` + (owner ? ` (held by pid ${owner.pid} since ${owner.at})` : ""));
    this.name = "RepoLockTimeoutError";
  }
}

export function lockDirFor(gitCommonDir: string): string {
  return path.join(gitCommonDir, REPO_LOCK_DIRNAME);
}

/** Only ESRCH means "no such process"; EPERM means it exists but belongs to another user. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readOwner(lockDir: string): Promise<RepoLockOwner | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(lockDir, REPO_LOCK_OWNER_FILE), "utf8")) as Partial<RepoLockOwner>;
    if (typeof raw.pid !== "number" || typeof raw.at !== "string") return null;
    return { pid: raw.pid, at: raw.at };
  } catch {
    return null;
  }
}

async function lockAgeMs(lockDir: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(lockDir)).mtimeMs;
  } catch {
    return null;
  }
}

async function tryAcquire(lockDir: string): Promise<boolean> {
  try {
    await mkdir(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  const owner: RepoLockOwner = { pid: process.pid, at: new Date().toISOString() };
  await writeFile(path.join(lockDir, REPO_LOCK_OWNER_FILE), JSON.stringify(owner));
  return true;
}

async function release(lockDir: string): Promise<void> {
  await rm(lockDir, { recursive: true, force: true });
}

/** Atomically moves the stale lock aside before deleting it, so two waiters cannot delete each other's fresh lock. */
async function takeOver(lockDir: string): Promise<void> {
  const graveyard = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockDir, graveyard);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await rm(graveyard, { recursive: true, force: true });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRepoLock<T>(gitCommonDir: string, fn: () => Promise<T>, opts: RepoLockOptions): Promise<T> {
  const staleMs = opts.staleMs ?? 180_000;
  const pollMs = opts.pollMs ?? 100;
  const lockDir = lockDirFor(gitCommonDir);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await tryAcquire(lockDir)) {
      try {
        return await fn();
      } finally {
        await release(lockDir);
      }
    }
    const owner = await readOwner(lockDir);
    const age = await lockAgeMs(lockDir);
    const ownerDead = owner === null || !isPidAlive(owner.pid);
    if (age !== null && age >= staleMs && ownerDead) {
      await takeOver(lockDir);
      continue;
    }
    if (Date.now() >= deadline) throw new RepoLockTimeoutError(lockDir, opts.timeoutMs, owner);
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
  }
}
