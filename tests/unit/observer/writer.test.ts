import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, stat, rename, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { EventWriter } from "../../../src/observer/writer.js";
import type { EngteamEvent } from "../../../src/types.js";

function makeEvent(runId: string, overrides: Partial<EngteamEvent> = {}): EngteamEvent {
  return {
    ts: new Date().toISOString(),
    runId,
    category: "lifecycle",
    type: "run.start",
    payload: { test: true },
    ...overrides,
  };
}

describe("EventWriter", () => {
  let tmpDir: string;
  let writer: EventWriter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "writer-test-"));
    writer = new EventWriter(tmpDir);
  });

  it("getPath returns correct jsonl path", () => {
    expect(writer.getPath("run-abc")).toBe(join(tmpDir, "run-abc", "events.jsonl"));
  });

  it("writes an event as a valid JSON line", async () => {
    const event = makeEvent("run-1");
    await writer.write("run-1", event);
    const content = await readFile(join(tmpDir, "run-1", "events.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.category).toBe("lifecycle");
  });

  it("appends multiple events as separate lines", async () => {
    await writer.write("run-2", makeEvent("run-2", { type: "step.start" }));
    await writer.write("run-2", makeEvent("run-2", { type: "step.end" }));
    const content = await readFile(join(tmpDir, "run-2", "events.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("step.start");
    expect(JSON.parse(lines[1]).type).toBe("step.end");
  });

  it("rotates when file exceeds threshold", async () => {
    const smallWriter = new EventWriter(tmpDir, 100);
    await smallWriter.write("run-3", makeEvent("run-3"));
    await smallWriter.write("run-3", makeEvent("run-3"));
    await smallWriter.flush("run-3");
    const mainStat = await stat(join(tmpDir, "run-3", "events.jsonl")).catch(() => null);
    expect(mainStat).not.toBeNull();
  });
});
