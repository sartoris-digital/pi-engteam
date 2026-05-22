import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireDrainLock, checkDrainLock, assertNoDrainLock } from "../../../src/team/drain-lock.js";

describe("drain-lock", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "pi-drain-lock-test-"));
  });

  // No afterEach cleanup needed: each test uses a fresh tmpdir.

  it("acquireDrainLock creates the lock file containing pid and ts", () => {
    const handle = acquireDrainLock(configDir);
    try {
      expect(existsSync(handle.lockPath)).toBe(true);
      const raw = JSON.parse(
        readFileSync(handle.lockPath, "utf8")
      ) as { pid: number; ts: string };
      expect(raw.pid).toBe(process.pid);
      expect(typeof raw.ts).toBe("string");
      expect(raw.ts).not.toBe("");
    } finally {
      handle.release();
    }
  });

  it("checkDrainLock returns held=true when lock exists with a live pid", () => {
    const handle = acquireDrainLock(configDir);
    try {
      const status = checkDrainLock(configDir);
      expect(status.held).toBe(true);
      expect(status.byPid).toBe(process.pid);
      expect(typeof status.since).toBe("string");
    } finally {
      handle.release();
    }
  });

  it("assertNoDrainLock throws when the lock is held", () => {
    const handle = acquireDrainLock(configDir);
    try {
      expect(() => assertNoDrainLock(configDir)).toThrow(/rollback in progress/);
    } finally {
      handle.release();
    }
  });

  it("release() unlinks the lock file", () => {
    const handle = acquireDrainLock(configDir);
    expect(existsSync(handle.lockPath)).toBe(true);
    handle.release();
    expect(existsSync(handle.lockPath)).toBe(false);
  });

  it("checkDrainLock returns held=false after release", () => {
    const handle = acquireDrainLock(configDir);
    handle.release();
    expect(checkDrainLock(configDir).held).toBe(false);
  });

  it("assertNoDrainLock does not throw when no lock is held", () => {
    expect(() => assertNoDrainLock(configDir)).not.toThrow();
  });

  it("second acquireDrainLock throws when lock is already held", () => {
    const handle = acquireDrainLock(configDir);
    try {
      expect(() => acquireDrainLock(configDir)).toThrow();
    } finally {
      handle.release();
    }
  });

  it("acquireDrainLock reclaims a stale lock (dead pid) and succeeds", () => {
    // Write a lock file with a pid that is certainly not running.
    const lockPath = join(configDir, ".rollback.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, ts: new Date().toISOString() }));

    // Should succeed because pid 99999999 is dead.
    const handle = acquireDrainLock(configDir);
    try {
      expect(existsSync(handle.lockPath)).toBe(true);
      const payload = JSON.parse(
        readFileSync(handle.lockPath, "utf8")
      ) as { pid: number };
      expect(payload.pid).toBe(process.pid);
    } finally {
      handle.release();
    }
  });

  it("cleans up probe file after acquiring lock", () => {
    const probePath = join(configDir, ".rollback.lock.probe");
    const handle = acquireDrainLock(configDir);
    try {
      // Probe should be cleaned up even though lock was successfully acquired
      expect(existsSync(probePath)).toBe(false);
      // Lock file should exist
      expect(existsSync(handle.lockPath)).toBe(true);
    } finally {
      handle.release();
    }
  });

  it("does not create probe when configDir doesn't exist", () => {
    const nonExistentDir = join(tmpdir(), "nonexistent-" + Date.now());
    const probePath = join(nonExistentDir, ".rollback.lock.probe");
    
    const handle = acquireDrainLock(nonExistentDir);
    try {
      // Should use fallback, no probe in non-existent dir
      expect(existsSync(probePath)).toBe(false);
      expect(handle.lockPath).toBe("/var/tmp/pi-eng-rollback.lock");
    } finally {
      handle.release();
    }
  });
});
