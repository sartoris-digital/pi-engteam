import { describe, expect, it } from "vitest";
import {
  AGENTS,
  CATALOG,
  HOST_ACTIONS,
  IMPLEMENT_CLASS_STAGES,
  MODES,
  PARAMETERISED_PREDICATES,
  PREDICATES,
  agentsFor,
  isAgent,
  isHostAction,
  isImplementClassStage,
  isMode,
  isPredicate,
  mostRecentImplementStage,
  parsePredicate,
} from "../../../src/lanes/catalog.js";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";

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

  it("lists v0 host actions plus the v1.5 codify hosts (no deps)", () => {
    expect([...HOST_ACTIONS]).toEqual([
      "scope-check", "checks", "publish", "escalate",
      "codify-mine", "codify-validate", "codify-publish", "codified-implement",
    ]);
    expect(isHostAction("scope-check")).toBe(true);
    expect(isHostAction("codify-mine")).toBe(true);
    expect(isHostAction("codify-validate")).toBe(true);
    expect(isHostAction("codify-publish")).toBe(true);
    expect(isHostAction("codified-implement")).toBe(true);
    expect(isHostAction("deps")).toBe(false);
  });

  it("lists v0 modes plus grill and the v1.5 codify modes", () => {
    expect([...MODES]).toEqual([
      "approach", "validate", "gate-writer", "gate-triage", "codified-diff", "refute", "fuse-synthesize", "grill",
      "assess", "generate", "repair", "codified", "approve-codify",
    ]);
    expect(isMode("approach")).toBe(true);
    expect(isMode("grill")).toBe(true);
    expect(isMode("codified-diff")).toBe(true);
    expect(isMode("assess")).toBe(true);
    expect(isMode("generate")).toBe(true);
    expect(isMode("repair")).toBe(true);
    expect(isMode("codified")).toBe(true);
    expect(isMode("approve-codify")).toBe(true);
    expect(isMode("not-a-mode")).toBe(false);
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
    for (const id of [
      "evidence-signatures-verified", "candidates-schema", "candidates-nonempty", "assessment-schema",
      "rubric-hard", "oracles-select-observed-branches", "provenance-reproduces-members", "staged-layout",
      "header-template", "no-fixture-edits", "lint-clean", "skill-rendered", "dev-fixtures", "sealed-fixtures",
      "idempotent", "deterministic", "smoke-current-base", "matcher-overlap", "bindings-match-assessment",
      "deps-allowlist", "deps-locked", "no-hidden-unicode", "no-network-ast", "skill-injection-screen",
      "all-fixtures-pass", "manifest-sha-matches", "fusion-matches-lane", "artifact-sha-matches-judged",
    ]) {
      expect(PREDICATES, id).toContain(id);
      expect(isPredicate(id), id).toBe(true);
    }
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

  it("does not register learner on the default catalog even if the prompt exists", () => {
    expect(AGENTS).toHaveLength(13);
    expect(CATALOG.agents).not.toContain("learner");
    expect(isAgent("learner")).toBe(false);
    expect(agentsFor({ v3: DEFAULT_V3_POLICY }, [])).toEqual([...AGENTS]);
  });
});
