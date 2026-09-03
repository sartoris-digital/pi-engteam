import { describe, expect, it } from "vitest";
import { CATALOG } from "../../../src/lanes/catalog.js";
import {
  checkAllInvariants,
  checkOverrideInvariants,
  matchesOverlap,
} from "../../../src/lanes/invariants.js";
import type { LaneDef, StageDef } from "../../../src/lanes/schema.js";

const bugStages: StageDef[] = [
  { name: "diagnose", agent: "root-cause-debugger" },
  { name: "plan", agent: "planner" },
  { name: "gate", agent: "tester", mode: "gate-writer", gates: ["red-baseline", "snapshot", "manifest-record"], locked: true },
  { name: "steer", human: true, locked: true },
  { name: "implement", agent: "implementer" },
  { name: "test", host: "checks", locked: true },
  { name: "review", agent: "reviewer", gates: ["citations", "verdict-consistent", "scope-report"] },
  { name: "security", agent: "security-auditor", when: "tier == 'elevated' || diff.touches(securityPaths)" },
  { name: "judge", agent: "judge", safetyGating: true, locked: true, gates: ["evidence-signed", "no-synthesized", "checklist", "ac-spotcheck"] },
  { name: "publish", host: "publish", locked: true },
];

const bug: LaneDef = {
  class: "build",
  match: { kind: "bug" },
  priority: 100,
  budget: { fixRounds: 3, maxWallSeconds: 5400, maxCostUsd: 20 },
  stages: bugStages,
};

const chore: LaneDef = {
  class: "build",
  gateless: true,
  match: { kind: "chore" },
  priority: 100,
  budget: { fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8 },
  stages: [
    { name: "scope-check", host: "scope-check", locked: true },
    { name: "plan", agent: "planner" },
    { name: "steer", human: true, locked: true },
    { name: "implement", agent: "implementer" },
    { name: "test", host: "checks", locked: true },
    { name: "review", agent: "reviewer", gates: ["citations", "verdict-consistent", "scope-report"] },
    { name: "security", agent: "security-auditor", when: "tier == 'elevated' || diff.touches(securityPaths)" },
    { name: "judge", agent: "judge", safetyGating: true, locked: true },
    { name: "publish", host: "publish", locked: true },
  ],
};

const builtins = { bug, chore };

describe("matchesOverlap", () => {
  it("treats empty labels as unconstrained and equal kinds as overlapping", () => {
    expect(matchesOverlap({ kind: "bug" }, { kind: "bug" })).toBe(true);
    expect(matchesOverlap({ kind: "bug" }, { kind: "bug", labels: ["hotfix"] })).toBe(true);
    expect(matchesOverlap({ kind: "bug", labels: ["hotfix"] }, { kind: "bug", labels: ["sev-1"] })).toBe(false);
    expect(matchesOverlap({ kind: "bug" }, { kind: "chore" })).toBe(false);
    expect(matchesOverlap({ kind: "bug", tier: "low" }, { kind: "bug", tier: "elevated" })).toBe(false);
  });
});

describe("checkOverrideInvariants", () => {
  it("reports locked-removed when a builtin locked stage disappears", () => {
    const effective = { ...builtins, bug: { ...bug, stages: bug.stages.filter((s) => s.name !== "judge") } };
    const rules = checkOverrideInvariants(builtins, effective, CATALOG).map((e) => e.rule);
    expect(rules).toContain("locked-removed");
  });

  it("reports locked-reordered when locked stages change relative order", () => {
    const stages = [...bug.stages];
    const judge = stages.findIndex((s) => s.name === "judge");
    const steer = stages.findIndex((s) => s.name === "steer");
    const moved = [...stages];
    const [j] = moved.splice(judge, 1);
    moved.splice(steer, 0, j!);
    const rules = checkOverrideInvariants(builtins, { ...builtins, bug: { ...bug, stages: moved } }, CATALOG).map((e) => e.rule);
    expect(rules).toContain("locked-reordered");
  });

  it("reports gates-removed when any same-name stage drops a gate (locked or not)", () => {
    const locked = bug.stages.map((s) => (s.name === "gate" ? { ...s, gates: ["snapshot"] } : s));
    expect(checkOverrideInvariants(builtins, { ...builtins, bug: { ...bug, stages: locked } }, CATALOG).map((e) => e.rule)).toContain("gates-removed");
    const unlocked = chore.stages.map((s) => (s.name === "review" ? { ...s, gates: ["citations"] } : s));
    expect(checkOverrideInvariants(builtins, { ...builtins, chore: { ...chore, stages: unlocked } }, CATALOG).map((e) => e.rule)).toContain("gates-removed");
  });

  it("reports budget-loosened when any cap grows", () => {
    const rules = checkOverrideInvariants(
      builtins,
      { ...builtins, chore: { ...chore, budget: { ...chore.budget, fixRounds: 5 } } },
      CATALOG,
    ).map((e) => e.rule);
    expect(rules).toContain("budget-loosened");
  });

  it("reports when-loosened if an always-on stage gains a condition", () => {
    const stages = chore.stages.map((s) => (s.name === "review" ? { ...s, when: "tier == 'elevated'" } : s));
    const rules = checkOverrideInvariants(builtins, { ...builtins, chore: { ...chore, stages } }, CATALOG).map((e) => e.rule);
    expect(rules).toContain("when-loosened");
  });

  it("allows tightening: lower budget, extra gates, when: true on a conditional stage", () => {
    const stages = bug.stages.map((s) => {
      if (s.name === "review") return { ...s, gates: [...(s.gates ?? []), "checklist"] };
      if (s.name === "security") return { ...s, when: "true" };
      return s;
    });
    const effective = {
      ...builtins,
      bug: { ...bug, budget: { ...bug.budget, maxCostUsd: 15 }, stages },
    };
    expect(checkOverrideInvariants(builtins, effective, CATALOG)).toEqual([]);
  });

  it("reports match-overlap for two effective lanes at the same priority", () => {
    const bug2: LaneDef = { ...bug, match: { kind: "bug" }, priority: 100 };
    const rules = checkOverrideInvariants(builtins, { ...builtins, bug2 }, CATALOG).map((e) => e.rule);
    expect(rules).toEqual(["match-overlap"]);
  });

  it("reports meta-added-by-repo when a non-builtin class: meta lane appears", () => {
    const othermeta: LaneDef = {
      class: "meta",
      match: { trigger: ["on-demand"] },
      priority: -11,
      budget: { fixRounds: 1, maxWallSeconds: 1800, maxCostUsd: 6 },
      stages: [
        { name: "mine", host: "codify-mine", locked: true },
        { name: "validate", host: "codify-validate", locked: true },
        { name: "security", agent: "security-auditor", when: "true", locked: true },
        { name: "judge", agent: "judge", safetyGating: true, locked: true },
        { name: "publish", host: "codify-publish", locked: true },
      ],
    };
    const rules = checkOverrideInvariants(builtins, { ...builtins, othermeta }, CATALOG).map((e) => e.rule);
    expect(rules).toContain("meta-added-by-repo");
  });

  it("checkAllInvariants combines class errors with override errors", () => {
    const broken = {
      ...builtins,
      bug: {
        ...bug,
        budget: { ...bug.budget, fixRounds: 9 },
        stages: bug.stages.filter((s) => s.name !== "steer"),
      },
    };
    const rules = checkAllInvariants(builtins, broken, CATALOG).map((e) => e.rule);
    expect(rules).toContain("steer-missing");
    expect(rules).toContain("budget-loosened");
    expect(rules).toContain("locked-removed");
  });
});
