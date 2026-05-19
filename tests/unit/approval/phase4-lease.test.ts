// tests/unit/approval/phase4-lease.test.ts
//
// PLAN.md ApprovalWatcher Phase 4 — cross-process ownership lease tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("ApprovalWatcher Phase 4 — acquireLease basic flow", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "approval-lease-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("fresh run dir: acquireLease returns ok with handle", async () => {
    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const result = await acquireLease(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handle.owner.pid).toBe(process.pid);
    expect(result.handle.owner.instanceId).toMatch(/^[0-9a-f]{16}$/);
    expect(Number.isFinite(Date.parse(result.handle.owner.acquiredAt))).toBe(true);
    await releaseLease(result.handle);
  });

  it("lease file is written at 0o600", async () => {
    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const result = await acquireLease(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaseFile = join(runDir, ".approval-watcher.lease");
    const st = await stat(leaseFile);
    expect(st.mode & 0o777).toBe(0o600);
    await releaseLease(result.handle);
  });

  it("releaseLease removes lease file + lock dir", async () => {
    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const result = await acquireLease(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await releaseLease(result.handle);
    await expect(stat(join(runDir, ".approval-watcher.lease"))).rejects.toThrow();
    await expect(stat(join(runDir, ".approval-watcher.lease.lock"))).rejects.toThrow();
  });

  it("releaseLease is idempotent", async () => {
    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const result = await acquireLease(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await releaseLease(result.handle);
    await expect(releaseLease(result.handle)).resolves.toBeUndefined();
  });
});

describe("ApprovalWatcher Phase 4 — contender protocol", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "approval-lease-contend-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("second acquireLease blocks when first is still live", async () => {
    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const first = await acquireLease(runDir);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second attempt should time out (5s budget). Use a short-circuit
    // approach: spawn the acquire and check its result quickly via the
    // tryAcquireOnce internal.
    const { __test } = await import("../../../src/safety/approval-lease.js");
    const result = await __test.tryAcquireOnce(runDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("held-by-live-owner");
    expect(result.heldBy?.pid).toBe(process.pid);

    await releaseLease(first.handle);
  });

  it("after release, a fresh acquire succeeds", async () => {
    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const first = await acquireLease(runDir);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await releaseLease(first.handle);

    const second = await acquireLease(runDir);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await releaseLease(second.handle);
  });

  it("orphan lock dir (no owner.json) gets force-removed", async () => {
    // Simulate a mid-acquire crash: lock dir exists but no owner.json.
    const lockDir = join(runDir, ".approval-watcher.lease.lock");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    // No owner.json inside.

    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const result = await acquireLease(runDir);
    // Should eventually succeed: contender sees EEXIST, lstat owner
    // returns absent, waits grace, lstat again still absent, force-
    // removes the lock dir, retries successfully.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await releaseLease(result.handle);
  });
});

describe("ApprovalWatcher Phase 4 — stale recovery", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "approval-lease-stale-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("isOwnerStale: fresh owner is not stale", async () => {
    const { __test } = await import("../../../src/safety/approval-lease.js");
    const fresh = {
      pid: process.pid,
      hostname: require("os").hostname(),
      instanceId: "deadbeef00000000",
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
    };
    expect(__test.isOwnerStale(fresh)).toBe(false);
  });

  it("isOwnerStale: same-host with dead PID and old renewedAt is stale", async () => {
    const { __test } = await import("../../../src/safety/approval-lease.js");
    const stale = {
      pid: 99999999, // very unlikely to be live
      hostname: require("os").hostname(),
      instanceId: "deadbeef00000000",
      acquiredAt: new Date(Date.now() - 600_000).toISOString(),
      renewedAt: new Date(Date.now() - 300_000).toISOString(), // 5min old
    };
    expect(__test.isOwnerStale(stale)).toBe(true);
  });

  it("isOwnerStale: cross-host with renewedAt > 600s is stale", async () => {
    const { __test } = await import("../../../src/safety/approval-lease.js");
    const stale = {
      pid: process.pid,
      hostname: "different-host-name-xyz",
      instanceId: "deadbeef00000000",
      acquiredAt: new Date(Date.now() - 700_000).toISOString(),
      renewedAt: new Date(Date.now() - 700_000).toISOString(), // 11min old
    };
    expect(__test.isOwnerStale(stale)).toBe(true);
  });

  it("isOwnerStale: cross-host within 600s is NOT stale", async () => {
    const { __test } = await import("../../../src/safety/approval-lease.js");
    const fresh = {
      pid: process.pid,
      hostname: "different-host-name-xyz",
      instanceId: "deadbeef00000000",
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      renewedAt: new Date(Date.now() - 60_000).toISOString(), // 1min old
    };
    expect(__test.isOwnerStale(fresh)).toBe(false);
  });

  it("isOwnerStale: unparseable renewedAt counts as stale", async () => {
    const { __test } = await import("../../../src/safety/approval-lease.js");
    const garbage = {
      pid: process.pid,
      hostname: require("os").hostname(),
      instanceId: "x",
      acquiredAt: "garbage",
      renewedAt: "also-garbage",
    };
    expect(__test.isOwnerStale(garbage)).toBe(true);
  });

  it("acquire steals a stale lock", async () => {
    const { acquireLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    // Plant a stale lock: lock dir + owner.json with dead PID + old renewedAt.
    const lockDir = join(runDir, ".approval-watcher.lease.lock");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    const staleOwner = {
      pid: 99999999, // dead
      hostname: require("os").hostname(),
      instanceId: "deadbeef00000000",
      acquiredAt: new Date(Date.now() - 600_000).toISOString(),
      renewedAt: new Date(Date.now() - 300_000).toISOString(),
    };
    await writeFile(join(lockDir, "owner.json"), JSON.stringify(staleOwner), { mode: 0o600 });

    const result = await acquireLease(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handle.owner.pid).toBe(process.pid);
    await releaseLease(result.handle);
  });
});

describe("ApprovalWatcher Phase 4 — renew + readLeaseOwner", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "approval-lease-renew-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("renewLease bumps renewedAt", async () => {
    const { acquireLease, renewLease, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const result = await acquireLease(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = result.handle.owner.renewedAt;
    await new Promise((r) => setTimeout(r, 10));
    await renewLease(result.handle);
    expect(result.handle.owner.renewedAt).not.toBe(before);
    expect(Date.parse(result.handle.owner.renewedAt)).toBeGreaterThan(Date.parse(before));
    await releaseLease(result.handle);
  });

  it("readLeaseOwner returns the current owner", async () => {
    const { acquireLease, readLeaseOwner, releaseLease } = await import("../../../src/safety/approval-lease.js");
    const result = await acquireLease(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const owner = await readLeaseOwner(runDir);
    expect(owner).not.toBeNull();
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.instanceId).toBe(result.handle.owner.instanceId);
    await releaseLease(result.handle);
  });

  it("readLeaseOwner returns null when no lease exists", async () => {
    const { readLeaseOwner } = await import("../../../src/safety/approval-lease.js");
    const owner = await readLeaseOwner(runDir);
    expect(owner).toBeNull();
  });
});
