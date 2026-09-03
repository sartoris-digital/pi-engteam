import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLease, leasePath } from "../../../src/scheduler/lease.js";

async function withRuns<T>(fn: (runs: string) => Promise<T>): Promise<T> {
  const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-lease-"));
  try {
    return await fn(runs);
  } finally {
    await rm(runs, { recursive: true, force: true });
  }
}

describe("acquireDaemonLease", () => {
  it("gives the second acquire holder: false", async () => {
    await withRuns(async (runs) => {
      const first = await acquireDaemonLease(runs, { renewMs: 60_000 });
      try {
        expect(first.holder).toBe(true);
        expect(first.pid).toBe(process.pid);
        expect(first.path).toBe(leasePath(runs));
        const owner = JSON.parse(await readFile(join(first.path, "owner.json"), "utf8")) as { pid: number; at: string };
        expect(owner.pid).toBe(process.pid);
        const second = await acquireDaemonLease(runs);
        expect(second.holder).toBe(false);
        await second.stop();
      } finally {
        await first.stop();
      }
      await expect(stat(join(leasePath(runs), "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("takes over when the owner pid is dead and the lease is stale", async () => {
    await withRuns(async (runs) => {
      const dir = leasePath(runs);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "owner.json"), JSON.stringify({ pid: 999999, at: "2020-01-01T00:00:00.000Z" }));
      const lease = await acquireDaemonLease(runs, {
        now: () => new Date("2026-09-03T00:00:00.000Z"),
        staleMs: 1000,
        isAlive: () => false,
        renewMs: 60_000,
      });
      try {
        expect(lease.holder).toBe(true);
        expect(lease.pid).toBe(process.pid);
      } finally {
        await lease.stop();
      }
    });
  });

  it("stop() deletes owner.json and allows a new holder", async () => {
    await withRuns(async (runs) => {
      const first = await acquireDaemonLease(runs, { renewMs: 60_000 });
      expect(first.holder).toBe(true);
      await first.stop();
      const second = await acquireDaemonLease(runs, { renewMs: 60_000 });
      try {
        expect(second.holder).toBe(true);
      } finally {
        await second.stop();
      }
    });
  });
});
