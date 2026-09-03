import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { FUSION_MODES } from "../../../src/fusion/types.js";
import {
  FusionModeSchema,
  LaneDefSchema,
  LaneFileSchema,
  LaneLayerFileSchema,
  SCHEMA_VERSION,
  StageDefSchema,
  StageFusionSchema,
  assertLaneDef,
  assertLaneFile,
  assertLaneLayerFile,
  LaneSchemaError,
} from "../../../src/lanes/schema.js";

const chore = {
  class: "build",
  match: { kind: "chore" },
  priority: 100,
  budget: { fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8 },
  stages: [
    { name: "scope-check", host: "scope-check", locked: true },
    { name: "plan", agent: "planner", mode: "approach" },
    { name: "steer", human: true, packet: "steer-packet", locked: true },
  ],
  onExhausted: "escalate",
};

describe("lane schemas", () => {
  it("accepts a minimal complete lane file", () => {
    expect(Value.Check(LaneFileSchema, { schemaVersion: SCHEMA_VERSION, lanes: { chore } })).toBe(true);
    expect(Value.Check(LaneFileSchema, { schemaVersion: 2, lanes: { chore } })).toBe(false);
    expect(Value.Check(LaneFileSchema, { lanes: { chore } })).toBe(false);
  });

  it("rejects unknown keys on file, lane, match, budget and stage", () => {
    expect(Value.Check(LaneFileSchema, { schemaVersion: 1, lanes: { chore }, extra: true })).toBe(false);
    expect(Value.Check(LaneDefSchema, { ...chore, klass: "build" })).toBe(false);
    expect(Value.Check(LaneDefSchema, { ...chore, match: { kind: "chore", flavour: "x" } })).toBe(false);
    expect(Value.Check(LaneDefSchema, { ...chore, budget: { ...chore.budget, maxIterations: 21 } })).toBe(false);
    expect(Value.Check(StageDefSchema, { name: "plan", agent: "planner", agents: "x" })).toBe(false);
  });

  it("requires match, priority, budget and stages on a complete LaneDef and not on a layer patch", () => {
    expect(Value.Check(LaneDefSchema, { match: {}, priority: 1, budget: chore.budget, stages: [] })).toBe(true);
    expect(Value.Check(LaneDefSchema, { priority: 1, budget: chore.budget, stages: [] })).toBe(false);
    expect(Value.Check(LaneLayerFileSchema, { schemaVersion: 1, lanes: { bug: { stages: [{ name: "judge", remove: true }] } } })).toBe(true);
    expect(Value.Check(LaneLayerFileSchema, { schemaVersion: 1, lanes: { bug: { budget: { fixRounds: 2 } } } })).toBe(true);
  });

  it("accepts the three stage kinds and onFail forms", () => {
    expect(Value.Check(StageDefSchema, { name: "plan", agent: "planner", onFail: "escalate:needs-decision" })).toBe(true);
    expect(Value.Check(StageDefSchema, { name: "test", host: "checks", onFail: "fix-round" })).toBe(true);
    expect(Value.Check(StageDefSchema, { name: "steer", human: true, onFail: "continue" })).toBe(true);
    expect(Value.Check(StageDefSchema, { name: "x", agent: "planner", onFail: "retry" })).toBe(false);
  });

  it("accepts optional publish, gateless, fusion, model, packet, when, gates, verify", () => {
    expect(
      Value.Check(LaneDefSchema, {
        ...chore,
        gateless: true,
        publish: { draft: false, target: "main", titleTemplate: "{kind}: {title}" },
        stages: [{ name: "implement", agent: "implementer", verify: true, maxVerifyLoops: 1, model: "B", fusion: { mode: "veto" } }],
      }),
    ).toBe(true);
    expect(Value.Check(LaneDefSchema, { ...chore, publish: { draft: "always" } })).toBe(true);
  });

  it("assertLaneFile / assertLaneDef throw LaneSchemaError with a path", () => {
    expect(() => assertLaneFile({ schemaVersion: 1, lanes: { chore } })).not.toThrow();
    expect(() => assertLaneFile({ schemaVersion: 1 })).toThrow(LaneSchemaError);
    try {
      assertLaneDef({ ...chore, priority: "high" }, "lanes.chore");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LaneSchemaError);
      expect((err as LaneSchemaError).path).toContain("lanes.chore");
    }
  });

  it("builds the stage fusion mode union from FUSION_MODES so the two lists cannot drift", () => {
    const literals = (FusionModeSchema.anyOf as { const: string }[]).map((m) => m.const);
    expect(literals).toEqual([...FUSION_MODES]);
    for (const mode of FUSION_MODES) expect(Value.Check(FusionModeSchema, mode)).toBe(true);
    expect(Value.Check(FusionModeSchema, "debat")).toBe(false);
  });

  it("accepts every documented stage fusion shape", () => {
    expect(Value.Check(StageFusionSchema, { mode: "veto" })).toBe(true);
    expect(Value.Check(StageFusionSchema, { mode: "adversarial", slots: ["A", "B"] })).toBe(true);
    expect(
      Value.Check(StageFusionSchema, {
        mode: "debate",
        slots: ["A", { name: "B" }, { name: "C", model: "gpt-x", thinking: "high" }],
        rounds: 3,
        synthesizer: "A",
      }),
    ).toBe(true);
  });

  it("rejects a misspelled mode, unknown keys, bad rounds and malformed slots on stage fusion", () => {
    expect(Value.Check(StageFusionSchema, {})).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "debat" })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "veto", slot: ["A", "B"] })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "debate", rounds: 0 })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "debate", rounds: 4 })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "debate", rounds: 1.5 })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "veto", slots: "A" })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "veto", slots: [""] })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "veto", slots: [{ model: "gpt-x" }] })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "veto", slots: [{ name: "A", role: "x" }] })).toBe(false);
    expect(Value.Check(StageFusionSchema, { mode: "veto", synthesizer: 5 })).toBe(false);
    // Retired flags stay retired: strict mode turns a stale key into a loud load-time rejection.
    expect(Object.keys(StageFusionSchema.properties)).toEqual(["mode", "slots", "rounds", "synthesizer"]);
    expect(Value.Check(StageDefSchema, { name: "review", agent: "reviewer", fusion: { mode: "debat" } })).toBe(false);
    expect(Value.Check(StageDefSchema, { name: "review", agent: "reviewer", fusion: { mode: "debate" } })).toBe(true);
  });

  it("assertLaneDef requires exactly one of agent|host|human:true; remove patches may omit the kind", () => {
    expect(() => assertLaneDef({ ...chore, stages: [{ name: "x" }] })).toThrow(/exactly one/);
    expect(() => assertLaneDef({ ...chore, stages: [{ name: "x", agent: "planner", host: "checks" }] })).toThrow(/exactly one/);
    expect(() => assertLaneLayerFile({ schemaVersion: 1, lanes: { bug: { stages: [{ name: "judge", remove: true }] } } })).not.toThrow();
  });
});
