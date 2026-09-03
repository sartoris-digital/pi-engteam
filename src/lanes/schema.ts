import { Type, type Static, type TLiteral, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { FUSION_MODES } from "../fusion/types.js";

export const SCHEMA_VERSION = 1 as const;

export const LANE_CLASSES = ["build", "pre-build", "meta"] as const;
export type LaneClass = (typeof LANE_CLASSES)[number];

const strict = { additionalProperties: false } as const;
const StringList = Type.Array(Type.String());
const PositiveInt = Type.Integer({ minimum: 1 });
const NonNegativeNumber = Type.Number({ minimum: 0 });

export const LaneClassSchema = Type.Union([
  Type.Literal("build"),
  Type.Literal("pre-build"),
  Type.Literal("meta"),
]);

export const OnFailSchema = Type.Union([
  Type.Literal("fix-round"),
  Type.Literal("continue"),
  Type.String({ pattern: "^escalate:[a-z0-9-]+$" }),
]);
export type OnFail = "fix-round" | "continue" | `escalate:${string}`;

export const BudgetSchema = Type.Object(
  { fixRounds: PositiveInt, maxWallSeconds: NonNegativeNumber, maxCostUsd: NonNegativeNumber },
  strict,
);
export type Budget = Static<typeof BudgetSchema>;

export const LaneMatchSchema = Type.Object(
  {
    kind: Type.Optional(Type.String()),
    labels: Type.Optional(StringList),
    likelyPaths: Type.Optional(StringList),
    tier: Type.Optional(Type.String()),
    size: Type.Optional(Type.String()),
    flags: Type.Optional(StringList),
    trigger: Type.Optional(StringList),
  },
  strict,
);
export type LaneMatch = Static<typeof LaneMatchSchema>;

export const LanePublishSchema = Type.Object(
  {
    draft: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
    target: Type.Optional(Type.String()),
    titleTemplate: Type.Optional(Type.String()),
    labels: Type.Optional(StringList),
  },
  strict,
);
export type LanePublish = Static<typeof LanePublishSchema>;

/** Built from `FUSION_MODES` so lane YAML and the fusion runner can never drift. */
type LiteralTuple<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K] & string> };
type FusionModeLiterals = LiteralTuple<typeof FUSION_MODES>;
export const FusionModeSchema = Type.Union(
  FUSION_MODES.map((mode) => Type.Literal(mode)) as unknown as FusionModeLiterals,
);

/**
 * A slot entry is either a stack slot name ("A") or an inline slot object. An entry without
 * `model` resolves against the operator's configured fusion stack, matching `parseSlots`.
 */
export const StageFusionSlotSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object(
    {
      name: Type.String({ minLength: 1 }),
      model: Type.Optional(Type.String({ minLength: 1 })),
      thinking: Type.Optional(Type.String({ minLength: 1 })),
    },
    strict,
  ),
]);
export type StageFusionSlot = Static<typeof StageFusionSlotSchema>;

/** Stage-level `fusion:` block. Shapes accepted here are exactly what `fusionRequestFromStage` reads. */
export const StageFusionSchema = Type.Object(
  {
    mode: FusionModeSchema,
    slots: Type.Optional(Type.Array(StageFusionSlotSchema)),
    /** Debate rounds; the runner caps at 3. */
    rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    synthesizer: Type.Optional(Type.String({ minLength: 1 })),
    syncBack: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type StageFusion = Static<typeof StageFusionSchema>;

const stageFields = {
  name: Type.String({ minLength: 1 }),
  agent: Type.Optional(Type.String({ minLength: 1 })),
  host: Type.Optional(Type.String({ minLength: 1 })),
  human: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.String()),
  when: Type.Optional(Type.String()),
  gates: Type.Optional(StringList),
  onFail: Type.Optional(OnFailSchema),
  maxRounds: Type.Optional(PositiveInt),
  locked: Type.Optional(Type.Boolean()),
  safetyGating: Type.Optional(Type.Boolean()),
  verify: Type.Optional(Type.Boolean()),
  maxVerifyLoops: Type.Optional(PositiveInt),
  timeoutSeconds: Type.Optional(PositiveInt),
  remove: Type.Optional(Type.Boolean()),
  insertAfter: Type.Optional(Type.String()),
  fusion: Type.Optional(StageFusionSchema),
  model: Type.Optional(Type.String()),
  packet: Type.Optional(Type.String()),
};

export const StageDefSchema = Type.Object(stageFields, strict);
export type StageDef = Static<typeof StageDefSchema>;

const BudgetPatchSchema = Type.Object(
  {
    fixRounds: Type.Optional(PositiveInt),
    maxWallSeconds: Type.Optional(NonNegativeNumber),
    maxCostUsd: Type.Optional(NonNegativeNumber),
  },
  strict,
);

const laneFields = {
  class: Type.Optional(LaneClassSchema),
  extends: Type.Optional(Type.String({ minLength: 1 })),
  match: LaneMatchSchema,
  priority: Type.Integer(),
  budget: BudgetSchema,
  stages: Type.Array(StageDefSchema),
  publish: Type.Optional(LanePublishSchema),
  onExhausted: Type.Optional(Type.Literal("escalate")),
  gateless: Type.Optional(Type.Boolean()),
  fusion: Type.Optional(Type.Object({ budgetMultiplier: Type.Optional(Type.Number({ minimum: 1 })) }, strict)),
};

export const LaneDefSchema = Type.Object(laneFields, strict);
export type LaneDef = Static<typeof LaneDefSchema>;

export const LanePatchSchema = Type.Object(
  {
    class: Type.Optional(LaneClassSchema),
    extends: Type.Optional(Type.String({ minLength: 1 })),
    match: Type.Optional(LaneMatchSchema),
    priority: Type.Optional(Type.Integer()),
    budget: Type.Optional(BudgetPatchSchema),
    stages: Type.Optional(Type.Array(StageDefSchema)),
    publish: Type.Optional(LanePublishSchema),
    onExhausted: Type.Optional(Type.Literal("escalate")),
    gateless: Type.Optional(Type.Boolean()),
    fusion: Type.Optional(Type.Object({ budgetMultiplier: Type.Optional(Type.Number({ minimum: 1 })) }, strict)),
  },
  strict,
);
export type LanePatch = Static<typeof LanePatchSchema>;

export const LaneFileSchema = Type.Object(
  { schemaVersion: Type.Literal(SCHEMA_VERSION), lanes: Type.Record(Type.String({ minLength: 1 }), LaneDefSchema) },
  strict,
);
export type LaneFile = Static<typeof LaneFileSchema>;

export const LaneLayerFileSchema = Type.Object(
  { schemaVersion: Type.Literal(SCHEMA_VERSION), lanes: Type.Record(Type.String({ minLength: 1 }), LanePatchSchema) },
  strict,
);
export type LaneLayerFile = Static<typeof LaneLayerFileSchema>;

export type NamedLane = LaneDef & { name: string };

export class LaneSchemaError extends Error {
  readonly path: string;
  readonly file: string | undefined;
  constructor(message: string, path: string, file?: string) {
    super(message);
    this.name = "LaneSchemaError";
    this.path = path;
    this.file = file;
  }
}

function firstError(schema: TSchema, raw: unknown): string {
  const err = Value.Errors(schema, raw)[0];
  return err ? `${err.instancePath || "/"}: ${err.message}` : "invalid";
}

function stageKindCount(stage: StageDef): number {
  return (stage.agent ? 1 : 0) + (stage.host ? 1 : 0) + (stage.human === true ? 1 : 0);
}

function assertStages(stages: StageDef[], path: string, allowPatchOmitKind: boolean): void {
  stages.forEach((stage, i) => {
    const here = `${path}.stages[${i}]`;
    const count = stageKindCount(stage);
    // Layer patches may omit agent|host|human (field overlays / remove: true). Complete lanes may not.
    if (allowPatchOmitKind && count === 0) return;
    if (count !== 1) {
      throw new LaneSchemaError(`${here}: exactly one of agent | host | human:true`, here);
    }
  });
}

export function assertLaneDef(raw: unknown, path = "lane"): LaneDef {
  if (!Value.Check(LaneDefSchema, raw)) throw new LaneSchemaError(firstError(LaneDefSchema, raw), path);
  assertStages(raw.stages, path, false);
  return raw;
}

export function assertLaneFile(raw: unknown, file?: string): LaneFile {
  if (!Value.Check(LaneFileSchema, raw)) throw new LaneSchemaError(firstError(LaneFileSchema, raw), "/", file);
  for (const [name, lane] of Object.entries(raw.lanes)) assertLaneDef(lane, `lanes.${name}`);
  return raw;
}

export function assertLaneLayerFile(raw: unknown, file?: string): LaneLayerFile {
  if (!Value.Check(LaneLayerFileSchema, raw)) throw new LaneSchemaError(firstError(LaneLayerFileSchema, raw), "/", file);
  for (const [name, patch] of Object.entries(raw.lanes)) {
    if (patch.stages) assertStages(patch.stages, `lanes.${name}`, true);
  }
  return raw;
}
