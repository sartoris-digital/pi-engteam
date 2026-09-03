export * from "./schema.js";
export { ConfigError, type ConfigErrorCode } from "./errors.js";
export { canonicalJson, isPlainObject, type JsonObject, type JsonPrimitive, type JsonValue } from "./json.js";
export {
  DEFAULTS,
  GENERATED_DOC_PATTERNS,
  type OperatorDefaults,
  type RepoDefaultValues,
  type TrackerEntryDefaults,
} from "./defaults.js";
export { mergeLayers, type ConfigLayer, type MergeOptions, type MergeResult } from "./merge.js";
