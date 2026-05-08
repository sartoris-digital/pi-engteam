import { describe, it, expect } from "vitest";
import { RateLimitGuard } from "../../src/rateLimit/RateLimitGuard.js";
import type { RateLimitConfig } from "../../src/rateLimit/config.js";

function makeConfig(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    enabled: true,
    maxConcurrent: 10,
    providers: [],
    warnThresholdPct: 80,
    pauseThresholdPct: 95,
    ...overrides,
  };
}

describe("RateLimitGuard — disabled", () => {
  it("acquire always succeeds without tracking", () => {
    const guard = new RateLimitGuard(makeConfig({ enabled: false, providers: [
      { provider: "anthropic", rpmCeiling: 5, tpmCeiling: 1000, windowMs: 60000 },
    ] }));

    for (let i = 0; i < 20; i++) {
      const result = guard.acquire("anthropic");
      expect(result.ok).toBe(true);
    }

    // Status should show zero usage
    const s = guard.status();
    expect(s[0].rpmUsage).toBe(0);
  });
});

describe("RateLimitGuard — unconfigured provider", () => {
  it("pass-through when provider not in config", () => {
    const guard = new RateLimitGuard(makeConfig({ providers: [] }));
    const result = guard.acquire("openai");
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.ticketId).toBe("string");
  });
});

describe("RateLimitGuard — RPM", () => {
  it("100 acquires succeed within window", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 200,
        providers: [{ provider: "anthropic", rpmCeiling: 100, tpmCeiling: 1_000_000, windowMs: 60000 }],
      }),
      undefined,
      clock,
    );

    for (let i = 0; i < 100; i++) {
      const r = guard.acquire("anthropic");
      expect(r.ok).toBe(true);
    }
  });

  it("101st acquire fails with reason 'rpm'", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 200,
        providers: [{ provider: "anthropic", rpmCeiling: 100, tpmCeiling: 1_000_000, windowMs: 60000 }],
      }),
      undefined,
      clock,
    );

    for (let i = 0; i < 100; i++) {
      guard.acquire("anthropic");
    }

    const r = guard.acquire("anthropic");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rpm");
  });

  it("after window slides, acquire succeeds again", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 200,
        providers: [{ provider: "anthropic", rpmCeiling: 5, tpmCeiling: 1_000_000, windowMs: 60000 }],
      }),
      undefined,
      clock,
    );

    for (let i = 0; i < 5; i++) {
      guard.acquire("anthropic");
    }

    // Still blocked
    expect(guard.acquire("anthropic").ok).toBe(false);

    // Advance clock past window
    t = 60001;
    const r = guard.acquire("anthropic");
    expect(r.ok).toBe(true);
  });
});

describe("RateLimitGuard — sliding window boundary", () => {
  it("reclaims slot exactly at the window boundary (half-open semantics)", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 200,
        providers: [{ provider: "anthropic", rpmCeiling: 1, tpmCeiling: 1_000_000, windowMs: 60_000 }],
      }),
      undefined,
      clock,
    );

    // First acquire at t=0 fills the only slot.
    const r1 = guard.acquire("anthropic");
    expect(r1.ok).toBe(true);

    // Still inside the window at t=windowMs - 1 → blocked.
    t = 59_999;
    expect(guard.acquire("anthropic").ok).toBe(false);

    // Exactly at the boundary t=windowMs the t=0 entry must be evicted.
    t = 60_000;
    const r2 = guard.acquire("anthropic");
    expect(r2.ok).toBe(true);
  });
});

describe("RateLimitGuard — concurrent semaphore", () => {
  it("3rd acquire fails with 'concurrent', 4th succeeds after release", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 2,
        providers: [{ provider: "anthropic", rpmCeiling: 1000, tpmCeiling: 1_000_000, windowMs: 60000 }],
      }),
      undefined,
      clock,
    );

    const r1 = guard.acquire("anthropic");
    const r2 = guard.acquire("anthropic");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const r3 = guard.acquire("anthropic");
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe("concurrent");

    // Release one
    if (r1.ok) guard.release(r1.ticketId);

    const r4 = guard.acquire("anthropic");
    expect(r4.ok).toBe(true);
  });
});

describe("RateLimitGuard — TPM", () => {
  it("acquire fails with 'tpm' when estimated tokens would exceed ceiling", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 100,
        providers: [{ provider: "anthropic", rpmCeiling: 1000, tpmCeiling: 1000, windowMs: 60000 }],
      }),
      undefined,
      clock,
    );

    const r1 = guard.acquire("anthropic", { estimatedTokens: 600 });
    expect(r1.ok).toBe(true);

    const r2 = guard.acquire("anthropic", { estimatedTokens: 500 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("tpm");
  });
});

describe("RateLimitGuard — threshold events", () => {
  it("emits exactly one warn and one pause event at correct crossings", () => {
    let t = 0;
    const clock = () => t;
    const events: Array<{ kind: string }> = [];

    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 200,
        warnThresholdPct: 80,
        pauseThresholdPct: 95,
        providers: [{ provider: "anthropic", rpmCeiling: 100, tpmCeiling: 1_000_000, windowMs: 60000 }],
      }),
      (e) => events.push(e),
      clock,
    );

    // Fire 79 — below warn
    for (let i = 0; i < 79; i++) guard.acquire("anthropic");
    expect(events.filter((e) => e.kind === "warn")).toHaveLength(0);

    // 80th crosses warn threshold
    guard.acquire("anthropic");
    expect(events.filter((e) => e.kind === "warn")).toHaveLength(1);

    // Fire to 94 — still in warn zone, no extra warn, no pause
    for (let i = 0; i < 14; i++) guard.acquire("anthropic");
    expect(events.filter((e) => e.kind === "warn")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "pause")).toHaveLength(0);

    // 95th crosses pause threshold
    guard.acquire("anthropic");
    expect(events.filter((e) => e.kind === "pause")).toHaveLength(1);

    // More requests — no double-fire
    for (let i = 0; i < 3; i++) guard.acquire("anthropic");
    expect(events.filter((e) => e.kind === "warn")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "pause")).toHaveLength(1);
  });
});

describe("RateLimitGuard — status()", () => {
  it("returns sane data structure with expected fields", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        providers: [{ provider: "anthropic", rpmCeiling: 100, tpmCeiling: 50000, windowMs: 60000 }],
      }),
      undefined,
      clock,
    );

    guard.acquire("anthropic", { estimatedTokens: 300 });

    const s = guard.status();
    expect(s).toHaveLength(1);
    const entry = s[0];
    expect(entry.provider).toBe("anthropic");
    expect(entry.rpmUsage).toBe(1);
    expect(entry.tpmUsage).toBe(300);
    expect(entry.rpmCeiling).toBe(100);
    expect(entry.tpmCeiling).toBe(50000);
    expect(typeof entry.saturationPct).toBe("number");
    expect(typeof entry.inflight).toBe("number");
  });
});

describe("RateLimitGuard — reset()", () => {
  it("clears all counters and inflight", () => {
    let t = 0;
    const clock = () => t;
    const guard = new RateLimitGuard(
      makeConfig({
        maxConcurrent: 200,
        providers: [{ provider: "anthropic", rpmCeiling: 100, tpmCeiling: 1_000_000, windowMs: 60000 }],
      }),
      undefined,
      clock,
    );

    for (let i = 0; i < 50; i++) guard.acquire("anthropic");

    guard.reset();

    const s = guard.status();
    expect(s[0].rpmUsage).toBe(0);
    expect(s[0].tpmUsage).toBe(0);
    expect(s[0].inflight).toBe(0);

    // Should be able to acquire again
    const r = guard.acquire("anthropic");
    expect(r.ok).toBe(true);
  });
});
