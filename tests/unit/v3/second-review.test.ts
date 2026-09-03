import { describe, expect, it } from "vitest";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import {
  applySecondReview,
  mergeSecondReview,
  pickSecondSlot,
  sampleSecondReview,
  shouldSecondReview,
} from "../../../src/v3/second-review.js";
import type { FusionSlot } from "../../../src/fusion/types.js";

const openai: FusionSlot = { name: "primary", model: "openai/gpt-4.1" };
const anthropic: FusionSlot = { name: "second", model: "anthropic/claude-sonnet" };
const openaiAlt: FusionSlot = { name: "alt", model: "openai/o3" };

function cfg(enabled: boolean, rate = 0.1) {
  return { v3: { ...DEFAULT_V3_POLICY, secondReview: { enabled, rate } } };
}

function firstHit(rate: number, prefix = "run"): string {
  for (let i = 0; i < 20_000; i++) {
    const id = `${prefix}-${i}`;
    if (sampleSecondReview(id, rate)) return id;
  }
  throw new Error("no hash hit");
}

function firstMiss(rate: number, prefix = "miss"): string {
  for (let i = 0; i < 20_000; i++) {
    const id = `${prefix}-${i}`;
    if (!sampleSecondReview(id, rate)) return id;
  }
  throw new Error("no hash miss");
}

describe("sampleSecondReview", () => {
  it("is stable for the same runId", () => {
    const id = "run-stable-1";
    const a = sampleSecondReview(id, 0.1);
    expect(sampleSecondReview(id, 0.1)).toBe(a);
    expect(sampleSecondReview(id, 0.1)).toBe(a);
  });

  it("hits 8–12% of 10_000 ids at rate 0.10", () => {
    let hits = 0;
    for (let i = 0; i < 10_000; i++) {
      if (sampleSecondReview(`id-${i}`, 0.1)) hits += 1;
    }
    expect(hits / 10_000).toBeGreaterThanOrEqual(0.08);
    expect(hits / 10_000).toBeLessThanOrEqual(0.12);
  });
});

describe("pickSecondSlot", () => {
  it("returns a different-vendor slot", () => {
    expect(pickSecondSlot([openai, anthropic], openai.model)).toEqual(anthropic);
  });

  it("returns null when the stack is same-vendor only", () => {
    expect(pickSecondSlot([openai, openaiAlt], openai.model)).toBeNull();
  });
});

describe("shouldSecondReview", () => {
  it("is always false when the flag is off, even if the hash would hit", () => {
    const id = firstHit(0.1);
    expect(sampleSecondReview(id, 0.1)).toBe(true);
    expect(
      shouldSecondReview(cfg(false), {
        runId: id,
        tier: "low",
        firstModel: openai.model,
        stack: [openai, anthropic],
      }),
    ).toBe(false);
  });

  it("is false for elevated tier", () => {
    const id = firstHit(0.1);
    expect(
      shouldSecondReview(cfg(true), {
        runId: id,
        tier: "elevated",
        firstModel: openai.model,
        stack: [openai, anthropic],
      }),
    ).toBe(false);
  });

  it("is false when pickSecondSlot is null", () => {
    const id = firstHit(0.1);
    expect(
      shouldSecondReview(cfg(true), {
        runId: id,
        tier: "low",
        firstModel: openai.model,
        stack: [openai, openaiAlt],
      }),
    ).toBe(false);
  });

  it("is true for a low-tier hash hit with a different vendor", () => {
    const id = firstHit(0.1);
    expect(
      shouldSecondReview(cfg(true), {
        runId: id,
        tier: "low",
        firstModel: openai.model,
        stack: [openai, anthropic],
      }),
    ).toBe(true);
  });

  it("is false on a hash miss even when enabled", () => {
    const id = firstMiss(0.1);
    expect(
      shouldSecondReview(cfg(true), {
        runId: id,
        tier: "low",
        firstModel: openai.model,
        stack: [openai, anthropic],
      }),
    ).toBe(false);
  });
});

describe("mergeSecondReview", () => {
  it("is PASS only when both PASS", () => {
    expect(mergeSecondReview({ verdict: "PASS" }, { verdict: "PASS" })).toEqual({ verdict: "PASS" });
  });

  it("FAIL wins and concatenates attributed issues", () => {
    const merged = mergeSecondReview(
      { verdict: "PASS", issues: ["nit"] },
      { verdict: "FAIL", issues: ["missing citation"] },
    );
    expect(merged.verdict).toBe("FAIL");
    expect(merged.issues).toEqual(["[primary] nit", "[sampled] missing citation"]);
  });

  it("NEEDS_MORE from either wins over PASS", () => {
    expect(mergeSecondReview({ verdict: "NEEDS_MORE" }, { verdict: "PASS" }).verdict).toBe("NEEDS_MORE");
    expect(mergeSecondReview({ verdict: "PASS" }, { verdict: "NEEDS_MORE" }).verdict).toBe("NEEDS_MORE");
  });

  it("FAIL outvotes NEEDS_MORE", () => {
    expect(mergeSecondReview({ verdict: "FAIL", issues: ["a"] }, { verdict: "NEEDS_MORE" }).verdict).toBe("FAIL");
  });
});

describe("applySecondReview host wrapper", () => {
  it("flag off does not invoke merge or the sampled slot", () => {
    const id = firstHit(0.1);
    let sampled = 0;
    let merged = 0;
    const out = applySecondReview({
      cfg: cfg(false),
      run: { runId: id, tier: "low" },
      stack: [openai, anthropic],
      firstModel: openai.model,
      primary: { verdict: "PASS" },
      runSampled: () => {
        sampled += 1;
        return { verdict: "FAIL", issues: ["should not run"] };
      },
      mergeFn: (a, b) => {
        merged += 1;
        return mergeSecondReview(a, b);
      },
    });
    expect(out.applied).toBe(false);
    expect(out.verdict).toEqual({ verdict: "PASS" });
    expect(sampled).toBe(0);
    expect(merged).toBe(0);
  });

  it("sampled FAIL cannot be outvoted into PASS", () => {
    const id = firstHit(0.1);
    const out = applySecondReview({
      cfg: cfg(true),
      run: { runId: id, tier: "low" },
      stack: [openai, anthropic],
      firstModel: openai.model,
      primary: { verdict: "PASS" },
      runSampled: () => ({ verdict: "FAIL", issues: ["blocking"] }),
    });
    expect(out.applied).toBe(true);
    expect(out.verdict.verdict).toBe("FAIL");
    expect(out.evidence?.fusion.mode).toBe("second-sample");
    expect(out.slot).toEqual(anthropic);
  });
});
