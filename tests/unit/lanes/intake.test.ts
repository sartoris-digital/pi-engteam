import { describe, expect, it } from "vitest";
import type { Brief } from "../../../src/intake/brief-schema.js";
import { LaneInvariantError } from "../../../src/lanes/invariants.js";
import { selectLane } from "../../../src/lanes/intake.js";
import type { LaneDef } from "../../../src/lanes/schema.js";

const budget = { fixRounds: 1, maxWallSeconds: 60, maxCostUsd: 1 };
const stages: LaneDef["stages"] = [{ name: "plan", agent: "planner" }];

function lane(over: Partial<LaneDef> & Pick<LaneDef, "match" | "priority">): LaneDef {
  return { budget, stages, ...over };
}

function brief(over: Partial<Brief> = {}): Brief {
  return {
    kind: "chore",
    flags: [],
    size: "S",
    reproSteps: "absent",
    acceptanceCriteria: [],
    likelyPaths: ["src/greet.ts"],
    questions: [],
    goal: "chore: greet",
    samples: { n: 0, kinds: [], acAgreement: 1 },
    prior: { from: "human" },
    confidence: "HIGH",
    tier: "low",
    lane: "chore",
    ...over,
  };
}

describe("selectLane", () => {
  it("picks the first match in descending priority", () => {
    const lanes: Record<string, LaneDef> = {
      chore: lane({ match: { kind: "chore" }, priority: 100 }),
      docs: lane({ match: { kind: "chore", likelyPaths: ["docs/**"] }, priority: 110 }),
      hotfix: lane({ match: { kind: "bug", labels: ["hotfix"] }, priority: 10 }),
    };
    expect(selectLane(lanes, brief({ kind: "chore", lane: "chore" }), [])).toBe("chore");
    expect(selectLane(lanes, brief({ kind: "chore", likelyPaths: ["docs/readme.md"] }), [])).toBe("docs");
    expect(selectLane(lanes, brief({ kind: "bug", lane: "bug" }), ["hotfix"])).toBe("hotfix");
  });

  it("returns a forced --lane grill even for a chore brief", () => {
    const lanes: Record<string, LaneDef> = {
      chore: lane({ match: { kind: "chore" }, priority: 100 }),
      grill: lane({ match: { trigger: ["grill"] }, priority: 50 }),
    };
    expect(selectLane(lanes, brief({ kind: "chore" }), [], "grill")).toBe("grill");
  });

  it("throws on two priority-10 overlapping lanes", () => {
    const lanes: Record<string, LaneDef> = {
      a: lane({ match: { kind: "bug" }, priority: 10 }),
      b: lane({ match: { kind: "bug", labels: ["hotfix"] }, priority: 10 }),
    };
    expect(() => selectLane(lanes, brief({ kind: "bug" }), ["hotfix"])).toThrow(LaneInvariantError);
    expect(() => selectLane(lanes, brief({ kind: "bug" }), ["hotfix"])).toThrow(/match-overlap|overlap/i);
  });
});
