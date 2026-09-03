import { describe, expect, it } from "vitest";
import {
  DEFAULT_V3_POLICY,
  DispatchDisabled,
  assertV3,
  v3Enabled,
  type V3Policy,
} from "../../../src/v3/dispatch.js";

function withFlag(flag: keyof V3Policy, enabled: boolean): { v3: V3Policy } {
  const v3 = structuredClone(DEFAULT_V3_POLICY);
  const block = v3[flag] as { enabled: boolean };
  block.enabled = enabled;
  return { v3 };
}

describe("v3Enabled", () => {
  it("is false when cfg.v3 is missing and never throws", () => {
    expect(v3Enabled({} as { v3?: V3Policy }, "collaborateExecution")).toBe(false);
    expect(v3Enabled({} as { v3?: V3Policy }, "crossRepoTools")).toBe(false);
    expect(v3Enabled({} as { v3?: V3Policy }, "learner")).toBe(false);
    expect(v3Enabled({ v3: DEFAULT_V3_POLICY }, "mergeQueue")).toBe(false);
  });

  it("is true only for the enabled flag", () => {
    const cfg = withFlag("collaborateExecution", true);
    expect(v3Enabled(cfg, "collaborateExecution")).toBe(true);
    expect(v3Enabled(cfg, "crossRepoTools")).toBe(false);
    expect(v3Enabled(cfg, "learner")).toBe(false);
  });
});

describe("assertV3", () => {
  it("throws DispatchDisabled naming the flag when off", () => {
    expect(() => assertV3({ v3: DEFAULT_V3_POLICY }, "mergeQueue")).toThrow(DispatchDisabled);
    try {
      assertV3({ v3: DEFAULT_V3_POLICY }, "mergeQueue");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchDisabled);
      expect((err as DispatchDisabled).flag).toBe("mergeQueue");
    }
  });
});

describe("DEFAULT_V3_POLICY", () => {
  it("defaults every enabled flag to false", () => {
    for (const value of Object.values(DEFAULT_V3_POLICY)) {
      expect(value.enabled).toBe(false);
    }
  });
});
