import { describe, expect, it } from "vitest";
import { WhenError, evalWhen, parseWhen, type WhenContext } from "../../../src/lanes/expr.js";

const ctx = (over: WhenContext = {}): WhenContext => ({
  tier: "low",
  kind: "chore",
  lane: "chore",
  iteration: 0,
  rounds: {},
  artifacts: {},
  ...over,
});

describe("evalWhen", () => {
  it("evaluates true/false literals", () => {
    expect(evalWhen("true", ctx())).toBe(true);
    expect(evalWhen("false", ctx())).toBe(false);
    expect(parseWhen("true")).toEqual({ type: "literal", value: true });
  });

  it("compares == and != on strings and numbers", () => {
    expect(evalWhen("tier == 'elevated'", ctx({ tier: "elevated" }))).toBe(true);
    expect(evalWhen("tier == 'elevated'", ctx({ tier: "low" }))).toBe(false);
    expect(evalWhen("tier != 'elevated'", ctx({ tier: "low" }))).toBe(true);
    expect(evalWhen("iteration == 0", ctx({ iteration: 0 }))).toBe(true);
    expect(evalWhen("iteration == 2", ctx({ iteration: 0 }))).toBe(false);
  });

  it("short-circuits && and ||", () => {
    expect(evalWhen("tier == 'low' && kind == 'chore'", ctx())).toBe(true);
    expect(evalWhen("tier == 'elevated' && kind == 'chore'", ctx())).toBe(false);
    expect(evalWhen("tier == 'elevated' || kind == 'chore'", ctx())).toBe(true);
    expect(evalWhen("false && missing.nope == 'x'", ctx())).toBe(false); // missing path never reached
  });

  it("negates with !", () => {
    expect(evalWhen("!false", ctx())).toBe(true);
    expect(evalWhen("!(tier == 'elevated')", ctx())).toBe(true);
  });

  it("evaluates `in` over arrays and object keys", () => {
    expect(evalWhen("'hotfix' in labels", ctx({ labels: ["hotfix", "bug"] } as WhenContext))).toBe(true);
    expect(evalWhen("'hotfix' in labels", ctx({ labels: ["bug"] } as WhenContext))).toBe(false);
    expect(evalWhen("'architecture' in flags", ctx({ flags: { architecture: true } }))).toBe(true);
    expect(evalWhen("flags.architecture", ctx({ flags: { architecture: true } }))).toBe(true);
    expect(evalWhen("flags.architecture", ctx({ flags: {} }))).toBe(false);
  });

  it("walks dotted paths; missing paths are undefined, not an error", () => {
    expect(evalWhen("brief.reproSteps == 'absent'", ctx({ brief: { reproSteps: "absent" } }))).toBe(true);
    expect(evalWhen("brief.reproSteps == 'absent'", ctx({}))).toBe(false);
    expect(evalWhen("size == 'L'", ctx({ size: "L" }))).toBe(true);
  });

  it("evaluates diff.touches(securityPaths) via ctx.diff.touches", () => {
    const touches = (k: string): boolean => k === "securityPaths";
    expect(evalWhen("diff.touches(securityPaths)", ctx({ diff: { touches } }))).toBe(true);
    expect(evalWhen("diff.touches(riskPaths)", ctx({ diff: { touches } }))).toBe(false);
    expect(evalWhen("tier == 'elevated' || diff.touches(securityPaths)", ctx({ tier: "low", diff: { touches } }))).toBe(true);
    expect(evalWhen("diff.touches(securityPaths)", ctx({}))).toBe(false);
  });

  it("throws WhenError on trailing junk, unknown calls, or empty input", () => {
    expect(() => evalWhen("true true", ctx())).toThrow(WhenError);
    expect(() => evalWhen("foo.bar(x)", ctx())).toThrow(/touches/);
    expect(() => evalWhen("   ", ctx())).toThrow(WhenError);
    expect(() => evalWhen("size == 'L' || flags.architecture", ctx({ size: "S", flags: { architecture: true } }))).not.toThrow();
  });
});
