import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { ConfigError } from "./errors.js";
import { isPlainObject, type JsonObject } from "./json.js";
import { FactoryConfigSchema, RepoFileSchema, SCHEMA_VERSION, type FactoryConfig, type RepoFile } from "./schema.js";

/** Global file (`~/.pi/sdlc-factory/factory.json`). schemaVersion 1 is the only version: validate and pass through. */
export function migrateConfig(raw: unknown, source = "factory.json"): FactoryConfig {
  return migrate(FactoryConfigSchema, raw, source);
}

/** Repo files (`<repo>/.pi/factory.json`, `<repo>/.pi/factory.local.json`). */
export function migrateRepoFile(raw: unknown, source = ".pi/factory.json"): RepoFile {
  return migrate(RepoFileSchema, raw, source);
}

function migrate<T extends TSchema>(schema: T, raw: unknown, source: string): Static<T> {
  if (!isPlainObject(raw)) {
    throw new ConfigError("parse", `${source}: expected a JSON object`, { file: source });
  }
  const version = raw["schemaVersion"];
  if (version === undefined) {
    throw new ConfigError("version", `${source}: missing "schemaVersion" (expected ${SCHEMA_VERSION})`, {
      file: source,
      keyPath: "schemaVersion",
    });
  }
  if (version !== SCHEMA_VERSION) {
    throw new ConfigError(
      "version",
      `${source}: unsupported schemaVersion ${JSON.stringify(version)} (this build reads ${SCHEMA_VERSION})`,
      { file: source, keyPath: "schemaVersion" },
    );
  }
  // A future schemaVersion 2 adds `if (version === 1) raw = upgrade1to2(raw)` steps here, then validates.
  return validateConfigValue(schema, dropRetiredKeys(raw), source);
}

/**
 * Keys earlier builds wrote that this build no longer understands. They are dropped on load
 * instead of being reported as unknown keys, so a config file written before the key was
 * retired keeps loading. Dotted paths, rooted at the file's top level.
 */
export const RETIRED_KEYS: readonly string[] = ["operator.coAuthoredBy"];

function retiredSlot(root: JsonObject, path: string): { holder: JsonObject; key: string } | undefined {
  const segments = path.split(".");
  const key = segments.pop() as string;
  let node: unknown = root;
  for (const segment of segments) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return isPlainObject(node) && key in node ? { holder: node, key } : undefined;
}

/** Returns `raw` untouched when it carries no retired key; otherwise a copy with each one removed. */
function dropRetiredKeys(raw: JsonObject): JsonObject {
  if (!RETIRED_KEYS.some((path) => retiredSlot(raw, path) !== undefined)) return raw;
  const copy = structuredClone(raw);
  for (const path of RETIRED_KEYS) {
    const slot = retiredSlot(copy, path);
    if (slot !== undefined) delete slot.holder[slot.key];
  }
  return copy;
}

/** Validates `raw` against `schema`; unknown keys are reported before any other violation, with their dotted path. */
export function validateConfigValue<T extends TSchema>(schema: T, raw: unknown, source: string): Static<T> {
  if (Check(schema, raw)) return raw as Static<T>;
  const firstUnknown = findUnknownKeys(schema, raw)[0];
  if (firstUnknown !== undefined) {
    throw new ConfigError("unknown-key", `${source}: unknown key "${firstUnknown}"`, {
      file: source,
      keyPath: firstUnknown,
    });
  }
  const first = Errors(schema, raw)[0];
  const where = first === undefined ? "" : pointerToDotted(first.instancePath);
  const detail = first === undefined ? "does not match the schema" : first.message;
  throw new ConfigError("schema", `${source}: invalid value at "${where}": ${detail}`, {
    file: source,
    keyPath: where,
  });
}

interface SchemaNode {
  properties?: Record<string, TSchema>;
  items?: TSchema;
  anyOf?: TSchema[];
  additionalProperties?: unknown;
}

/**
 * Walks `value` alongside the JSON-schema shape typebox emits (`properties`, `items`, `anyOf`)
 * and returns every key that no `additionalProperties: false` object declares, as dotted paths.
 */
export function findUnknownKeys(schema: TSchema, value: unknown, prefix = ""): string[] {
  const node = pickMember(schema as SchemaNode, value);
  if (node === undefined) return [];
  if (Array.isArray(value)) {
    const items = node.items;
    if (items === undefined) return [];
    return value.flatMap((item: unknown, index) => findUnknownKeys(items, item, `${prefix}[${index}]`));
  }
  if (!isPlainObject(value) || node.properties === undefined) return [];
  const props = node.properties;
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix === "" ? key : `${prefix}.${key}`;
    const childSchema = props[key];
    if (childSchema === undefined) {
      if (node.additionalProperties === false) found.push(dotted);
      continue;
    }
    found.push(...findUnknownKeys(childSchema, child, dotted));
  }
  return found;
}

/** For `Union([X, Null])` leaves: pick the member whose shape matches the value. */
function pickMember(node: SchemaNode, value: unknown): SchemaNode | undefined {
  if (node.anyOf === undefined) return node;
  const members = node.anyOf as SchemaNode[];
  if (Array.isArray(value)) return members.find((member) => member.items !== undefined);
  if (isPlainObject(value)) return members.find((member) => member.properties !== undefined);
  return undefined;
}

/** `/defaults/branching/base` → `defaults.branching.base`; `/repos/1/path` → `repos[1].path`. */
function pointerToDotted(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, segment) => {
      if (/^\d+$/.test(segment)) return `${acc}[${segment}]`;
      return acc === "" ? segment : `${acc}.${segment}`;
    }, "");
}
