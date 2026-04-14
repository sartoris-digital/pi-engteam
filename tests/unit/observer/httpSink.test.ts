import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { HttpSink } from "../../../src/observer/httpSink.js";
import type { EngteamEvent } from "../../../src/types.js";

function makeEvent(n: number): EngteamEvent {
  return {
    ts: new Date().toISOString(),
    runId: "run-http",
    category: "lifecycle",
    type: `event-${n}`,
    payload: { n },
  };
}

describe("HttpSink", () => {
  let fetchCalls: Array<{ url: string; body: string }> = [];
  let fetchShouldFail = false;

  beforeEach(() => {
    fetchCalls = [];
    fetchShouldFail = false;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, body: init.body as string });
      if (fetchShouldFail) {
        return { ok: false, status: 503 };
      }
      return { ok: true, status: 200 };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flushes after 10 events", async () => {
    const sink = new HttpSink("http://localhost:4747/events", "run-http", "/tmp/dummy");
    for (let i = 0; i < 10; i++) sink.enqueue(makeEvent(i));
    await sink.flush();
    expect(fetchCalls).toHaveLength(1);
    const lines = fetchCalls[0].body.trim().split("\n");
    expect(lines).toHaveLength(10);
    sink.dispose();
  });

  it("each line in POST body is valid JSON", async () => {
    const sink = new HttpSink("http://localhost:4747/events", "run-http", "/tmp/dummy");
    sink.enqueue(makeEvent(1));
    sink.enqueue(makeEvent(2));
    await sink.flush();
    const lines = fetchCalls[0].body.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    sink.dispose();
  });

  it("writes to sink-queue on 5xx failure", async () => {
    fetchShouldFail = true;
    const tmpDir = await mkdtemp(join(tmpdir(), "sink-test-"));
    const sink = new HttpSink("http://localhost:4747/events", "run-http", tmpDir);
    sink.enqueue(makeEvent(1));
    await sink.flush();
    const queueFile = join(tmpDir, "events.sink-queue.jsonl");
    const content = await readFile(queueFile, "utf8");
    expect(content.trim()).toBeTruthy();
    const lines = content.trim().split("\n");
    expect(JSON.parse(lines[0]).type).toBe("event-1");
    sink.dispose();
  });
});
