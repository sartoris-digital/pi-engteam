export type { RuleClass, RuleFile, RuleRecord, RuleScope, RuleStatus } from "./schema.js";
export {
  BUILTIN_NO_GENERATED_DOCS_ID,
  BUILTIN_RULES,
  RULE_CLASSES,
  RULE_STATUSES,
  RuleFileSchema,
  RuleRecordSchema,
  RuleSchemaError,
  RuleScopeSchema,
  assertRuleRecord,
} from "./schema.js";
export type { LoadedRules, RuleLayer } from "./load.js";
export {
  committedRulesPath,
  globalRulesPath,
  loadEffectiveRules,
  localRulesPath,
  rulesSha,
} from "./load.js";
export { normaliseRuleText } from "./normalise.js";
export { tokenSetSimilarity } from "./dedupe.js";
export type { ScreenFlags } from "./remember.js";
export {
  LOCAL_RULES_EXCLUDE,
  RuleDuplicateError,
  RuleSafetyError,
  RuleScreenError,
  addRule,
  ensureLocalRulesExcluded,
} from "./remember.js";
