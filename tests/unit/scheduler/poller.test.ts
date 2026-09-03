import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhError } from "../../../src/trackers/gh.js";
import type { Ticket, TrackerAdapter } from "../../../src/trackers/adapter.js";
import type { TrackerRegistry } from "../../../src/trackers/discovery.js";
import { Scheduler } from "../../../src/scheduler/poller.js";
import { readWatermark, writeWatermark } from "../../../src/scheduler/watermark.js";
import type { DaemonLease } from "../../../src/scheduler/lease.js";

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    ref: { tracker: "github", id: "acme/widgets#42" },
    title: "fix the thing",
    body: "a".repeat(80),
    labels: ["factory:ready"],
    author: "alice",
    ...over,
  };
}

function fakeAdapter(list: () => Promise<Ticket[]>): TrackerAdapter {
  return {
    id: "github",
    capabilities: new Set(),
    detect: async () => ({ available: true }),
    parseRef: () => null,
    fetch: async () => ticket(),
    list,
    search: async () => [],
    getComments: async () => [],
    labelerOf: async () => null,
    isAuthorized: async () => true,
    acknowledge: async () => undefined,
    comment: async () => null,
    addLabel: async () => undefined,
    removeLabel: async () => undefined,
    transition: async () => undefined,
    assign: async () => undefined,
    linkPR: async () => undefined,
  };
}

function holderLease(runs: string, holder: boolean): DaemonLease {
  return { holder, pid: process.pid, path: join(runs, "_factory", "daemon.lease"), stop: async () => undefined };
}

async function withRuns<T>(fn: (runs: string) => Promise<T>): Promise<T> {
  const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-poll-"));
  try {
    return await fn(runs);
  } finally {
    await rm(runs, { recursive: true, force: true });
  }
}

describe("Scheduler", () => {
  it("lists once on start and does not list after stop", async () => {
    await withRuns(async (runs) => {
      const lists: Array<{ label: string; state: string; updatedSince?: Date }> = [];
      const seen: string[] = [];
      let intervalCb: (() => void) | undefined;
      let cleared = 0;
      const adapters: TrackerRegistry = new Map([
        [
          "github",
          fakeAdapter(async (q) => {
            lists.push(q);
            return [ticket()];
          }),
        ],
      ]);
      const sched = new Scheduler({
        runsDir: runs,
        adapters,
        pollIntervalSeconds: 60,
        onTicket: async (t) => {
          seen.push(t.ref.id);
        },
        acquireLease: async () => holderLease(runs, true),
        setIntervalFn: ((cb: () => void) => {
          intervalCb = cb;
          return 7 as unknown as NodeJS.Timeout;
        }) as typeof setInterval,
        clearIntervalFn: ((id: unknown) => {
          expect(id).toBe(7);
          cleared += 1;
          intervalCb = undefined;
        }) as typeof clearInterval,
      });
      await sched.start();
      expect(lists).toHaveLength(1);
      expect(lists[0]?.updatedSince).toBeUndefined();
      expect(seen).toEqual(["acme/widgets#42"]);
      await sched.stop();
      expect(cleared).toBe(1);
      intervalCb?.();
      expect(lists).toHaveLength(1);
    });
  });

  it("does not list when start() is not the leaseholder", async () => {
    await withRuns(async (runs) => {
      let lists = 0;
      const adapters: TrackerRegistry = new Map([
        ["github", fakeAdapter(async () => {
          lists += 1;
          return [];
        })],
      ]);
      const sched = new Scheduler({
        runsDir: runs,
        adapters,
        pollIntervalSeconds: 60,
        onTicket: async () => undefined,
        acquireLease: async () => holderLease(runs, false),
      });
      await sched.start();
      expect(lists).toBe(0);
      await sched.stop();
    });
  });

  it("retries 429 then advances the watermark once on success", async () => {
    await withRuns(async (runs) => {
      let calls = 0;
      const sleeps: number[] = [];
      const adapters: TrackerRegistry = new Map([
        [
          "github",
          fakeAdapter(async () => {
            calls += 1;
            if (calls === 1) throw new GhError("rate limited", 429, "HTTP 429 Retry-After: 2");
            return [ticket()];
          }),
        ],
      ]);
      const sched = new Scheduler({
        runsDir: runs,
        adapters,
        pollIntervalSeconds: 60,
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        onTicket: async () => undefined,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        jitter: () => 1,
      });
      const result = await sched.drainOnce();
      expect(calls).toBe(2);
      expect(sleeps).toEqual([2000]);
      expect(result.claimed).toBe(1);
      const mark = await readWatermark(runs, "github");
      expect(mark?.updatedSince).toBe("2026-09-03T12:00:00.000Z");
    });
  });

  it("drainOnce({ unwindowed: true }) ignores an existing watermark", async () => {
    await withRuns(async (runs) => {
      await writeWatermark(runs, "github", "2026-09-01T00:00:00.000Z");
      const queries: Array<Date | undefined> = [];
      const adapters: TrackerRegistry = new Map([
        [
          "github",
          fakeAdapter(async (q) => {
            queries.push(q.updatedSince);
            return [];
          }),
        ],
      ]);
      const sched = new Scheduler({
        runsDir: runs,
        adapters,
        pollIntervalSeconds: 60,
        now: () => new Date("2026-09-03T12:00:00.000Z"),
        onTicket: async () => undefined,
      });
      await sched.drainOnce({ unwindowed: true });
      expect(queries).toEqual([undefined]);
      const mark = await readWatermark(runs, "github");
      expect(mark?.updatedSince).toBe("2026-09-03T12:00:00.000Z");
    });
  });
});

describe("watermark", () => {
  it("round-trips", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-wm-"));
    try {
      await mkdir(join(runs, "_factory", "trackers"), { recursive: true });
      expect(await readWatermark(runs, "github")).toBeNull();
      await writeWatermark(runs, "github", "2026-09-03T00:00:00.000Z");
      expect(JSON.parse(await readFile(join(runs, "_factory", "trackers", "github.json"), "utf8"))).toEqual({
        updatedSince: "2026-09-03T00:00:00.000Z",
      });
      expect(await readWatermark(runs, "github")).toEqual({ updatedSince: "2026-09-03T00:00:00.000Z" });
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });
});
