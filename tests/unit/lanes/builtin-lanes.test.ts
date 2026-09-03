import { describe, expect, it } from "vitest";
import { CATALOG } from "../../../src/lanes/catalog.js";
import { checkInvariants } from "../../../src/lanes/invariants.js";
import { BUILTIN_LANES_PATH, loadBuiltinLanes } from "../../../src/lanes/load.js";

describe("built-in lanes.yaml", () => {
  it("loads exactly chore, bug, enhancement, feature", async () => {
    const lanes = await loadBuiltinLanes();
    expect(Object.keys(lanes).sort()).toEqual(["bug", "chore", "enhancement", "feature"]);
    expect(BUILTIN_LANES_PATH).toMatch(/assets\/lanes\.yaml$/);
  });

  it("chore is gateless, starts at locked host scope-check, then plan → steer → implement", async () => {
    const chore = (await loadBuiltinLanes()).chore!;
    expect(chore.gateless).toBe(true);
    expect(chore.match).toEqual({ kind: "chore" });
    expect(chore.priority).toBe(100);
    expect(chore.budget).toEqual({ fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8 });
    expect(chore.stages.map((s) => s.name)).toEqual([
      "scope-check", "plan", "steer", "implement", "test", "review", "security", "judge", "publish",
    ]);
    expect(chore.stages[0]).toMatchObject({ name: "scope-check", host: "scope-check", locked: true });
    expect(chore.stages.find((s) => s.name === "steer")).toMatchObject({ human: true, locked: true });
    expect(chore.stages.find((s) => s.name === "judge")).toMatchObject({ agent: "judge", safetyGating: true, locked: true });
  });

  it("bug/enhancement/feature match §4.8 stage names and budgets", async () => {
    const lanes = await loadBuiltinLanes();
    expect(lanes.bug?.stages.map((s) => s.name)).toEqual([
      "diagnose", "plan", "gate", "steer", "implement", "test", "review", "security", "judge", "publish",
    ]);
    expect(lanes.bug?.budget).toEqual({ fixRounds: 3, maxWallSeconds: 5400, maxCostUsd: 20 });
    expect(lanes.bug?.stages.find((s) => s.name === "gate")?.gates).toContain("red-baseline");
    expect(lanes.bug?.stages.find((s) => s.name === "diagnose")?.locked).not.toBe(true);
    expect(lanes.enhancement?.stages.map((s) => s.name)).toEqual([
      "plan", "gate", "steer", "implement", "test", "review", "security", "judge", "publish",
    ]);
    expect(lanes.enhancement?.budget).toEqual({ fixRounds: 3, maxWallSeconds: 7200, maxCostUsd: 30 });
    expect(lanes.feature?.stages.map((s) => s.name)).toEqual([
      "design", "plan", "gate", "steer", "implement", "test", "review", "security", "judge", "publish",
    ]);
    expect(lanes.feature?.budget).toEqual({ fixRounds: 4, maxWallSeconds: 14400, maxCostUsd: 60 });
    expect(lanes.feature?.stages.find((s) => s.name === "design")?.when).toBe("size == 'L' || flags.architecture");
  });

  it("every built-in is a valid build lane against the catalog", async () => {
    const lanes = await loadBuiltinLanes();
    for (const [name, def] of Object.entries(lanes)) {
      expect(checkInvariants({ ...def, name }, CATALOG), name).toEqual([]);
    }
  });

  it("locks gate (when present), steer, test, judge, publish on every lane", async () => {
    const lanes = await loadBuiltinLanes();
    for (const def of Object.values(lanes)) {
      for (const name of ["steer", "test", "judge", "publish"]) {
        expect(def.stages.find((s) => s.name === name)?.locked, name).toBe(true);
      }
      const gate = def.stages.find((s) => s.name === "gate");
      if (gate) expect(gate.locked).toBe(true);
    }
  });

  it("does not ship dep-update, land-reconcile, escalate or fusion defaults", async () => {
    const lanes = await loadBuiltinLanes();
    for (const def of Object.values(lanes)) {
      expect(def.stages.map((s) => s.name)).not.toContain("dep-update");
      expect(def.stages.map((s) => s.name)).not.toContain("land-reconcile");
      expect(def.stages.map((s) => s.name)).not.toContain("escalate");
      expect(def.stages.some((s) => s.fusion)).toBe(false);
      expect(def.stages.some((s) => s.host === "deps")).toBe(false);
    }
  });
});
