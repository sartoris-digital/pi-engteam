import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_ROTATED,
  DEFAULT_ROTATION_BYTES,
  EVENT_CATEGORIES,
  FACTORY_EVENTS,
  Observer,
  clipData,
  isEventCategory,
  readEvents,
  type FactoryEvent,
} from "../../../src/observer/index.js";

async function withRunDir<T>(fn: (runDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-sdlc-observer-"));
  try {
    return await fn(join(root, "runs", "run1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertJsonl(raw: string): string[] {
  const lines = raw.split("\n").filter((line) => line !== "");
  for (const line of lines) {
    expect(() => JSON.parse(line), line.slice(0, 80)).not.toThrow();
  }
  return lines;
}

describe("EventCategory", () => {
  it("is the locked category enum including stage, worker and git", () => {
    expect([...EVENT_CATEGORIES]).toEqual([
      "lifecycle", "tool_call", "tool_result", "message", "verdict", "budget", "safety", "approval", "error",
      "stage", "worker", "git",
    ]);
    expect(isEventCategory("safety")).toBe(true);
    expect(isEventCategory("stage")).toBe(true);
    expect(isEventCategory("worker")).toBe(true);
    expect(isEventCategory("git")).toBe(true);
    expect(isEventCategory("Safety")).toBe(false);
    expect(isEventCategory(42)).toBe(false);
  });

  it("exposes the documented defaults and canonical event names", () => {
    expect(DEFAULT_ROTATION_BYTES).toBe(50 * 1024 * 1024);
    expect(DEFAULT_MAX_ROTATED).toBe(10);
    expect(DEFAULT_MAX_DATA_BYTES).toBe(2048);
    expect([...FACTORY_EVENTS]).toEqual([
      "run.start",
      "run.end",
      "run.escalate",
      "run.pause",
      "run.resume",
      "stage.start",
      "stage.end",
      "run.published",
      "factory.fusion.degraded",
      "factory.ticket.claimed",
      "factory.ticket.classified",
      "factory.lane.started",
      "factory.ticket.blocked",
      "factory.ticket.landed",
      "factory.needs-rebase",
      "factory.revise",
      "factory.landed",
      "factory.pr.opened",
      "factory.approval.granted",
      "factory.codified.staged",
      "factory.codified.probationary",
      "factory.codified.active",
      "factory.codified.assist",
      "factory.codified.demoted",
      "factory.codified.retired",
      "factory.codified.rejected",
      "factory.codified.drifted",
      "factory.codified.mine",
      "factory.codified.assess",
      "factory.codified.generate",
      "factory.codified.validate",
      "factory.codified.blocked",
    ]);
    expect(FACTORY_EVENTS).toContain("run.start");
    expect(FACTORY_EVENTS).toContain("run.published");
    expect(FACTORY_EVENTS).toContain("factory.ticket.claimed");
    expect(FACTORY_EVENTS).toContain("factory.needs-rebase");
    expect(FACTORY_EVENTS).toContain("factory.revise");
    expect(FACTORY_EVENTS).toContain("factory.landed");
  });
});

describe("clipData", () => {
  it("returns small data unchanged and clips large data with a byte count", () => {
    const small = { args: "x".repeat(10) };
    expect(clipData(small, 2048)).toBe(small);
    const big = { args: "y".repeat(5000) };
    const clipped = clipData(big, 100) as { clipped: boolean; bytes: number; preview: string };
    expect(clipped.clipped).toBe(true);
    expect(clipped.bytes).toBe(Buffer.byteLength(JSON.stringify(big), "utf8"));
    expect(clipped.preview).toBe(JSON.stringify(big).slice(0, 100));
    expect(Buffer.byteLength(clipped.preview, "utf8")).toBe(100);
  });

  it("truncates UTF-8 on a code-point boundary; the cap applies to preview not the wrapper", () => {
    const emoji = { args: "💣".repeat(3000) };
    const clipped = clipData(emoji, 2048) as { clipped: boolean; bytes: number; preview: string };
    expect(clipped.clipped).toBe(true);
    expect(clipped.bytes).toBe(Buffer.byteLength(JSON.stringify(emoji), "utf8"));
    expect(Buffer.byteLength(clipped.preview, "utf8")).toBeLessThanOrEqual(2048);
    expect(clipped.preview).not.toContain("\uFFFD");
    expect(Buffer.from(clipped.preview, "utf8").toString("utf8")).toBe(clipped.preview);
    expect(Buffer.byteLength(JSON.stringify(clipped), "utf8")).toBeGreaterThan(2048);

    const cjk = { args: "你".repeat(2000) };
    const clippedCjk = clipData(cjk, 64) as { preview: string };
    expect(Buffer.byteLength(clippedCjk.preview, "utf8")).toBeLessThanOrEqual(64);
    expect(clippedCjk.preview).not.toContain("\uFFFD");

    const midEmoji = clipData({ args: "💣" }, 12) as { preview: string };
    expect(Buffer.byteLength(midEmoji.preview, "utf8")).toBeLessThanOrEqual(12);
    expect(midEmoji.preview).not.toContain("💣");
    expect(midEmoji.preview).not.toContain("\uFFFD");

    const exact = { x: "a".repeat(10) };
    const exactBytes = Buffer.byteLength(JSON.stringify(exact), "utf8");
    expect(clipData(exact, exactBytes)).toBe(exact);
    expect(clipData(exact, exactBytes - 1)).toMatchObject({ clipped: true });
  });
});

describe("Observer", () => {
  it("creates the run dir, writes a JSON observer.open event first, then one JSON line per event", async () => {
    await withRunDir(async (runDir) => {
      const obs = new Observer(runDir, "run1");
      expect(obs.path).toBe(join(runDir, "events.jsonl"));
      obs.emit({ category: "lifecycle", type: "factory.lane.started", step: "plan", data: { lane: "chore" } });
      obs.emit({ category: "tool_call", type: "start", agent: "planner", data: { tool: "read", args: { path: "a" } } });
      await obs.flush();

      const raw = await readFile(obs.path, "utf8");
      const lines = assertJsonl(raw);
      expect(raw.split("\n").at(-1)).toBe("");
      expect(lines).toHaveLength(3);
      expect((await stat(obs.path)).mode & 0o077).toBe(0);

      const events = await readEvents(runDir);
      expect(events).toHaveLength(3);
      const open = events[0] as FactoryEvent;
      expect(open.runId).toBe("run1");
      expect(open.category).toBe("lifecycle");
      expect(open.type).toBe("observer.open");
      expect(open.data).toEqual({ generated: true });
      const first = events[1] as FactoryEvent;
      expect(first.runId).toBe("run1");
      expect(first.category).toBe("lifecycle");
      expect(first.type).toBe("factory.lane.started");
      expect(first.step).toBe("plan");
      expect(first.data).toEqual({ lane: "chore" });
      expect(Number.isNaN(Date.parse(first.ts))).toBe(false);
      expect(events[2]?.agent).toBe("planner");
    });
  });

  it("keeps a caller-supplied ts and runId and clips oversized data", async () => {
    await withRunDir(async (runDir) => {
      const obs = new Observer(runDir, "run1", { maxDataBytes: 64 });
      obs.emit({ ts: "2026-09-02T10:00:00.000Z", runId: "other", category: "tool_result", type: "ok", data: { out: "z".repeat(500) } });
      await obs.flush();
      const e = (await readEvents(runDir)).find((ev) => ev.type === "ok");
      expect(e?.ts).toBe("2026-09-02T10:00:00.000Z");
      expect(e?.runId).toBe("other");
      expect(e?.data).toMatchObject({ clipped: true });
      expect(Buffer.byteLength((e?.data as { preview: string }).preview, "utf8")).toBe(64);
    });
  });

  it("rejects malformed events synchronously and writes nothing", async () => {
    await withRunDir(async (runDir) => {
      const obs = new Observer(runDir, "run1");
      expect(() => obs.emit({ category: "nope" as never, type: "x" })).toThrow(TypeError);
      expect(() => obs.emit({ category: "safety", type: "" })).toThrow(TypeError);
      expect(() => obs.emit({ category: "safety", type: "x", runId: "" })).toThrow(TypeError);
      await obs.flush();
      await expect(stat(obs.path)).rejects.toThrow();
    });
  });

  it("serialises concurrent emits in order", async () => {
    await withRunDir(async (runDir) => {
      const obs = new Observer(runDir, "run1");
      for (let i = 0; i < 50; i++) obs.emit({ category: "message", type: `e${i}` });
      await obs.flush();
      const events = await readEvents(runDir);
      expect(events.map((e) => e.type)).toEqual(["observer.open", ...Array.from({ length: 50 }, (_, i) => `e${i}`)]);
    });
  });

  it("rotates at rotationBytes and caps the number of rotated files", async () => {
    await withRunDir(async (runDir) => {
      // rotationBytes: 1 → rotate before every append once the file exists
      const obs = new Observer(runDir, "run1", { rotationBytes: 1, maxRotated: 2 });
      for (let i = 1; i <= 5; i++) {
        obs.emit({ category: "lifecycle", type: `e${i}` });
      }
      await obs.flush();

      const names = (await readdir(runDir)).filter((n) => n.startsWith("events")).sort();
      expect(names).toEqual(["events.1.jsonl", "events.2.jsonl", "events.jsonl"]);
      expect((await readEvents(runDir)).map((e) => e.type)).toEqual(["observer.open", "e5"]);
      expect((await readEvents(runDir, "events.1.jsonl")).map((e) => e.type)).toEqual(["observer.open", "e4"]);
      expect((await readEvents(runDir, "events.2.jsonl")).map((e) => e.type)).toEqual(["observer.open", "e3"]);
      for (const name of names) {
        const raw = await readFile(join(runDir, name), "utf8");
        assertJsonl(raw);
      }
    });
  });

  it("does not rotate below the threshold", async () => {
    await withRunDir(async (runDir) => {
      const obs = new Observer(runDir, "run1", { rotationBytes: 1_000_000 });
      for (let i = 0; i < 20; i++) obs.emit({ category: "budget", type: "tick", data: { i } });
      await obs.flush();
      expect((await readdir(runDir)).filter((n) => n.startsWith("events")).sort()).toEqual(["events.jsonl"]);
      expect(await readEvents(runDir)).toHaveLength(21);
    });
  });

  it("accepts stage, worker and git categories used by the engine", async () => {
    await withRunDir(async (runDir) => {
      const obs = new Observer(runDir, "run1");
      obs.emit({ category: "stage", type: "stage.start", step: "plan" });
      obs.emit({ category: "worker", type: "worker.start", agent: "planner" });
      obs.emit({ category: "git", type: "run.published" });
      await obs.flush();
      expect((await readEvents(runDir)).filter((e) => e.type !== "observer.open").map((e) => e.category)).toEqual([
        "stage",
        "worker",
        "git",
      ]);
    });
  });

  it("readEvents returns [] for a missing file", async () => {
    await withRunDir(async (runDir) => {
      expect(await readEvents(runDir)).toEqual([]);
    });
  });

  it("readEvents propagates non-ENOENT filesystem errors", async () => {
    await withRunDir(async (runDir) => {
      await mkdir(runDir, { recursive: true });
      await mkdir(join(runDir, "events.jsonl"));
      await expect(readEvents(runDir)).rejects.toMatchObject({ code: "EISDIR" });
    });
  });

  it("two Observer instances on the same runDir do not lose events across rotation", async () => {
    await withRunDir(async (runDir) => {
      const a = new Observer(runDir, "run1", { rotationBytes: 1, maxRotated: 40 });
      const b = new Observer(runDir, "run1", { rotationBytes: 1, maxRotated: 40 });
      for (let i = 0; i < 20; i++) {
        (i % 2 === 0 ? a : b).emit({ category: "lifecycle", type: `e${i}` });
      }
      await Promise.all([a.flush(), b.flush()]);
      const names = (await readdir(runDir)).filter((n) => /^events(?:\.\d+)?\.jsonl$/.test(n));
      const types: string[] = [];
      for (const name of names) {
        assertJsonl(await readFile(join(runDir, name), "utf8"));
        for (const event of await readEvents(runDir, name)) {
          if (event.type !== "observer.open") types.push(event.type);
        }
      }
      expect(types.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `e${i}`).sort());
    });
  });
});
