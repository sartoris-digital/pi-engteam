import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const RULE_CLASSES = ["guidance", "constraint", "predicate"] as const;
export type RuleClass = (typeof RULE_CLASSES)[number];

export const RULE_STATUSES = ["active", "paused", "retired", "locked"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

const strict = { additionalProperties: false } as const;

export const RuleScopeSchema = Type.Object(
  {
    repo: Type.String({ minLength: 1 }),
    lane: Type.String({ minLength: 1 }),
    stage: Type.Array(Type.String()),
    kind: Type.String({ minLength: 1 }),
    paths: Type.Array(Type.String()),
  },
  strict,
);
export type RuleScope = Static<typeof RuleScopeSchema>;

export const RuleRecordSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
    scope: RuleScopeSchema,
    class: Type.Union([Type.Literal("guidance"), Type.Literal("constraint"), Type.Literal("predicate")]),
    enforce: Type.Array(Type.String()),
    createdAt: Type.String({ minLength: 1 }),
    author: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("paused"),
      Type.Literal("retired"),
      Type.Literal("locked"),
    ]),
    examples: Type.Optional(Type.Array(Type.String())),
  },
  strict,
);
export type RuleRecord = Static<typeof RuleRecordSchema>;

export const RuleFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    rules: Type.Array(RuleRecordSchema),
  },
  strict,
);
export type RuleFile = Static<typeof RuleFileSchema>;

export class RuleSchemaError extends Error {
  readonly path: string;
  constructor(message: string, path = "/") {
    super(message);
    this.name = "RuleSchemaError";
    this.path = path;
  }
}

function firstError(schema: TSchema, raw: unknown): string {
  const err = Value.Errors(schema, raw)[0];
  return err ? `${err.instancePath || "/"}: ${err.message}` : "invalid";
}

export function assertRuleRecord(raw: unknown, path = "rule"): RuleRecord {
  if (!Value.Check(RuleRecordSchema, raw)) throw new RuleSchemaError(firstError(RuleRecordSchema, raw), path);
  return raw;
}

export const BUILTIN_NO_GENERATED_DOCS_ID = "r-builtin-no-generated-docs";

export const BUILTIN_RULES: readonly RuleRecord[] = [
  {
    id: BUILTIN_NO_GENERATED_DOCS_ID,
    text: "Generated planning artifacts are never part of a commit.",
    scope: {
      repo: "*",
      lane: "*",
      stage: ["implement", "review", "judge", "publish"],
      kind: "*",
      paths: [],
    },
    class: "constraint",
    enforce: ["prompt", "review", "judge", "predicate:no-generated-docs"],
    createdAt: "2026-01-01T00:00:00.000Z",
    author: "factory",
    status: "locked",
  },
];
