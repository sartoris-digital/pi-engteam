import { EventEmitter } from "events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDefinition, TeamMessage } from "../../../src/types.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import { TeamRuntime } from "../../../src/team/TeamRuntime.js";

function fakeDef(name: string): AgentDefinition {
  return { name, description: "test", model: "claude-haiku-4-5-20251001", systemPrompt: "You are a test agent." };
}

function makeMessage(to: string): TeamMessage {
  return {
    id: crypto.randomUUID(),
    from: "system",
    to,
    summary: "test",
    message: "hello",
    ts: new Date().toISOString(),
  };
}

function makeTeam() {
  return new TeamRuntime({
    cwd: "/tmp",
    bus: { subscribe: vi.fn(), publish: vi.fn() } as any,
    observer: { emit: vi.fn(), subscribeToSession: vi.fn(), subscribeToBus: vi.fn() } as any,
    runsDir: "/tmp",
    agentDefs: [fakeDef("worker")],
  });
}

function makeClosingChild() {
  const child = new EventEmitter() as any;
  const stdout = new EventEmitter() as any;
  const stderr = new EventEmitter() as any;
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();
  child.pid = 12345;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  setTimeout(() => child.emit("close", 0, null), 0);
  return child;
}

describe("TeamRuntime subprocess spawn options", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeClosingChild());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns Pi workers detached so timeout cleanup can signal the process group", async () => {
    const team = makeTeam();

    await team.deliver("worker", makeMessage("worker"), { runId: "run-spawn" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  });
});
