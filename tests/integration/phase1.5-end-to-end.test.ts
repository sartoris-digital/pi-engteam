// tests/integration/phase1.5-end-to-end.test.ts
//
// End-to-end coverage for Phase 1.5: rate-limit guard wiring +
// subprocess audit event ingestion. Exercises TeamRuntime's
// onSubprocessEvent path directly without spawning a real subprocess.

import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { TeamRuntime } from "../../src/team/TeamRuntime.js";
import type { AgentDefinition, TeamMessage } from "../../src/types.js";

function makeTmpDir(): string {
  const d = join(tmpdir(), `phase1.5-e2e-${randomBytes(6).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeMockBus() {
  return { subscribe: vi.fn(), publish: vi.fn() } as any;
}

function makeMockObserver() {
  return { emit: vi.fn(), subscribeToSession: vi.fn(), subscribeToBus: vi.fn() } as any;
}

function fakeDef(name: string, model = "claude-haiku-4.6"): AgentDefinition {
  return { name, description: "test", model, systemPrompt: "test" };
}

function makeMessage(to: string): TeamMessage {
  return {
    id: "msg-" + randomBytes(4).toString("hex"),
    from: "system",
    to,
    summary: "test",
    message: "hello",
    ts: new Date().toISOString(),
  };
}

describe("Phase 1.5 end-to-end: subprocess event ingestion", () => {
  let dir: string;

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("ingests subprocess NDJSON events and forwards to onSubprocessEvent, then unlinks the file", async () => {
    dir = makeTmpDir();
    const runId = "run-abc";
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });

    // Pre-seed events written by a "subprocess" — a real subprocess would
    // appendFileSync these via SecretResolver.emitEvent.
    const eventsFile = join(runDir, "events-subprocess-9999.jsonl");
    const lines = [
      { category: "safety", type: "secret_access", payload: { secret_name: "API_TOKEN", agent: "implementer", target: "bash", timestamp: "2025-01-01T00:00:00.000Z" }, ts: "2025-01-01T00:00:00.000Z" },
      { category: "safety", type: "secret_access", payload: { secret_name: "DB_PASSWORD", agent: "implementer", target: "bash", timestamp: "2025-01-01T00:00:01.000Z" }, ts: "2025-01-01T00:00:01.000Z" },
    ];
    writeFileSync(eventsFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const onSubprocessEvent = vi.fn();
    const team = new TeamRuntime({
      cwd: dir,
      bus: makeMockBus(),
      observer: makeMockObserver(),
      runsDir: dir,
      agentDefs: [fakeDef("implementer")],
      onSubprocessEvent,
    });
    team.setRunId(runId);

    // Drive ingestion via the private method (tests the file-scan/unlink loop).
    await (team as any).ingestSubprocessEvents(runId, "implementer", Date.now());

    expect(onSubprocessEvent).toHaveBeenCalledTimes(2);
    const first = onSubprocessEvent.mock.calls[0];
    expect(first[0]).toBe(runId);
    expect(first[1]).toBe("implementer");
    expect(first[2].category).toBe("safety");
    expect(first[2].type).toBe("secret_access");
    expect(first[2].payload["secret_name"]).toBe("API_TOKEN");

    // File should be unlinked after ingestion.
    expect(existsSync(eventsFile)).toBe(false);
  });

  it("survives malformed lines without throwing", async () => {
    dir = makeTmpDir();
    const runId = "run-malformed";
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    const eventsFile = join(runDir, "events-subprocess-1234.jsonl");
    writeFileSync(eventsFile, "not-json\n{\"category\":\"safety\",\"type\":\"x\",\"payload\":{},\"ts\":\"t\"}\n");

    const onSubprocessEvent = vi.fn();
    const team = new TeamRuntime({
      cwd: dir,
      bus: makeMockBus(),
      observer: makeMockObserver(),
      runsDir: dir,
      agentDefs: [fakeDef("implementer")],
      onSubprocessEvent,
    });
    team.setRunId(runId);

    await (team as any).ingestSubprocessEvents(runId, "implementer", Date.now());

    // Only the well-formed line should make it through.
    expect(onSubprocessEvent).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when onSubprocessEvent is not configured", async () => {
    dir = makeTmpDir();
    const runId = "run-no-cb";
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    const eventsFile = join(runDir, "events-subprocess-555.jsonl");
    writeFileSync(eventsFile, JSON.stringify({ category: "safety", type: "secret_access", payload: {}, ts: "t" }) + "\n");

    const team = new TeamRuntime({
      cwd: dir,
      bus: makeMockBus(),
      observer: makeMockObserver(),
      runsDir: dir,
      agentDefs: [fakeDef("implementer")],
    });
    team.setRunId(runId);

    await (team as any).ingestSubprocessEvents(runId, "implementer", Date.now());
    // File is preserved when no callback is registered (nothing was ingested).
    expect(existsSync(eventsFile)).toBe(true);
  });
});

describe("Phase 1.5 end-to-end: deliver releases ticket on rate-limit-blocked path", () => {
  it("does not call release when both acquire attempts fail", async () => {
    const acquire = vi.fn().mockReturnValue({ ok: false, reason: "rpm", retryAfterMs: 1 });
    const release = vi.fn();
    const guard = { acquire, release } as any;

    const team = new TeamRuntime({
      cwd: "/tmp",
      bus: makeMockBus(),
      observer: makeMockObserver(),
      runsDir: "/tmp",
      agentDefs: [fakeDef("planner", "claude-sonnet-4.6")],
      rateLimit: guard,
    });

    await expect(team.deliver("planner", makeMessage("planner"))).rejects.toThrow(/RateLimit blocked/);
    expect(release).not.toHaveBeenCalled();
    expect(acquire.mock.calls[0][0]).toBe("anthropic");
  });
});
