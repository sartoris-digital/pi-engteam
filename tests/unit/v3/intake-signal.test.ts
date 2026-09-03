import { describe, expect, it } from "vitest";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import { applySetFitSignal, bumpConfidenceOneStep, setfitReady } from "../../../src/v3/intake-signal.js";
import { StubEncoder } from "../../helpers/stub-setfit.js";

const fortyEach = { feature: 40, enhancement: 40, bug: 40, chore: 40 };
const chore39 = { feature: 40, enhancement: 40, bug: 40, chore: 39 };

function cfg(enabled: boolean, minLabelsPerClass = 40) {
  return {
    v3: {
      ...DEFAULT_V3_POLICY,
      setfit: { enabled, minLabelsPerClass },
    },
  };
}

describe("setfitReady", () => {
  it("is false when any class is under the minimum", () => {
    const r = setfitReady(chore39, 40);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/chore/);
  });

  it("is true when all four classes meet the minimum", () => {
    expect(setfitReady(fortyEach, 40)).toEqual({ ok: true, reason: "ready" });
  });

  it("is false when a class key is missing", () => {
    const r = setfitReady({ feature: 40, enhancement: 40, bug: 40 }, 40);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/chore|missing/);
  });
});

describe("applySetFitSignal", () => {
  it("does not call infer when the flag is off", async () => {
    const encoder = new StubEncoder();
    const result = await applySetFitSignal({
      cfg: cfg(false),
      text: "crash in login",
      counts: fortyEach,
      encoder,
    });
    expect(result.used).toBe(false);
    expect(encoder.inferCalls).toEqual([]);
  });

  it("does not call infer when cfg.v3 is missing", async () => {
    const encoder = new StubEncoder();
    const result = await applySetFitSignal({
      cfg: {},
      text: "crash in login",
      counts: fortyEach,
      encoder,
    });
    expect(result.used).toBe(false);
    expect(encoder.inferCalls).toEqual([]);
  });

  it("does not call infer when chore count is 39", async () => {
    const encoder = new StubEncoder();
    const result = await applySetFitSignal({
      cfg: cfg(true),
      text: "crash in login",
      counts: chore39,
      encoder,
    });
    expect(result.used).toBe(false);
    expect(encoder.inferCalls).toEqual([]);
  });

  it("returns a setfit prior when flag on, 40 each, stub returns bug", async () => {
    const encoder = new StubEncoder();
    const result = await applySetFitSignal({
      cfg: cfg(true),
      text: "crash in login",
      counts: fortyEach,
      encoder,
    });
    expect(result.used).toBe(true);
    expect(result.prior).toEqual({ kind: "bug", from: "setfit", score: 0.9 });
    expect(encoder.inferCalls).toEqual(["crash in login"]);
  });

  it("human factory:kind=chore still wins and infer is not called", async () => {
    const encoder = new StubEncoder();
    const result = await applySetFitSignal({
      cfg: cfg(true),
      text: "crash in login",
      counts: fortyEach,
      encoder,
      humanKind: "chore",
    });
    expect(result.used).toBe(false);
    expect(result.resolvedKind).toBe("chore");
    expect(encoder.inferCalls).toEqual([]);
  });

  it("does not override a tracker prior on disagreement; logs factory.v3.setfit.disagree", async () => {
    const encoder = new StubEncoder();
    const result = await applySetFitSignal({
      cfg: cfg(true),
      text: "crash in login",
      counts: fortyEach,
      encoder,
      trackerPrior: { kind: "feature", from: "label" },
    });
    expect(result.used).toBe(true);
    expect(result.prior?.kind).toBe("bug");
    expect(result.resolvedKind).toBe("feature");
    expect(result.event?.type).toBe("factory.v3.setfit.disagree");
    expect(result.confidenceBump).toBeUndefined();
  });

  it("bumps confidence at most one step when SetFit agrees with the tracker prior", async () => {
    const encoder = new StubEncoder();
    const result = await applySetFitSignal({
      cfg: cfg(true),
      text: "crash in login",
      counts: fortyEach,
      encoder,
      trackerPrior: { kind: "bug", from: "label" },
    });
    expect(result.used).toBe(true);
    expect(result.resolvedKind).toBe("bug");
    expect(result.confidenceBump).toBe(true);
    expect(bumpConfidenceOneStep("LOW")).toBe("MEDIUM");
    expect(bumpConfidenceOneStep("MEDIUM")).toBe("HIGH");
    expect(bumpConfidenceOneStep("HIGH")).toBe("HIGH");
  });
});
