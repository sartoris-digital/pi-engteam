import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withRepoLock, lockDirFor, RepoLockTimeoutError, REPO_LOCK_OWNER_FILE, isPidAlive } from "../../../src/workspace/lock.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spawns a node process that exits immediately and returns its (now dead) pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn failed");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "repo-lock-"));
}

describe("isPidAlive", () => {
  it("is true for this process and false for an exited child", async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(await deadPid())).toBe(false);
  });
});

describe("withRepoLock", () => {
  it("runs fn while holding <gitCommonDir>/pi-sdlc-factory.lock with owner.json, then removes it", async () => {
    const dir = await tmp();
    const result = await withRepoLock(dir, async () => {
      await expect(stat(lockDirFor(dir))).resolves.toBeTruthy();
      const owner = JSON.parse(await readFile(path.join(lockDirFor(dir), REPO_LOCK_OWNER_FILE), "utf8")) as { pid: number; at: string };
      expect(owner.pid).toBe(process.pid);
      expect(Date.parse(owner.at)).toBeGreaterThan(0);
      return 42;
    }, { timeoutMs: 1000 });
    expect(result).toBe(42);
    expect(lockDirFor(dir)).toBe(path.join(dir, "pi-sdlc-factory.lock"));
    await expect(stat(lockDirFor(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the lock when fn throws", async () => {
    const dir = await tmp();
    await expect(withRepoLock(dir, async () => { throw new Error("boom"); }, { timeoutMs: 1000 })).rejects.toThrow("boom");
    await expect(stat(lockDirFor(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serialises two concurrent callers", async () => {
    const dir = await tmp();
    const log: string[] = [];
    const worker = (name: string) => withRepoLock(dir, async () => {
      log.push(`${name}:enter`);
      await sleep(60);
      log.push(`${name}:exit`);
    }, { timeoutMs: 5000, pollMs: 5 });
    await Promise.all([worker("a"), worker("b")]);
    expect(log).toHaveLength(4);
    const first = log[0]?.split(":")[0];
    expect(log[1]).toBe(`${first}:exit`);
  });

  it("times out with RepoLockTimeoutError while a live process holds the lock", async () => {
    const dir = await tmp();
    await mkdir(lockDirFor(dir));
    await writeFile(path.join(lockDirFor(dir), REPO_LOCK_OWNER_FILE), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const p = withRepoLock(dir, async () => "never", { timeoutMs: 150, pollMs: 10, staleMs: 0 });
    await expect(p).rejects.toBeInstanceOf(RepoLockTimeoutError);
    await expect(p).rejects.toMatchObject({ code: "repo-lock-timeout", owner: { pid: process.pid } });
    await expect(stat(lockDirFor(dir))).resolves.toBeTruthy();
  });

  it("takes over a stale lock whose owner pid is dead and which is older than staleMs", async () => {
    const dir = await tmp();
    const lockDir = lockDirFor(dir);
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, REPO_LOCK_OWNER_FILE), JSON.stringify({ pid: await deadPid(), at: "2020-01-01T00:00:00.000Z" }));
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockDir, old, old);
    const result = await withRepoLock(dir, async () => "took-over", { timeoutMs: 1000, pollMs: 5, staleMs: 180_000 });
    expect(result).toBe("took-over");
    await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not take over a dead-owner lock younger than staleMs", async () => {
    const dir = await tmp();
    const lockDir = lockDirFor(dir);
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, REPO_LOCK_OWNER_FILE), JSON.stringify({ pid: await deadPid(), at: new Date().toISOString() }));
    await expect(withRepoLock(dir, async () => "no", { timeoutMs: 120, pollMs: 10, staleMs: 180_000 })).rejects.toBeInstanceOf(RepoLockTimeoutError);
  });
});
