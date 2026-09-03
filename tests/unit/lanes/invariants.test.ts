import { describe, expect, it } from "vitest";
import { CATALOG } from "../../../src/lanes/catalog.js";
import { checkInvariants } from "../../../src/lanes/invariants.js";
import type { NamedLane, StageDef } from "../../../src/lanes/schema.js";

const budget = { fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8 };

function named(over: Partial<NamedLane> & { stages: StageDef[]; name?: string }): NamedLane {
  return {
    name: over.name ?? "chore",
    class: "build",
    match: { kind: "chore" },
    priority: 100,
    budget,
    ...over,
  };
}

const buildStages: StageDef[] = [
  { name: "scope-check", host: "scope-check", locked: true },
  { name: "plan", agent: "planner" },
  { name: "steer", human: true, locked: true },
  { name: "implement", agent: "implementer" },
  { name: "test", host: "checks", locked: true },
  { name: "review", agent: "reviewer" },
  { name: "judge", agent: "judge", safetyGating: true, locked: true },
  { name: "publish", host: "publish", locked: true },
];

const rules = (lane: NamedLane): string[] => checkInvariants(lane, CATALOG).map((e) => e.rule);

describe("checkInvariants (build class)", () => {
  it("accepts a gateless chore-shaped lane", () => {
    expect(checkInvariants(named({ gateless: true, stages: buildStages }), CATALOG)).toEqual([]);
  });

  it("reports steer-missing", () => {
    const stages = buildStages.filter((s) => s.name !== "steer");
    expect(rules(named({ gateless: true, stages }))).toContain("steer-missing");
  });

  it("reports steer-after-implement", () => {
    const stages = [
      { name: "scope-check", host: "scope-check" },
      { name: "implement", agent: "implementer" },
      { name: "steer", human: true },
      { name: "judge", agent: "judge", safetyGating: true },
      { name: "publish", host: "publish" },
    ] as StageDef[];
    expect(rules(named({ gateless: true, stages }))).toContain("steer-after-implement");
  });

  it("reports judge-missing when safetyGating is absent", () => {
    const stages = buildStages.map((s) => (s.name === "judge" ? { ...s, safetyGating: false } : s));
    expect(rules(named({ gateless: true, stages }))).toContain("judge-missing");
  });

  it("reports publish-not-last", () => {
    const stages = [...buildStages, { name: "notes", human: true }];
    expect(rules(named({ gateless: true, stages }))).toContain("publish-not-last");
  });

  it("reports gate-missing when implementer is present and the lane is not gateless", () => {
    expect(rules(named({ stages: buildStages }))).toContain("gate-missing");
  });

  it("reports red-baseline-missing when gate exists without that predicate", () => {
    const stages = [
      { name: "plan", agent: "planner" },
      { name: "gate", agent: "tester", gates: ["snapshot"] },
      { name: "steer", human: true },
      { name: "implement", agent: "implementer" },
      { name: "judge", agent: "judge", safetyGating: true },
      { name: "publish", host: "publish" },
    ] as StageDef[];
    expect(rules(named({ name: "bug", match: { kind: "bug" }, stages }))).toContain("red-baseline-missing");
  });

  it("accepts a gated bug-shaped lane with red-baseline before implement", () => {
    const stages = [
      { name: "plan", agent: "planner" },
      { name: "gate", agent: "tester", mode: "gate-writer", gates: ["red-baseline"], locked: true },
      { name: "steer", human: true, locked: true },
      { name: "implement", agent: "implementer" },
      { name: "judge", agent: "judge", safetyGating: true, locked: true },
      { name: "publish", host: "publish", locked: true },
    ] as StageDef[];
    expect(checkInvariants(named({ name: "bug", match: { kind: "bug" }, stages }), CATALOG)).toEqual([]);
  });

  it("reports scope-check-first on a chore whose first stage is not host scope-check", () => {
    const stages = buildStages.filter((s) => s.name !== "scope-check");
    expect(rules(named({ gateless: true, stages }))).toContain("scope-check-first");
  });
});

describe("checkInvariants (catalog + other classes)", () => {
  it("reports unknown agent, host, mode and predicate", () => {
    const stages = [
      { name: "scope-check", host: "scope-check" },
      { name: "plan", agent: "wizard", mode: "not-a-mode", gates: ["not-a-gate"] },
      { name: "steer", human: true },
      { name: "implement", agent: "implementer" },
      { name: "judge", agent: "judge", safetyGating: true },
      { name: "publish", host: "nope" },
    ] as StageDef[];
    const r = rules(named({ gateless: true, stages }));
    expect(r).toContain("catalog-unknown-agent");
    expect(r).toContain("catalog-unknown-mode");
    expect(r).toContain("catalog-unknown-predicate");
    expect(r).toContain("catalog-unknown-host");
  });

  it("pre-build rejects implement/publish and requires a trailing human stage", () => {
    const r = rules(
      named({
        name: "grill",
        class: "pre-build",
        match: {},
        stages: [
          { name: "frame", agent: "codebase-cartographer" },
          { name: "implement", agent: "implementer" },
          { name: "publish", host: "publish" },
        ],
      }),
    );
    expect(r).toContain("prebuild-has-implement");
    expect(r).toContain("prebuild-has-publish");
    expect(r).toContain("prebuild-handoff-last");
  });

  it("meta rejects human/implement/gate/steer and requires security when: true", () => {
    const r = rules(
      named({
        name: "codify",
        class: "meta",
        match: { trigger: ["on-demand"] },
        stages: [
          { name: "steer", human: true },
          { name: "implement", agent: "implementer" },
          { name: "gate", agent: "tester" },
          { name: "security", agent: "security-auditor" },
          { name: "judge", agent: "judge", safetyGating: true },
          { name: "publish", host: "publish" },
        ],
      }),
    );
    expect(r).toContain("meta-has-human");
    expect(r).toContain("meta-has-implement");
    expect(r).toContain("meta-has-gate");
    expect(r).toContain("meta-has-steer");
    expect(r).toContain("meta-security-when");
  });
});
