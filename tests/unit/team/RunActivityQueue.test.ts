import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunActivityQueue, type AgentActivityEvent } from "../../../src/team/RunActivityQueue.js";

describe("RunActivityQueue", () => {
  let runsDir: string;
  const runId = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "raq-"));
  });

  function makeQueue(opts: Partial<ConstructorParameters<typeof RunActivityQueue>[0]> = {}) {
    return new RunActivityQueue({ runsDir, runId, ringCapacity: 16, ...opts });
  }

  it("creates the _activity dir under runsDir and writes JSONL on enqueue", () => {
    const q = makeQueue();
    q.enqueue({
      runId,
      agentName: "bug-triage",
      step: "classify",
      kind: "assistant_text",
      body: "hello",
      sourceClass: "stdout",
    });
    expect(existsSync(q.jsonlPath)).toBe(true);
    const lines = readFileSync(q.jsonlPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as AgentActivityEvent;
    expect(parsed.runId).toBe(runId);
    expect(parsed.kind).toBe("assistant_text");
    expect(parsed.seq).toBe(0);
  });

  it("assigns monotonic seq across enqueues", () => {
    const q = makeQueue();
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "1", sourceClass: "stdout" });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "2", sourceClass: "stdout" });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "3", sourceClass: "stdout" });
    const lines = readFileSync(q.jsonlPath, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2]);
  });

  it("mirrors to the legacy path when enabled (default)", () => {
    const q = makeQueue({ legacyMirrorEnabled: true });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: "OK", sourceClass: "stdout" });
    expect(existsSync(q.legacyMirrorPath)).toBe(true);
  });

  it("does not mirror when disabled", () => {
    const q = makeQueue({ legacyMirrorEnabled: false });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: "OK", sourceClass: "stdout" });
    expect(existsSync(q.legacyMirrorPath)).toBe(false);
  });

  it("acquireLock prevents a second queue from claiming the same run", () => {
    const q1 = makeQueue();
    q1.acquireLock();
    const q2 = makeQueue();
    expect(() => q2.acquireLock()).toThrow(/lock already held/);
    q1.release();
  });

  it("drops thinking events when ring is full", () => {
    const q = makeQueue({ ringCapacity: 2 });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "1", sourceClass: "stdout" });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "2", sourceClass: "stdout" });
    const r = q.enqueue({ runId, agentName: "a", step: "s", kind: "thinking", body: "thinking-dropped", sourceClass: "stdout" });
    expect(r.accepted).toBe(false);
    expect(r.dropped).toBe("thinking");
    const text = readFileSync(q.jsonlPath, "utf8");
    expect(text.includes("thinking-dropped")).toBe(false);
  });

  it("coalesces essential events under pressure rather than blocking", () => {
    const q = makeQueue({ ringCapacity: 1 });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "fill", sourceClass: "stdout" });
    const r = q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: "essential", sourceClass: "stdout" });
    expect(r.accepted).toBe(true);
    const lines = readFileSync(q.jsonlPath, "utf8").trim().split("\n");
    const kinds = lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toContain("essential-coalesced");
  });

  it("truncates bodies that exceed maxBodyBytes", () => {
    const q = makeQueue({ maxBodyBytes: 16 });
    const big = "x".repeat(64);
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: big, sourceClass: "stdout" });
    const lines = readFileSync(q.jsonlPath, "utf8").trim().split("\n");
    const body: string = JSON.parse(lines[0]).body;
    expect(body.includes("TRUNCATED")).toBe(true);
    expect(body.length).toBeLessThan(big.length + 50);
  });

  it("calls onEvent in-process callback when supplied", () => {
    const seen: AgentActivityEvent[] = [];
    const q = makeQueue({ onEvent: (ev) => seen.push(ev) });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "verdict", body: "PASS", sourceClass: "stdout" });
    expect(seen.length).toBe(1);
    expect(seen[0].kind).toBe("verdict");
  });
});

// Phase B item 16 — stuck detector.
describe("RunActivityQueue — stuck detector (item 16)", () => {
  let runsDir: string;
  const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "raq-stuck-"));
  });

  it("emits a heartbeat event on tickHeartbeat", () => {
    const seen: AgentActivityEvent[] = [];
    const q = new RunActivityQueue({
      runsDir, runId, ringCapacity: 16,
      heartbeatIntervalMs: 1000,
      onEvent: (ev) => seen.push(ev),
    });
    q.enqueue({ runId, agentName: "bug-triage", step: "classify", kind: "assistant_text", body: "hi", sourceClass: "stdout" });
    q.tickHeartbeat(Date.now() + 1000);
    const heartbeats = seen.filter((e) => e.kind === "heartbeat");
    expect(heartbeats.length).toBeGreaterThan(0);
    const payload = JSON.parse(heartbeats[0].body);
    expect(payload.state).toBeDefined();
  });

  it("escalates to stuck-warning when model is silent past threshold", () => {
    const seen: AgentActivityEvent[] = [];
    const q = new RunActivityQueue({
      runsDir, runId, ringCapacity: 16,
      heartbeatIntervalMs: 1000,
      stuckThresholdMs: 5000,
      onEvent: (ev) => seen.push(ev),
    });
    q.enqueue({ runId, agentName: "bug-triage", step: "classify", kind: "assistant_text", body: "hi", sourceClass: "stdout" });
    // Simulate clock advancing past threshold without any new
    // activity.
    q.tickHeartbeat(Date.now() + 10_000);
    const warnings = seen.filter((e) => e.kind === "stuck-warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0].body).toMatch(/model-silent/);
  });

  it("classifies state as tool-running when an unmatched tool_call_invoke is open", () => {
    const seen: AgentActivityEvent[] = [];
    const q = new RunActivityQueue({
      runsDir, runId, ringCapacity: 16,
      onEvent: (ev) => seen.push(ev),
    });
    q.enqueue({ runId, agentName: "bug-triage", step: "classify", kind: "tool_call_invoke", body: "$ bash", sourceClass: "stdout" });
    q.tickHeartbeat(Date.now() + 1000);
    const heartbeats = seen.filter((e) => e.kind === "heartbeat");
    expect(heartbeats.length).toBeGreaterThan(0);
    const payload = JSON.parse(heartbeats[heartbeats.length - 1].body);
    expect(payload.state).toBe("tool-running");
  });

  it("clears pending tool state on tool_call_result", () => {
    const seen: AgentActivityEvent[] = [];
    const q = new RunActivityQueue({
      runsDir, runId, ringCapacity: 16,
      onEvent: (ev) => seen.push(ev),
    });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "tool_call_invoke", body: "$ cmd", sourceClass: "stdout" });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "tool_call_result", body: "ok", sourceClass: "stdout" });
    q.tickHeartbeat(Date.now() + 1000);
    const last = seen.filter((e) => e.kind === "heartbeat").pop();
    expect(last).toBeDefined();
    expect(JSON.parse(last!.body).state).toBe("idle");
  });
});
