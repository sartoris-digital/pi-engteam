import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { openDb, listRuns, getEvents } from "../../../server/storage.js";
import { EventWatcher } from "../../../server/watcher.js";

function makeEvent(
  runId: string,
  category: string,
  type: string,
  extraPayload: Record<string, unknown> = {},
): string {
  return (
    JSON.stringify({
      ts: new Date().toISOString(),
      runId,
      category,
      type,
      payload: extraPayload,
    }) + "\n"
  );
}

describe("EventWatcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "watcher-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("ingests all lines from an events.jsonl file", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-1");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-1", "tool_call", "bash.start") +
        makeEvent("run-1", "tool_result", "bash.end") +
        makeEvent("run-1", "message", "agent.msg"),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    const events = getEvents(db, "run-1");
    expect(events).toHaveLength(3);
  });

  it("tracks byte offset and only ingests new lines on subsequent calls", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-2");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(filePath, makeEvent("run-2", "tool_call", "bash.start"));

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    expect(getEvents(db, "run-2")).toHaveLength(1);

    // Append two more events
    await appendFile(
      filePath,
      makeEvent("run-2", "tool_call", "bash.start") +
        makeEvent("run-2", "tool_result", "bash.end"),
    );
    await watcher.ingestFile(filePath);

    // Total should now be 3, not 5 (no re-read of already-consumed bytes)
    expect(getEvents(db, "run-2")).toHaveLength(3);
  });

  it("does not re-ingest events when file has not grown", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-3");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(filePath, makeEvent("run-3", "tool_call", "bash.start"));

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);
    await watcher.ingestFile(filePath); // second call — same size

    expect(getEvents(db, "run-3")).toHaveLength(1);
  });

  it("calls upsertRun when a run.start lifecycle event is ingested", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-4");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-4", "lifecycle", "run.start", {
        workflow: "plan-build-review",
        goal: "Build the widget",
        iteration: 0,
      }),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    const runs = listRuns(db) as any[];
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe("run-4");
    expect(runs[0].status).toBe("running");
    expect(runs[0].workflow).toBe("plan-build-review");
  });

  it("sets run status to succeeded when a run.end lifecycle event is ingested", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-5");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-5", "lifecycle", "run.start", {
        workflow: "plan-build-review",
        goal: "Done goal",
        iteration: 1,
      }) +
        makeEvent("run-5", "lifecycle", "run.end", {
          status: "succeeded",
          iteration: 1,
        }),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    const runs = listRuns(db) as any[];
    expect(runs[0].status).toBe("succeeded");
  });

  it("silently skips malformed JSON lines", async () => {
    const db = openDb(":memory:");
    const runDir = join(tmpDir, "run-6");
    await mkdir(runDir, { recursive: true });
    const filePath = join(runDir, "events.jsonl");

    await writeFile(
      filePath,
      makeEvent("run-6", "tool_call", "bash.start") +
        "NOT VALID JSON\n" +
        makeEvent("run-6", "tool_result", "bash.end"),
    );

    const watcher = new EventWatcher(tmpDir, db);
    await watcher.ingestFile(filePath);

    // 2 valid events ingested; malformed line skipped without throwing
    expect(getEvents(db, "run-6")).toHaveLength(2);
  });

  it("returns immediately if file does not exist", async () => {
    const db = openDb(":memory:");
    const watcher = new EventWatcher(tmpDir, db);
    // Should not throw
    await expect(
      watcher.ingestFile(join(tmpDir, "nonexistent", "events.jsonl")),
    ).resolves.toBeUndefined();
  });
});
