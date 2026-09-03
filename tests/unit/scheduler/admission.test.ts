import { describe, expect, it } from "vitest";
import { admit, type AdmissionWorld } from "../../../src/scheduler/admission.js";
import type { QueueEntry } from "../../../src/scheduler/queue.js";

function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    key: "github:acme/widgets:42",
    tracker: "github",
    repo: "acme/widgets",
    ref: "42",
    priority: "p2",
    state: "ready",
    kind: "bug",
    enqueuedAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...over,
  };
}

function running(n: number, over: Partial<QueueEntry> = {}): QueueEntry {
  return entry({ key: `github:acme/widgets:${n}`, ref: String(n), state: "running", ...over });
}

function world(over: Partial<AdmissionWorld> = {}): AdmissionWorld {
  return {
    running: [],
    maxLanes: 3,
    maxLanesPerRepo: 2,
    ticketsToday: 0,
    maxTicketsPerDay: 20,
    spendToday: 0,
    dailyBudgetUsd: 150,
    exclusiveRunning: false,
    predictedPaths: [],
    ...over,
  };
}

describe("admit", () => {
  it("refuses a fourth lane when maxLanes is 3", () => {
    const result = admit(entry(), world({ running: [running(1), running(2), running(3)] }));
    expect(result).toEqual({ ok: false, reason: "max-lanes" });
  });

  it("refuses overlapping src/foo.ts against a running src/**", () => {
    const result = admit(
      entry(),
      world({
        running: [{ ...running(1), predictedPaths: ["src/**"] }],
        predictedPaths: ["src/foo.ts"],
      }),
    );
    expect(result).toEqual({ ok: false, reason: "overlap" });
  });

  it("lets p0 through the daily ticket cap but not the daily budget", () => {
    const p0 = entry({ priority: "p0" });
    expect(admit(p0, world({ ticketsToday: 20, maxTicketsPerDay: 20 }))).toEqual({ ok: true });
    expect(admit(p0, world({ spendToday: 151, dailyBudgetUsd: 150 }))).toEqual({
      ok: false,
      reason: "daily-budget",
    });
  });
});
