import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { VerdictPayloadSchema, VERDICT_MAX_BYTES, VERDICT_VALUES } from "../../../src/runtime/types.js";
import { generatedMarker } from "../../../src/runtime/marker.js";
import { generatedMarker as homeGeneratedMarker } from "../../../src/home.js";

describe("VerdictPayloadSchema", () => {
  it("accepts a minimal payload", () => {
    expect(Value.Check(VerdictPayloadSchema, { step: "implement", verdict: "PASS" })).toBe(true);
  });

  it("accepts every optional list field and commit_message", () => {
    const full = {
      step: "implement",
      verdict: "NEEDS_MORE",
      issues: ["a"],
      artifacts: ["/tmp/x.md"],
      commit_message: "feat: x",
      changedFiles: ["src/a.ts"],
      dependenciesRequested: ["left-pad"],
      testChanges: ["tests/a.test.ts"],
      outOfScope: ["docs/"],
      questions: ["why?"],
      flags: ["approval-needed"],
      learnings: ["l1"],
      scripts: [{ path: "scripts/seed.py", purpose: "seed", inputsObserved: ["SECRET_NAME"] }],
    };
    expect(Value.Check(VerdictPayloadSchema, full)).toBe(true);
  });

  it("rejects a missing step, an empty step and an unknown verdict", () => {
    expect(Value.Check(VerdictPayloadSchema, { verdict: "PASS" })).toBe(false);
    expect(Value.Check(VerdictPayloadSchema, { step: "", verdict: "PASS" })).toBe(false);
    expect(Value.Check(VerdictPayloadSchema, { step: "implement", verdict: "MAYBE" })).toBe(false);
  });

  it("rejects non-string list members", () => {
    expect(Value.Check(VerdictPayloadSchema, { step: "implement", verdict: "FAIL", issues: [1] })).toBe(false);
  });

  it("drops unknown keys with Value.Clean", () => {
    const cleaned = Value.Clean(VerdictPayloadSchema, { step: "implement", verdict: "PASS", extra: 1, flags: ["x"] });
    expect(cleaned).toEqual({ step: "implement", verdict: "PASS", flags: ["x"] });
  });

  it("exposes the verdict values and the 256 KB cap", () => {
    expect(VERDICT_VALUES).toEqual(["PASS", "FAIL", "NEEDS_MORE"]);
    expect(VERDICT_MAX_BYTES).toBe(256 * 1024);
  });
});

describe("runtime marker shim", () => {
  it("re-exports the single src/home.ts definition rather than retyping the line", () => {
    expect(generatedMarker).toBe(homeGeneratedMarker);
    expect(generatedMarker("run-42")).toBe("<!-- pi-sdlc-factory generated · run run-42 · do not commit -->");
  });
});
