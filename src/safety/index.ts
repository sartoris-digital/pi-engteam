// Deliberately NOT re-exported: ./shell.js (internal tokenizer) and canonicalJson
// (single definition in src/config/json.ts; evidence-sign.ts imports it from there).
// Run-id validation lives in src/home.ts (RUN_ID_RE / assertRunId); context.ts imports it.
export type { Block, RunContext } from "./context.js";
export { RunContextError, generatedMarker, joinRootList, parseRootList, runContextFromEnv } from "./context.js";
export { FENCE_MAX_BYTES, fenceArray, fenceData, makeNonce } from "./fence.js";
export { signRecord, verifyRecord } from "./evidence-sign.js";
export type { ApprovalToken, TokenOp, TokenSource } from "./tokens.js";
export { APPROVALS_DIR, TOKEN_OPS, consumeToken, fileTokenSource, hashArgs, mintToken, readTokenFile, tokenPath, verifyToken } from "./tokens.js";
export type { PathCheck, PathEnv } from "./paths.js";
export {
  ALLOWED_DEVICES, JUDGE_AGENT, ORCH_OWNED, PROTECTED_ABSOLUTE_PATHS, PROTECTED_HOME_PATTERNS, PROTECTED_SYSTEM_PREFIXES,
  SECRET_FILE_PATTERNS, defaultPathEnv, expandHome, isProtectedPath, isUnder, realish, resolveToolPath,
} from "./paths.js";
export type { Classification } from "./classifier.js";
export { HARMLESS_REDIRECT_TARGETS, MAX_COMMAND_BYTES, SAFE_GIT_SUBCOMMANDS, SAFE_VERBS, classifyBash } from "./classifier.js";
export { PATH_TOOLS, SHELL_TOOLS, commandBlock, controllerHardBlock, hardBlock } from "./layer-a.js";
export { READ_ONLY_STAGE_CLASSES, READ_ONLY_TOOLS, STAGE_CLASS_BY_AGENT, readOnlyBlock, stageClassOf } from "./layer-b.js";
export { NO_TOKENS, defaultDenyBlock } from "./layer-c.js";
export type { BashPolicy, DomainPolicy, PolicyAgentEntry, PolicyFile } from "./layer-d.js";
export { EMPTY_POLICY, domainBlock, globToRegExp, loadDomainPolicy, matchesRoot, parsePolicyFile, policyForAgent, resolvePolicy, resolveRoot } from "./layer-d.js";
export type { GuardDeps, GuardHost, GuardStats, InstalledGuard, ToolCallBlock, ToolCallEventLike } from "./guard.js";
export { evaluateToolCall, installControllerHardBlockers, installSafetyGuard, readRunSecretSync } from "./guard.js";
