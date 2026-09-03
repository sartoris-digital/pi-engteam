import { describe, expect, it } from "vitest";
import { LaneLoadError, mergeLanes, mergeStages } from "../../../src/lanes/load.js";
import type { LaneLayerFile, StageDef } from "../../../src/lanes/schema.js";

const bugFile: LaneLayerFile = {
  schemaVersion: 1,
  lanes: {
    bug: {
      class: "build",
      match: { kind: "bug" },
      priority: 100,
      budget: { fixRounds: 3, maxWallSeconds: 5400, maxCostUsd: 20 },
      stages: [
        { name: "diagnose", agent: "root-cause-debugger" },
        { name: "plan", agent: "planner" },
        { name: "gate", agent: "tester", locked: true },
        { name: "steer", human: true, locked: true },
        { name: "implement", agent: "implementer" },
        { name: "test", host: "checks", locked: true },
        { name: "review", agent: "reviewer", gates: ["citations", "verdict-consistent", "scope-report"] },
        { name: "security", agent: "security-auditor", when: "tier == 'elevated'" },
        { name: "judge", agent: "judge", safetyGating: true, locked: true },
        { name: "publish", host: "publish", locked: true },
      ],
    },
  },
};

describe("mergeStages", () => {
  it("overlays by name, removes, and insertAfter-places new stages", () => {
    const base: StageDef[] = [
      { name: "plan", agent: "planner" },
      { name: "implement", agent: "implementer" },
      { name: "publish", host: "publish" },
    ];
    expect(mergeStages(base, [{ name: "plan", mode: "validate" }]).map((s) => s.mode)).toEqual(["validate", undefined, undefined]);
    expect(mergeStages(base, [{ name: "plan", remove: true }]).map((s) => s.name)).toEqual(["implement", "publish"]);
    expect(mergeStages(base, [{ name: "review", agent: "reviewer", insertAfter: "implement" }]).map((s) => s.name)).toEqual([
      "plan", "implement", "review", "publish",
    ]);
    expect(mergeStages(base, [{ name: "review", agent: "reviewer" }]).map((s) => s.name)).toEqual([
      "plan", "implement", "publish", "review",
    ]);
  });
});

describe("mergeLanes", () => {
  it("returns the built-in lanes unchanged from a single complete file", () => {
    const lanes = mergeLanes([bugFile]);
    expect(Object.keys(lanes)).toEqual(["bug"]);
    expect(lanes.bug?.budget).toEqual({ fixRounds: 3, maxWallSeconds: 5400, maxCostUsd: 20 });
    expect(lanes.bug?.stages.map((s) => s.name)).toHaveLength(10);
  });

  it("resolves extends by copying the parent then applying the child patch", () => {
    const overlay: LaneLayerFile = {
      schemaVersion: 1,
      lanes: {
        hotfix: {
          extends: "bug",
          match: { kind: "bug", labels: ["hotfix"] },
          priority: 10,
          budget: { fixRounds: 2, maxWallSeconds: 2700 },
          stages: [
            { name: "diagnose", remove: true },
            { name: "security", when: "true" },
            { name: "implement", model: "B" },
          ],
          publish: { draft: false, target: "release/current", titleTemplate: "hotfix: {title} ({ref})" },
        },
      },
    };
    const lanes = mergeLanes([bugFile, overlay]);
    expect(lanes.hotfix?.stages.map((s) => s.name)).toEqual([
      "plan", "gate", "steer", "implement", "test", "review", "security", "judge", "publish",
    ]);
    expect(lanes.hotfix?.budget).toEqual({ fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 20 });
    expect(lanes.hotfix?.stages.find((s) => s.name === "security")?.when).toBe("true");
    expect(lanes.hotfix?.stages.find((s) => s.name === "implement")?.model).toBe("B");
    expect(lanes.hotfix?.publish).toEqual({ draft: false, target: "release/current", titleTemplate: "hotfix: {title} ({ref})" });
    expect(lanes.bug?.stages.map((s) => s.name)[0]).toBe("diagnose");
  });

  it("merges same-name overlays in file order (later wins per key; gates replace)", () => {
    const local: LaneLayerFile = {
      schemaVersion: 1,
      lanes: {
        bug: {
          budget: { maxCostUsd: 15 },
          stages: [{ name: "review", gates: ["citations", "verdict-consistent", "scope-report", "checklist"] }],
        },
      },
    };
    const lanes = mergeLanes([bugFile, local]);
    expect(lanes.bug?.budget.maxCostUsd).toBe(15);
    expect(lanes.bug?.budget.fixRounds).toBe(3);
    expect(lanes.bug?.stages.find((s) => s.name === "review")?.gates).toContain("checklist");
  });

  it("throws LaneLoadError on an extends cycle", () => {
    const cyclic: LaneLayerFile = {
      schemaVersion: 1,
      lanes: {
        a: { extends: "b", match: { kind: "chore" }, priority: 1, budget: { fixRounds: 1, maxWallSeconds: 1, maxCostUsd: 1 }, stages: [] },
        b: { extends: "a", match: { kind: "chore" }, priority: 1, budget: { fixRounds: 1, maxWallSeconds: 1, maxCostUsd: 1 }, stages: [] },
      },
    };
    expect(() => mergeLanes([cyclic])).toThrow(LaneLoadError);
    expect(() => mergeLanes([cyclic])).toThrow(/cycle/);
  });

  it("throws when a resolved lane is still missing required fields", () => {
    const orphan: LaneLayerFile = {
      schemaVersion: 1,
      lanes: { ghost: { extends: "missing", stages: [{ name: "plan", agent: "planner" }] } },
    };
    expect(() => mergeLanes([orphan])).toThrow(LaneLoadError);
  });

  it("does not leave remove/insertAfter on merged stages", () => {
    const lanes = mergeLanes([
      bugFile,
      { schemaVersion: 1, lanes: { bug: { stages: [{ name: "diagnose", remove: true }, { name: "notes", human: true, insertAfter: "plan" }] } } },
    ]);
    expect(lanes.bug?.stages.find((s) => s.name === "diagnose")).toBeUndefined();
    const notes = lanes.bug?.stages.find((s) => s.name === "notes");
    expect(notes?.insertAfter).toBeUndefined();
    expect(notes?.remove).toBeUndefined();
  });

  it("merges match objects per key", () => {
    const lanes = mergeLanes([
      bugFile,
      { schemaVersion: 1, lanes: { bug: { match: { kind: "bug", labels: ["from-overlay"] } } } },
    ]);
    expect(lanes.bug?.match).toEqual({ kind: "bug", labels: ["from-overlay"] });
  });
});
