// src/safety/approval-lease.ts
//
// PLAN.md ApprovalWatcher Phase 4 — cross-process ownership lease.
//
// Every watcher operation (drain, dispatch, retry, quarantine) holds
// the per-run lease so two controllers booting against the same runs
// dir cannot interleave state mutations. Lease primitive layered as:
//
//   `<run>/.approval-watcher.lease`          — JSON metadata (owner)
//   `<run>/.approval-watcher.lease.lock/`    — mkdir-based acquire
//   `<run>/.approval-watcher.lease.lock/owner.json` — written ONLY by
//     the successful mkdir caller (PLAN.md round-A8 HIGH 1)
//
// Stale recovery TWO paths:
//   - same-host PID-death: `process.kill(pid, 0)` says ESRCH AND
//     renewedAt > 180s old → take over immediately.
//   - cross-host or unverifiable PID: renewedAt > 600s old → take over.
//
// Contender protocol when mkdir(lock) returns EEXIST:
//   - lstat owner.json. If absent: wait 250ms grace, re-lstat. Still
//     absent → assume mid-acquire crash; force-remove lock dir; retry.
//   - If present: parse, apply staleness check (above). Stale →
//     force-remove + retry. Fresh → back off with jitter.
//
// Contenders NEVER write owner.json. Only the successful mkdir caller
// owns the lock dir's contents.

import { mkdir, writeFile, readFile, unlink, rmdir, lstat, stat } from "fs/promises";
import { join } from "path";
import { hostname } from "os";
import { randomBytes } from "crypto";

const LEASE_FILE = ".approval-watcher.lease";
const LOCK_DIR = ".approval-watcher.lease.lock";
const OWNER_FILE = "owner.json";

const SAME_HOST_STALE_MS = 180_000;
const CROSS_HOST_STALE_MS = 600_000;
const LOCK_OWNER_GRACE_MS = 250;
const LEASE_RENEW_INTERVAL_MS = 60_000;
const ACQUIRE_MAX_WAIT_MS = 5_000;
const ACQUIRE_POLL_JITTER_MS = 50;

export type LeaseOwner = {
  pid: number;
  hostname: string;
  instanceId: string;
  acquiredAt: string;
  renewedAt: string;
};

export type LeaseHandle = {
  runDir: string;
  owner: LeaseOwner;
  renewTimer?: NodeJS.Timeout;
};

export type AcquireResult =
  | { ok: true; handle: LeaseHandle }
  | { ok: false; reason: "held-by-live-owner" | "acquire-timeout" | "fs-error"; heldBy?: LeaseOwner; detail?: string };

function newInstanceId(): string {
  return randomBytes(8).toString("hex");
}

function leasePaths(runDir: string): { leaseFile: string; lockDir: string; ownerFile: string } {
  return {
    leaseFile: join(runDir, LEASE_FILE),
    lockDir: join(runDir, LOCK_DIR),
    ownerFile: join(runDir, LOCK_DIR, OWNER_FILE),
  };
}

async function readOwnerJson(ownerPath: string): Promise<LeaseOwner | null> {
  try {
    const raw = await readFile(ownerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LeaseOwner>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.instanceId !== "string" ||
      typeof parsed.acquiredAt !== "string" ||
      typeof parsed.renewedAt !== "string"
    ) {
      return null;
    }
    return parsed as LeaseOwner;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true; // process exists but we can't signal it
    return false;
  }
}

function isOwnerStale(owner: LeaseOwner): boolean {
  const now = Date.now();
  const ageMs = now - Date.parse(owner.renewedAt);
  if (!Number.isFinite(ageMs)) return true; // unparseable timestamp = stale
  // Same-host fast path
  if (owner.hostname === hostname()) {
    if (ageMs > SAME_HOST_STALE_MS && !isPidAlive(owner.pid)) return true;
  }
  // Cross-host or unverifiable PID
  return ageMs > CROSS_HOST_STALE_MS;
}

async function forceRemoveLock(lockDir: string, ownerPath: string): Promise<void> {
  try { await unlink(ownerPath); } catch { /* may not exist */ }
  try { await rmdir(lockDir); } catch { /* may be already gone */ }
}

async function tryAcquireOnce(runDir: string): Promise<AcquireResult> {
  const { leaseFile, lockDir, ownerFile } = leasePaths(runDir);
  // Step 1: mkdir(lock). Atomic; either we get it or another caller has it.
  try {
    await mkdir(lockDir, { mode: 0o700 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") {
      return { ok: false, reason: "fs-error", detail: e.message };
    }
    // Contender path — DO NOT write owner.json. Read it (with grace).
    let existingOwner = await readOwnerJson(ownerFile);
    if (!existingOwner) {
      await new Promise((r) => setTimeout(r, LOCK_OWNER_GRACE_MS));
      existingOwner = await readOwnerJson(ownerFile);
    }
    if (!existingOwner) {
      // No owner metadata after grace → mid-acquire crash. Force-remove.
      await forceRemoveLock(lockDir, ownerFile);
      return { ok: false, reason: "held-by-live-owner", detail: "stale-mid-acquire" };
    }
    if (isOwnerStale(existingOwner)) {
      await forceRemoveLock(lockDir, ownerFile);
      return { ok: false, reason: "held-by-live-owner", heldBy: existingOwner, detail: "stale-recovered" };
    }
    return { ok: false, reason: "held-by-live-owner", heldBy: existingOwner };
  }

  // Step 2: we won the mkdir. Write owner.json INSIDE the lock dir so
  // contenders can read it. PLAN.md round-A8 HIGH 1: ONLY the successful
  // mkdir caller writes owner.json. Contenders are read-only.
  const owner: LeaseOwner = {
    pid: process.pid,
    hostname: hostname(),
    instanceId: newInstanceId(),
    acquiredAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
  };
  try {
    await writeFile(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  } catch (err) {
    // Write failed — back out the lock so we don't wedge.
    await forceRemoveLock(lockDir, ownerFile);
    return { ok: false, reason: "fs-error", detail: (err as Error).message };
  }

  // Step 3: write the actual lease file (outside the lock dir) so other
  // observers can see the current owner without entering the lock dir.
  try {
    await writeFile(leaseFile, JSON.stringify(owner), { mode: 0o600 });
  } catch (err) {
    await forceRemoveLock(lockDir, ownerFile);
    return { ok: false, reason: "fs-error", detail: (err as Error).message };
  }

  return { ok: true, handle: { runDir, owner } };
}

/**
 * Acquire the per-run lease with retries up to ACQUIRE_MAX_WAIT_MS.
 * Returns the handle on success. Callers must call `releaseLease(handle)`
 * when done (or rely on `startLeaseRenewal` which handles auto-release
 * on stop).
 */
export async function acquireLease(runDir: string): Promise<AcquireResult> {
  const start = Date.now();
  let lastHeldBy: LeaseOwner | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await tryAcquireOnce(runDir);
    if (result.ok) return result;
    if (result.reason === "fs-error") return result;
    lastHeldBy = result.heldBy;
    if (Date.now() - start > ACQUIRE_MAX_WAIT_MS) {
      return { ok: false, reason: "acquire-timeout", heldBy: lastHeldBy };
    }
    // Back off with jitter to avoid thundering herd.
    const jitter = ACQUIRE_POLL_JITTER_MS + Math.floor(Math.random() * ACQUIRE_POLL_JITTER_MS);
    await new Promise((r) => setTimeout(r, jitter));
  }
}

/**
 * Renew the lease — bump renewedAt timestamp. Called every
 * LEASE_RENEW_INTERVAL_MS by startLeaseRenewal. Idempotent.
 */
export async function renewLease(handle: LeaseHandle): Promise<void> {
  handle.owner.renewedAt = new Date().toISOString();
  const { leaseFile, ownerFile } = leasePaths(handle.runDir);
  // Single-writer file writes (we hold the lock dir + lease file).
  // No atomic-rename needed for the renewedAt bump since the field is
  // monotonic and a torn write would just be re-applied next renewal.
  try {
    const payload = JSON.stringify(handle.owner);
    await writeFile(leaseFile, payload, { mode: 0o600 });
    await writeFile(ownerFile, payload, { mode: 0o600 });
  } catch {
    // Best-effort. A failed renewal will eventually look stale to
    // contenders, who will steal the lease — which is the correct
    // outcome if our process is genuinely unhealthy.
  }
}

/**
 * Start an interval timer that calls renewLease every 60s.
 * Returns the same handle with `renewTimer` populated; call
 * releaseLease(handle) to clear the timer AND release the lease.
 */
export function startLeaseRenewal(handle: LeaseHandle): LeaseHandle {
  handle.renewTimer = setInterval(() => {
    void renewLease(handle);
  }, LEASE_RENEW_INTERVAL_MS);
  // Don't keep the event loop alive just for the renewer
  handle.renewTimer.unref?.();
  return handle;
}

/**
 * Release the lease — stop the renew timer, unlink the lease file,
 * remove the lock dir. Safe to call multiple times.
 */
export async function releaseLease(handle: LeaseHandle): Promise<void> {
  if (handle.renewTimer) {
    clearInterval(handle.renewTimer);
    handle.renewTimer = undefined;
  }
  const { leaseFile, lockDir, ownerFile } = leasePaths(handle.runDir);
  try { await unlink(leaseFile); } catch { /* may not exist */ }
  try { await unlink(ownerFile); } catch { /* may not exist */ }
  try { await rmdir(lockDir); } catch { /* may not exist */ }
}

/**
 * Read the current lease owner (read-only; for /approval-status).
 * Returns null if no lease exists or it's malformed.
 */
export async function readLeaseOwner(runDir: string): Promise<LeaseOwner | null> {
  const { leaseFile } = leasePaths(runDir);
  try {
    const raw = await readFile(leaseFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<LeaseOwner>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.instanceId !== "string" ||
      typeof parsed.acquiredAt !== "string" ||
      typeof parsed.renewedAt !== "string"
    ) {
      return null;
    }
    return parsed as LeaseOwner;
  } catch {
    return null;
  }
}

/**
 * Test surface — internal helpers exposed for unit testing only.
 * Production code should not import from `__test`.
 */
export const __test = { isOwnerStale, isPidAlive, leasePaths, tryAcquireOnce };
