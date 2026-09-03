import { describe, expect, it } from "vitest";
import {
  AGENTS,
  CATALOG,
  HOST_ACTIONS,
  IMPLEMENT_CLASS_STAGES,
  MODES,
  PARAMETERISED_PREDICATES,
  PREDICATES,
  isAgent,
  isHostAction,
  isImplementClassStage,
  isMode,
  isPredicate,
  mostRecentImplementStage,
  parsePredicate,
} from "../../../src/lanes/catalog.js";

describe("catalog", () => {
  it("lists the 13 roster agents in spec §4.5 order", () => {
    expect([...AGENTS]).toEqual([
      "issue-analyst", "planner", "architect", "tester", "implementer", "reviewer",
      "security-auditor", "judge", "verifier", "root-cause-debugger", "discoverer",
      "codebase-cartographer", "codifier",
    ]);
    expect(AGENTS).toHaveLength(13);
    expect(isAgent("planner")).toBe(true);
    expect(isAgent("fusion-synthesizer")).toBe(false);
  });

  it("lists the v0 host actions (no deps/codify-*)", () => {
    expect([...HOST_ACTIONS]).toEqual(["scope-check", "checks", "publish", "escalate"]);
    expect(isHostAction("scope-check")).toBe(true);
    expect(isHostAction("deps")).toBe(false);
  });

  it("lists v0 modes plus refute, fuse-synthesize, grill and implement-class stage names", () => {
    expect([...MODES]).toEqual([
      "approach", "validate", "gate-writer", "gate-triage", "codified-diff", "refute", "fuse-synthesize", "grill",
    ]);
    expect(isMode("approach")).toBe(true);
    expect(isMode("grill")).toBe(true);
    expect(isMode("codified-diff")).toBe(true);
    expect([...IMPLEMENT_CLASS_STAGES]).toEqual(["implement", "fix"]);
    expect(isImplementClassStage("implement")).toBe(true);
    expect(isImplementClassStage("plan")).toBe(false);
  });

  it("accepts exact predicates and parameterised prefixes", () => {
    expect(PREDICATES).toContain("sections:");
    expect(PREDICATES).toContain("red-baseline");
    expect(PREDICATES).toContain("no-generated-docs");
    expect([...PARAMETERISED_PREDICATES]).toEqual(["sections:", "snapshot:"]);
    expect(isPredicate("red-baseline")).toBe(true);
    expect(isPredicate("sections:plan.md:Files to touch,Steps,Verify")).toBe(true);
    expect(isPredicate("snapshot:testDir")).toBe(true);
    expect(isPredicate("snapshot")).toBe(true);
    expect(isPredicate("not-a-gate")).toBe(false);
  });

  it("parsePredicate splits id:arg for prefix predicates", () => {
    expect(parsePredicate("red-baseline")).toEqual({ id: "red-baseline" });
    expect(parsePredicate("snapshot:testDir")).toEqual({ id: "snapshot", arg: "testDir" });
    expect(parsePredicate("sections:plan.md:Files to touch,Steps,Verify")).toEqual({
      id: "sections",
      arg: "plan.md:Files to touch,Steps,Verify",
    });
  });

  it("mostRecentImplementStage walks backward from a named stage", () => {
    const stages = ["plan", "steer", "implement", "test", "review", "judge"].map((name) => ({ name }));
    expect(mostRecentImplementStage(stages)).toBe("implement");
    expect(mostRecentImplementStage(stages, "test")).toBe("implement");
    expect(mostRecentImplementStage(stages, "steer")).toBeUndefined();
    expect(CATALOG.agents).toBe(AGENTS);
    expect(CATALOG.hostActions).toBe(HOST_ACTIONS);
  });
});
