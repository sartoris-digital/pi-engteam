import { describe, it, expect, beforeEach } from "vitest";
import { openDb, upsertRun, insertEvent, listRuns, getRun, getEvents, countEvents } from "../../../server/storage.js";
import type { Db } from "../../../server/storage.js";

function makeRun(overrides: Partial<{
  runId: string; workflow: string; goal: string; status: string;
  currentStep: string; iteration: number; createdAt: string; updatedAt: string;
}> = {}) {
  return {
    runId: "run-1",
    workflow: "test-workflow",
    goal: "test goal",
    status: "running",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<{
  runId: string; ts: string; category: string; type: string;
  step: string; agentName: string; summary: string; payload: Record<string, unknown>;
}> = {}) {
  return {
    runId: "run-1",
    ts: "2024-01-01T00:00:00.000Z",
    category: "lifecycle",
    type: "run.start",
    payload: { test: true },
    ...overrides,
  };
}

describe("storage", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("openDb creates tables", () => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("runs");
    expect(names).toContain("events");
  });

  describe("upsertRun", () => {
    it("inserts a run", () => {
      upsertRun(db, makeRun());
      const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get("run-1") as any;
      expect(row.run_id).toBe("run-1");
      expect(row.workflow).toBe("test-workflow");
      expect(row.goal).toBe("test goal");
      expect(row.status).toBe("running");
    });

    it("upserts — updates status and updated_at on conflict", () => {
      upsertRun(db, makeRun({ status: "running", updatedAt: "2024-01-01T00:00:00.000Z" }));
      upsertRun(db, makeRun({ status: "succeeded", updatedAt: "2024-01-02T00:00:00.000Z" }));
      const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get("run-1") as any;
      expect(row.status).toBe("succeeded");
      expect(row.updated_at).toBe("2024-01-02T00:00:00.000Z");
    });

    it("handles optional currentStep and iteration", () => {
      upsertRun(db, makeRun({ currentStep: "verify", iteration: 3 }));
      const row = db.prepare("SELECT * FROM runs WHERE run_id = ?").get("run-1") as any;
      expect(row.current_step).toBe("verify");
      expect(row.iteration).toBe(3);
    });
  });

  describe("insertEvent", () => {
    beforeEach(() => {
      upsertRun(db, makeRun());
    });

    it("inserts an event with correct fields", () => {
      insertEvent(db, makeEvent({ step: "plan", agentName: "planner", summary: "did stuff" }));
      const row = db.prepare("SELECT * FROM events WHERE run_id = ?").get("run-1") as any;
      expect(row.run_id).toBe("run-1");
      expect(row.category).toBe("lifecycle");
      expect(row.type).toBe("run.start");
      expect(row.step).toBe("plan");
      expect(row.agent_name).toBe("planner");
      expect(row.summary).toBe("did stuff");
      expect(JSON.parse(row.payload)).toEqual({ test: true });
    });

    it("INSERT OR IGNORE — inserting same event twice only inserts once", () => {
      insertEvent(db, makeEvent());
      insertEvent(db, makeEvent());
      const count = (db.prepare("SELECT COUNT(*) as n FROM events").get() as { n: number }).n;
      expect(count).toBe(1);
    });
  });

  describe("listRuns", () => {
    it("returns runs in updated_at DESC order", () => {
      upsertRun(db, makeRun({ runId: "run-a", updatedAt: "2024-01-01T00:00:00.000Z" }));
      upsertRun(db, makeRun({ runId: "run-b", updatedAt: "2024-01-03T00:00:00.000Z" }));
      upsertRun(db, makeRun({ runId: "run-c", updatedAt: "2024-01-02T00:00:00.000Z" }));
      const runs = listRuns(db) as any[];
      expect(runs[0].run_id).toBe("run-b");
      expect(runs[1].run_id).toBe("run-c");
      expect(runs[2].run_id).toBe("run-a");
    });

    it("respects limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        upsertRun(db, makeRun({ runId: `run-${i}`, updatedAt: `2024-01-0${i + 1}T00:00:00.000Z` }));
      }
      const runs = listRuns(db, 2, 1) as any[];
      expect(runs).toHaveLength(2);
    });
  });

  describe("getEvents", () => {
    beforeEach(() => {
      upsertRun(db, makeRun());
      insertEvent(db, makeEvent({ ts: "2024-01-01T01:00:00.000Z", category: "lifecycle", type: "run.start" }));
      insertEvent(db, makeEvent({ ts: "2024-01-01T02:00:00.000Z", category: "tool_call", type: "tool.exec" }));
      insertEvent(db, makeEvent({ ts: "2024-01-01T03:00:00.000Z", category: "lifecycle", type: "run.end" }));
    });

    it("returns all events for a run ordered by ts ASC", () => {
      const events = getEvents(db, "run-1") as any[];
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("run.start");
      expect(events[2].type).toBe("run.end");
    });

    it("filters by category", () => {
      const events = getEvents(db, "run-1", { category: "tool_call" }) as any[];
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool.exec");
    });

    it("filters by since", () => {
      const events = getEvents(db, "run-1", { since: "2024-01-01T02:00:00.000Z" }) as any[];
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("tool.exec");
    });
  });

  describe("countEvents", () => {
    it("returns correct count", () => {
      upsertRun(db, makeRun());
      expect(countEvents(db, "run-1")).toBe(0);
      insertEvent(db, makeEvent({ ts: "2024-01-01T01:00:00.000Z", type: "run.start" }));
      insertEvent(db, makeEvent({ ts: "2024-01-01T02:00:00.000Z", type: "run.end" }));
      expect(countEvents(db, "run-1")).toBe(2);
    });
  });
});
