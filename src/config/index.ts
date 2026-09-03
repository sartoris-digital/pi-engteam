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
export { migrateConfig, migrateRepoFile, validateConfigValue } from "./migrate.js";
export {
  committedConfigPath,
  expandHome,
  findRepoEntry,
  globalConfigPath,
  localConfigPath,
  readCommitted,
  readGlobal,
  readLocal,
  readRepoOverrides,
} from "./layers.js";
export {
  assertNarrowing,
  NarrowingError,
  narrowedKeysFor,
  POLICY_RANK,
  SANDBOX_RANK,
  SAFETY_KEYS,
  type SafetyKey,
} from "./narrowing.js";
export { loadEffectiveConfig, resolveDefaultBase, sha256Hex, type LoadOptions } from "./effective.js";
