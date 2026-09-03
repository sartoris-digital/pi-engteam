import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TicketKind } from "../trackers/adapter.js";

const strict = { additionalProperties: false } as const;

export const BRIEF_CONFIDENCE = ["HIGH", "MEDIUM", "LOW"] as const;
export type BriefConfidence = (typeof BRIEF_CONFIDENCE)[number];

export const BRIEF_SIZES = ["S", "M", "L", "XL"] as const;
export type BriefSize = (typeof BRIEF_SIZES)[number];

export const AC_SOURCES = ["quoted", "derived", "inferred"] as const;
export type AcSource = (typeof AC_SOURCES)[number];

export const BRIEF_FLAGS = [
  "security",
  "perf",
  "needsDeps",
  "touchesMigrations",
  "exclusive",
  "architecture",
  "injectionSuspect",
] as const;
export type BriefFlag = (typeof BRIEF_FLAGS)[number];

export const BRIEF_TIERS = ["low", "elevated"] as const;
export type BriefTier = (typeof BRIEF_TIERS)[number];

export const BRIEF_PRIOR_FROM = ["label", "issue-type", "title-prefix", "none", "human"] as const;
export type BriefPriorFrom = (typeof BRIEF_PRIOR_FROM)[number];

export const REPRO_STEPS = ["present", "absent"] as const;
export type ReproSteps = (typeof REPRO_STEPS)[number];

export const TicketKindSchema = Type.Union([
  Type.Literal("feature"),
  Type.Literal("enhancement"),
  Type.Literal("bug"),
  Type.Literal("chore"),
]);
export const BriefConfidenceSchema = Type.Union([Type.Literal("HIGH"), Type.Literal("MEDIUM"), Type.Literal("LOW")]);
export const BriefSizeSchema = Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L"), Type.Literal("XL")]);
export const AcSourceSchema = Type.Union([Type.Literal("quoted"), Type.Literal("derived"), Type.Literal("inferred")]);
export const BriefFlagSchema = Type.Union([
  Type.Literal("security"),
  Type.Literal("perf"),
  Type.Literal("needsDeps"),
  Type.Literal("touchesMigrations"),
  Type.Literal("exclusive"),
  Type.Literal("architecture"),
  Type.Literal("injectionSuspect"),
]);
export const BriefTierSchema = Type.Union([Type.Literal("low"), Type.Literal("elevated")]);
export const BriefPriorFromSchema = Type.Union([
  Type.Literal("label"),
  Type.Literal("issue-type"),
  Type.Literal("title-prefix"),
  Type.Literal("none"),
  Type.Literal("human"),
]);
export const ReproStepsSchema = Type.Union([Type.Literal("present"), Type.Literal("absent")]);

export const AcceptanceCriterionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    source: AcSourceSchema,
    quote: Type.String(),
  },
  strict,
);
export type AcceptanceCriterion = Static<typeof AcceptanceCriterionSchema>;

export const BriefSamplesSchema = Type.Object(
  {
    n: Type.Integer({ minimum: 0 }),
    kinds: Type.Array(TicketKindSchema),
    acAgreement: Type.Number({ minimum: 0, maximum: 1 }),
  },
  strict,
);
export type BriefSamples = Static<typeof BriefSamplesSchema>;

export const BriefPriorSchema = Type.Object(
  {
    kind: Type.Optional(TicketKindSchema),
    from: BriefPriorFromSchema,
  },
  strict,
);
export type BriefPrior = Static<typeof BriefPriorSchema>;

export const BriefSchema = Type.Object(
  {
    kind: TicketKindSchema,
    flags: Type.Array(BriefFlagSchema),
    size: BriefSizeSchema,
    reproSteps: ReproStepsSchema,
    acceptanceCriteria: Type.Array(AcceptanceCriterionSchema),
    likelyPaths: Type.Array(Type.String()),
    questions: Type.Array(Type.String()),
    possibleDuplicateOf: Type.Optional(Type.String({ minLength: 1 })),
    goal: Type.String(),
    samples: BriefSamplesSchema,
    prior: BriefPriorSchema,
    confidence: BriefConfidenceSchema,
    tier: BriefTierSchema,
    lane: Type.String({ minLength: 1 }),
  },
  strict,
);
export type Brief = Static<typeof BriefSchema>;

const RETIRED: ReadonlyArray<{ name: string; keys: readonly string[] }> = [
  { name: "{type, summary}", keys: ["type", "summary"] },
  { name: "{issueType, ac: string[]}", keys: ["issueType", "ac"] },
  { name: "{classification}", keys: ["classification"] },
];

export class BriefSchemaError extends Error {
  readonly path: string;
  readonly retired?: string;
  constructor(message: string, path = "/", retired?: string) {
    super(message);
    this.name = "BriefSchemaError";
    this.path = path;
    if (retired !== undefined) this.retired = retired;
  }
}

function firstError(schema: TSchema, raw: unknown): string {
  const err = [...Value.Errors(schema, raw)][0];
  return err ? `${err.instancePath || "/"}: ${err.message}` : "invalid";
}

function retiredName(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const keys = new Set(Object.keys(raw));
  for (const contract of RETIRED) {
    if (contract.keys.every((k) => keys.has(k))) return contract.name;
  }
  return undefined;
}

/** Validate and return a spec §3.7 brief. Throws BriefSchemaError, naming retired contracts. */
export function parseBrief(raw: unknown): Brief {
  const retired = retiredName(raw);
  if (retired !== undefined) {
    throw new BriefSchemaError(`retired contract ${retired}`, "/", retired);
  }
  if (!Value.Check(BriefSchema, raw)) {
    throw new BriefSchemaError(firstError(BriefSchema, raw));
  }
  return raw;
}

export type { TicketKind };
