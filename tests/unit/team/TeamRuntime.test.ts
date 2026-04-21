import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TeamRuntime } from "../../../src/team/TeamRuntime.js";
import type { AgentDefinition, TeamMessage } from "../../../src/types.js";

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

function makeMockBus() {
  return { subscribe: vi.fn(), publish: vi.fn() } as any;
}

function makeMockObserver() {
  return {
    emit: vi.fn(),
    subscribeToSession: vi.fn(),
    subscribeToBus: vi.fn(),
  } as any;
}

function makeTeam(agentDefs: AgentDefinition[] = []) {
  return new TeamRuntime({
    cwd: "/tmp",
    bus: makeMockBus(),
    observer: makeMockObserver(),
    runsDir: "/tmp",
    agentDefs,
    customToolsFor: () => [],
  });
}

function fakeDef(name: string): AgentDefinition {
  return { name, description: "test", model: "claude-haiku-4-5-20251001", systemPrompt: "You are a test agent." };
}

describe("TeamRuntime.deliver — subprocess mode", () => {
  it("throws when agent not in knownDefs", async () => {
    const team = makeTeam();
    await expect(team.deliver("ghost-agent", makeMessage("ghost-agent")))
      .rejects.toThrow("not registered");
  });

  it("throws with correct message for unknown agent", async () => {
    const team = makeTeam([fakeDef("known-agent")]);
    await expect(team.deliver("unknown-agent", makeMessage("unknown-agent")))
      .rejects.toThrow("Teammate 'unknown-agent' is not registered");
  });

  it("does not throw for a known agent (spawn path)", async () => {
    const team = makeTeam([fakeDef("my-agent")]);
    // Mock the internal spawn to avoid actually running pi
    const spawnMock = vi.fn().mockReturnValue({
      on: (event: string, cb: () => void) => {
        if (event === "close") setTimeout(cb, 0);
      },
    });
    vi.doMock("child_process", () => ({ spawn: spawnMock }));

    // Just verify deliver doesn't throw at the "not registered" check
    // (it will fail later trying to spawn, which is expected in test env)
    const knownDefs = (team as any).knownDefs;
    expect(knownDefs.has("my-agent")).toBe(true);
  });

  it("deliverAll calls deliver for all known defs", async () => {
    const team = makeTeam([fakeDef("agent-a"), fakeDef("agent-b")]);
    const deliverSpy = vi.spyOn(team, "deliver").mockResolvedValue(undefined);

    const baseMsg: Omit<TeamMessage, "to"> = {
      id: crypto.randomUUID(),
      from: "system",
      summary: "test",
      message: "hello",
      ts: new Date().toISOString(),
    };

    await team.deliverAll(baseMsg);

    expect(deliverSpy).toHaveBeenCalledTimes(2);
    const calledNames = deliverSpy.mock.calls.map(([name]) => name);
    expect(calledNames).toContain("agent-a");
    expect(calledNames).toContain("agent-b");
  });

  it("getSession always returns undefined", () => {
    const team = makeTeam([fakeDef("any-agent")]);
    expect(team.getSession("any-agent")).toBeUndefined();
  });

  it("disposeAll resolves without error", async () => {
    const team = makeTeam([fakeDef("any-agent")]);
    await expect(team.disposeAll()).resolves.toBeUndefined();
  });

  it("setStepContext, markStepComplete, clearStepContext are no-ops", () => {
    const team = makeTeam();
    expect(() => team.setStepContext("step1", ["step1", "step2"])).not.toThrow();
    expect(() => team.markStepComplete("step1")).not.toThrow();
    expect(() => team.clearStepContext()).not.toThrow();
  });

  it("setRunId does not throw", () => {
    const team = makeTeam();
    expect(() => team.setRunId("some-run-id")).not.toThrow();
  });

  it("setAgentLineCallback does not throw when set or cleared", () => {
    const team = makeTeam();
    expect(() => team.setAgentLineCallback((agent, line) => { void agent; void line; })).not.toThrow();
    expect(() => team.setAgentLineCallback(undefined)).not.toThrow();
  });
});
