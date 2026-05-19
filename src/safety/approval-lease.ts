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
// Contender protocol when mkdir(lock) returns EEXIST (Phase 4 review
// round-1 HIGH 2 + round-2 HIGH 2):
//   - Read owner.json with a TYPED result: ok / absent / malformed /
//     read-error. Only confirmed "absent" + lock dir older than the
//     LOCK_DIR_MIN_AGE_MS threshold counts as a mid-acquire crash.
//   - malformed or read-error → refuse to steal; assume live owner
//     with transient metadata trouble.
//   - ok → apply staleness check.
//
// Successor protection (Phase 4 review round-1 HIGH 1 + round-2 HIGH):
// renewLease and releaseLease check the on-disk owner.instanceId
// against the in-memory handle before mutating disk. A handle whose
// lease has been stolen via stale recovery is a NO-OP on renew/release;
// the renew timer is cleared so the orphan stops touching disk.
//
// Contenders NEVER write owner.json. Only the successful mkdir caller
// owns the lock dir's contents.

import { mkdir, writeFile, readFile, unlink, rmdir, stat } from "fs/promises";
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
// Phase 4 review round-1 HIGH 2: minimum age of a lock dir before
// "owner.json absent after grace" counts as a mid-acquire crash. The
// grace alone (250ms) is too short for a slow mkdir+writeFile sequence
// under disk contention or fork delay; 1500ms gives generous headroom
// while still bounding the wait. Stale recovery via owner-present-but-
// stale is unaffected — this only protects the no-owner.json window.
const LOCK_DIR_MIN_AGE_MS = 1_500;
// Phase 4 review round-1 MEDIUM: a clock-skewed owner writing a
// future renewedAt makes age go negative and permanently bypasses the
// stale checks. Clamp negative ages to 0; large future skews (>5s) are
// treated as "not stale yet" so the cross-host TTL eventually catches
// genuinely wedged leases.
const FUTURE_SKEW_TOLERANCE_MS = 5_000;

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

// Phase 4 review round-2 HIGH 2: distinguish ENOENT from unreadable
// or schema-invalid content. Collapsing these into "null" caused the
// contender protocol to steal locks whose owner had transient parse
// trouble.
type OwnerReadResult =
  | { kind: "ok"; owner: LeaseOwner }
  | { kind: "absent" }
  | { kind: "malformed"; detail: string }
  | { kind: "read-error"; detail: string };

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

async function readOwnerJson(ownerPath: string): Promise<OwnerReadResult> {
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { kind: "absent" };
    return { kind: "read-error", detail: e.message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "malformed", detail: (err as Error).message };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "malformed", detail: "owner is not an object" };
  const p = parsed as Partial<LeaseOwner>;
  if (
    typeof p.pid !== "number" ||
    typeof p.hostname !== "string" ||
    typeof p.instanceId !== "string" ||
    typeof p.acquiredAt !== "string" ||
    typeof p.renewedAt !== "string"
  ) {
    return { kind: "malformed", detail: "owner missing required fields" };
  }
  return { kind: "ok", owner: p as LeaseOwner };
}

async function lockDirAgeMs(lockDir: string): Promise<number | null> {
  try {
    const st = await stat(lockDir);
    return Date.now() - st.mtimeMs;
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
  const parsedTime = Date.parse(owner.renewedAt);
  if (!Number.isFinite(parsedTime)) return true; // unparseable timestamp = stale
  let ageMs = now - parsedTime;
  if (ageMs < 0) {
    // Phase 4 review round-1 MEDIUM: future-skewed renewedAt. A small
    // skew (<5s) is benign; a large negative age is treated as fresh
    // (not stale) so we don't wrongly steal a lease from a peer with a
    // forward-set clock. The cross-host TTL will catch genuinely
    // wedged leases at the 600s ceiling.
    if (-ageMs > FUTURE_SKEW_TOLERANCE_MS) return false;
    ageMs = 0;
  }
  // Same-host fast path: PID-death + age > 180s.
  if (owner.hostname === hostname()) {
    if (ageMs > SAME_HOST_STALE_MS && !isPidAlive(owner.pid)) return true;
  }
  // Cross-host or unverifiable PID.
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
    // Contender path — read owner.json with typed result. NEVER write
    // owner.json here (round-A8 HIGH 1).
    const first = await readOwnerJson(ownerFile);
    if (first.kind === "ok") {
      if (isOwnerStale(first.owner)) {
        await forceRemoveLock(lockDir, ownerFile);
        return { ok: false, reason: "held-by-live-owner", heldBy: first.owner, detail: "stale-recovered" };
      }
      return { ok: false, reason: "held-by-live-owner", heldBy: first.owner };
    }
    if (first.kind === "malformed" || first.kind === "read-error") {
      // Live owner with transient metadata trouble — do NOT steal
      // (round-2 HIGH 2). Backoff and let the renewer rewrite.
      return { ok: false, reason: "held-by-live-owner", detail: `owner-${first.kind}` };
    }
    // first.kind === "absent" — wait grace, re-check.
    await new Promise((r) => setTimeout(r, LOCK_OWNER_GRACE_MS));
    const second = await readOwnerJson(ownerFile);
    if (second.kind === "ok") {
      if (isOwnerStale(second.owner)) {
        await forceRemoveLock(lockDir, ownerFile);
        return { ok: false, reason: "held-by-live-owner", heldBy: second.owner, detail: "stale-recovered" };
      }
      return { ok: false, reason: "held-by-live-owner", heldBy: second.owner };
    }
    if (second.kind === "malformed" || second.kind === "read-error") {
      return { ok: false, reason: "held-by-live-owner", detail: `owner-${second.kind}` };
    }
    // Still absent after grace. Apply lock-dir-mtime guard (round-1
    // HIGH 2) before treating as mid-acquire crash — a young lock dir
    // likely belongs to a slow-disk legitimate winner.
    const ageMs = await lockDirAgeMs(lockDir);
    if (ageMs === null || ageMs < LOCK_DIR_MIN_AGE_MS) {
      return { ok: false, reason: "held-by-live-owner", detail: "acquire-in-progress" };
    }
    await forceRemoveLock(lockDir, ownerFile);
    return { ok: false, reason: "held-by-live-owner", detail: "stale-mid-acquire-recovered" };
  }

  // Step 2: we won the mkdir. Write owner.json INSIDE the lock dir so
  // contenders can read it. Round-A8 HIGH 1: ONLY the successful
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
 *
 * NOTE (Phase 4 review round-1 MEDIUM 3): ACQUIRE_MAX_WAIT_MS=5s is
 * intentionally tight for the Phase 4 primitive. Phase 8 wires the
 * watcher core and will introduce a longer wait for the dispatch loop
 * (which holds the lease while a Judge call is in flight). At that
 * point this constant becomes per-caller configurable.
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
 * Renew the lease — bump renewedAt timestamp. Phase 4 review round-1
 * HIGH 1: read on-disk owner.json BEFORE writing. If our handle's
 * instanceId no longer matches the on-disk owner, we lost the lease
 * (taken over by a stale-recovery contender). Stop the renew timer and
 * return without mutating disk. This prevents an orphaned handle from
 * clobbering the successor's lease metadata.
 */
export async function renewLease(handle: LeaseHandle): Promise<void> {
  const { leaseFile, ownerFile } = leasePaths(handle.runDir);
  const current = await readOwnerJson(ownerFile);
  if (current.kind !== "ok" || current.owner.instanceId !== handle.owner.instanceId) {
    // We no longer own the lease — stop renewing.
    if (handle.renewTimer) {
      clearInterval(handle.renewTimer);
      handle.renewTimer = undefined;
    }
    return;
  }
  handle.owner.renewedAt = new Date().toISOString();
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
 *
 * Phase 4 review round-2 HIGH 1: check on-disk owner.instanceId before
 * removing disk state. If a stale-recovery contender has taken over,
 * our handle no longer owns the files — return without touching them
 * so the successor's lease metadata is preserved.
 */
export async function releaseLease(handle: LeaseHandle): Promise<void> {
  if (handle.renewTimer) {
    clearInterval(handle.renewTimer);
    handle.renewTimer = undefined;
  }
  const { leaseFile, lockDir, ownerFile } = leasePaths(handle.runDir);
  const current = await readOwnerJson(ownerFile);
  if (current.kind === "ok" && current.owner.instanceId !== handle.owner.instanceId) {
    // Successor owns the lock — do NOT touch their files.
    return;
  }
  // current is "ok" + matching us, "absent" (already cleaned), or
  // "malformed"/"read-error" — in all those cases proceeding with
  // best-effort unlink is safe (we never delete a successor's files).
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
export const __test = { isOwnerStale, isPidAlive, leasePaths, tryAcquireOnce, readOwnerJson };
