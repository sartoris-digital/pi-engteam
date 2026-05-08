import { describe, it, expect, vi } from "vitest";
import { TeamRuntime } from "../../../src/team/TeamRuntime.js";
import type { AgentDefinition, TeamMessage } from "../../../src/types.js";

function makeMessage(to: string): TeamMessage {
  return {
    id: "test-msg-id",
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
  return { emit: vi.fn(), subscribeToSession: vi.fn(), subscribeToBus: vi.fn() } as any;
}

function fakeDef(name: string, model = "claude-haiku-4.6"): AgentDefinition {
  return { name, description: "test", model, systemPrompt: "You are a test agent." };
}

describe("TeamRuntime rate-limit wiring", () => {
  it("calls acquire(provider) with the model→provider mapping", async () => {
    const acquire = vi.fn().mockReturnValue({ ok: false, reason: "rpm", retryAfterMs: 1 });
    const release = vi.fn();
    const guard = { acquire, release } as any;

    const team = new TeamRuntime({
      cwd: "/tmp",
      bus: makeMockBus(),
      observer: makeMockObserver(),
      runsDir: "/tmp",
      agentDefs: [fakeDef("a", "claude-opus-4.6")],
      rateLimit: guard,
    });

    // Both acquire calls fail → deliver throws.
    await expect(team.deliver("a", makeMessage("a"))).rejects.toThrow(/RateLimit blocked/);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls[0][0]).toBe("anthropic");
    // Release should NOT be called when ticket never succeeded.
    expect(release).not.toHaveBeenCalled();
  });

  it("retries acquire once after the retry delay before failing", async () => {
    const acquire = vi
      .fn()
      .mockReturnValueOnce({ ok: false, reason: "concurrent", retryAfterMs: 5 })
      .mockReturnValueOnce({ ok: false, reason: "concurrent", retryAfterMs: 5 });
    const release = vi.fn();
    const guard = { acquire, release } as any;

    const team = new TeamRuntime({
      cwd: "/tmp",
      bus: makeMockBus(),
      observer: makeMockObserver(),
      runsDir: "/tmp",
      agentDefs: [fakeDef("a", "gpt-4o")],
      rateLimit: guard,
    });

    await expect(team.deliver("a", makeMessage("a"))).rejects.toThrow(
      /RateLimit blocked: provider=openai, reason=concurrent/,
    );
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls[0][0]).toBe("openai");
    expect(release).not.toHaveBeenCalled();
  });

  it("uses provider 'unknown' for unrecognized models", async () => {
    const acquire = vi.fn().mockReturnValue({ ok: false, reason: "rpm", retryAfterMs: 1 });
    const guard = { acquire, release: vi.fn() } as any;

    const team = new TeamRuntime({
      cwd: "/tmp",
      bus: makeMockBus(),
      observer: makeMockObserver(),
      runsDir: "/tmp",
      agentDefs: [fakeDef("a", "llama-3-70b")],
      rateLimit: guard,
    });

    await expect(team.deliver("a", makeMessage("a"))).rejects.toThrow(/provider=unknown/);
  });
});
