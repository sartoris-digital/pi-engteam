// src/types.ts
export type TeamMessage = {
  id: string;
  from: string;
  to: string;
  summary: string;
  message: string;
  requestId?: string;
  type?: "request" | "response" | "shutdown_request" | "shutdown_response";
  ts: string;
};

export type RunStatus = "pending" | "running" | "paused" | "waiting_user" | "succeeded" | "failed" | "aborted";

export type RunPhase = "active" | "cancelling" | "cancelled" | "rolled-back" | "done" | "failed";

export type Budget = {
  maxIterations: number;
  maxCostUsd: number;
  maxWallSeconds: number;
  maxTokens: number;
  spent: { costUsd: number; wallSeconds: number; tokens: number };
};

export type StepRecord = {
  name: string;
  startedAt?: string;
  endedAt?: string;
  verdict?: Verdict;
  issues?: string[];
  handoffHint?: string;
  artifacts?: string[];
  error?: string;
};

export type ApprovalRecord = {
  tokenId: string;
  op: string;
  expiresAt: string;
  consumed: boolean;
  argsHash: string;
};

export type RunState = {
  runId: string;
  workflow: string;
  goal: string;
  status: RunStatus;
  currentStep: string;
  iteration: number;
  budget: Budget;
  steps: StepRecord[];
  artifacts: Record<string, string>;
  approvals: ApprovalRecord[];
  planMode: boolean;
  createdAt: string;
  updatedAt: string;
  /** Phase 4: cancel/rollback state machine; absent on legacy state files = "active". */
  phase?: RunPhase;
  /** Phase 4: workflow-defined round budget; absent = no rounds. */
  rounds?: { current: number; max: number };
  /**
   * PLAN.md round-A3: schema version stamp for ApprovalWatcher boot-time
   * compatibility gates. Pre-watcher runs have this absent; boot recovery
   * backfills to 1 under the lease.
   */
  schemaVersion?: number;
  /**
   * PLAN.md round-A5: adhoc-shell renewable hold expiry. While
   * `> now`, the run's userLiveness is forced fresh so the 24h
   * stale gate cannot quarantine legitimate adhoc approvals. Bumped by
   * `/approval-watcher extend-hold` and `/approval-watcher reengage`.
   */
  adhocHoldExpiresAt?: string;
  /**
   * PLAN.md round-A7: a step's StepResult.pauseForUser surfaced here
   * so /run-status can display why a waiting_user run is paused.
   */
  pauseForUser?: { reason: string };
};

export type EventCategory =
  | "lifecycle" | "tool_call" | "tool_result" | "message"
  | "verdict" | "budget" | "safety" | "approval" | "error";

export type EngteamEvent = {
  ts: string;
  runId: string;
  step?: string;
  iteration?: number;
  agentId?: string;
  agentName?: string;
  category: EventCategory;
  type: string;
  payload: Record<string, unknown>;
  rawArgsRef?: string;
  summary?: string;
};

export type Verdict = "PASS" | "FAIL" | "NEEDS_MORE" | "PARTIAL";

export type ClassifierResult = {
  classification: "safe" | "destructive" | "blocked";
  rule?: string;
  reason?: string;
};

export type VerdictPayload = {
  runId?: string;
  step: string;
  verdict: Verdict;
  issues?: string[];
  artifacts?: string[];
  handoffHint?: string;
  learnings?: string[];
  decisions?: string[];
  issues_found?: string[];
  gotchas?: string[];
};

export type SafetyConfig = {
  hardBlockers: { enabled: boolean; alwaysOn: boolean };
  planMode: { defaultOn: boolean };
  classification: { mode: "default-deny"; safeAllowlistExtend: string[]; destructiveOverride: string[] };
  approvalAuthority: "judge";
  exemptPaths: string[];
  tokenTtlSeconds: number;
  allowRunLifetimeScope: boolean;
  /**
   * PLAN.md round-A1+: ApprovalWatcher feature config. Optional so old
   * safety.json files load — defaults fill in via DEFAULT_APPROVAL_WATCHER_CONFIG.
   */
  approvalWatcher?: ApprovalWatcherConfig;
};

export type ModelRouting = {
  overrides: Record<string, string>;
  budgetDownshift: {
    enabled: boolean;
    triggerAtPercent: number;
    rules: Record<string, string>;
    protected: string[];
  };
};

export type AgentDefinition = {
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
  team?: "orchestrator" | "planning" | "engineering" | "validation" | "investigation" | "cross-functional";
};

export type BudgetStatus = {
  ok: boolean;
  warnings: Array<"iterations" | "cost" | "wall" | "tokens">;
  exhausted: Array<"iterations" | "cost" | "wall" | "tokens">;
};

export type ApprovalToken = {
  tokenId: string;
  runId: string;
  op: string;
  argsHash: string;
  scope: "once" | "run-lifetime";
  expiresAt: string;
  signature: string;
  /**
   * PLAN.md round-A8: emergency-stop epoch persistence. GrantApproval
   * stamps this with the current global pauseEpoch at mint time AND
   * binds it into the HMAC. SafetyGuard rejects any token whose
   * pauseEpoch !== currentPauseEpoch. Pre-watcher tokens (legacy)
   * have this absent; the one-shot migration writes `0` and re-signs
   * under the new HMAC payload before the first emergencyStop fires.
   */
  pauseEpoch?: number;
  /**
   * PLAN.md round-1 audit clarity: GrantApproval flips this to true
   * AFTER atomic-rename consume so duplicate consumers can detect.
   */
  consumed?: boolean;
};

/**
 * PLAN.md round-A1+: per-approval feature flags surfaced via safety.json
 * under the `approvalWatcher` sub-object. Every field has a safe default
 * so a missing or stale config never accidentally enables the watcher.
 */
export type ApprovalWatcherConfig = {
  /** Master switch (PLAN.md round-3 HIGH 1). Default false — watcher dormant. */
  enabled: boolean;
  /**
   * PLAN.md round-A1: rollout mode. `dormant` for fresh installs; `rollback`
   * when the watcher previously ran and stale watcher-format state exists.
   * Boot detects automatically when omitted.
   */
  mode?: "dormant" | "rollback";
  /**
   * PLAN.md round-3 HIGH 1: runtime kill switch. When true, watcher
   * observes but does not dispatch. Live-reloaded from safety.json.
   */
  dispatchPaused: boolean;
  /**
   * PLAN.md round-A4 HIGH 2: emergency stop. Kills in-flight Judges,
   * unconditionally rejects all approval tokens, requires audited resume.
   */
  emergencyStop: boolean;
  /**
   * PLAN.md round-A6: monotonically-increasing epoch incremented on
   * every audited emergency-stop resume. Tokens bind to this via HMAC.
   */
  pauseEpoch: number;
  /**
   * PLAN.md round-3: canary rollout opt-in run-ids. Only listed runs
   * use the watcher path; others fall back to legacy ADWEngine dispatch.
   */
  canaryRunIds: string[];
  /**
   * PLAN.md round-A7 MEDIUM 4: explicit full-rollout flag. When true,
   * canaryRunIds is ignored. Default false.
   */
  allRuns: boolean;
  /**
   * PLAN.md round-A2 MEDIUM 2: max age of a pending request before the
   * dispatcher quarantines as generation-stale. Default 3600 (1 hour).
   */
  maxRequestAgeSeconds: number;
};

export const DEFAULT_APPROVAL_WATCHER_CONFIG: ApprovalWatcherConfig = {
  enabled: false,
  mode: "dormant",
  dispatchPaused: false,
  emergencyStop: false,
  pauseEpoch: 0,
  canaryRunIds: [],
  allRuns: false,
  maxRequestAgeSeconds: 3600,
};

/**
 * PLAN.md round-1 HIGH 3 + round-A7 LOW: canonical poll-hint field on
 * the RequestApproval tool response so workers know whether to poll
 * via CheckApproval or exit NEEDS_MORE for legacy re-dispatch.
 */
export type RequestApprovalPollHint = "CheckApproval" | "next_tool_call" | "n/a";

/**
 * PLAN.md round-A8 MEDIUM 3: CheckApproval return states. All five
 * appear in the typed schema; consumers must handle each.
 */
export type CheckApprovalStatus =
  | "pending"
  | "granted"
  | "denied"
  | "not-found"
  | "rollback-handoff";

/**
 * PLAN.md round-A1: approval event types split by scope.
 *   - Request-scoped events carry { requestId, runId, op, argsHash }.
 *   - Global / run-scoped events carry { runId } (or null for boot)
 *     plus event-specific structured fields. No requestId.
 *
 * Implementation step 0 (lands BEFORE any watcher code): every type
 * below must round-trip through the observer schema validator so
 * canary runs can emit them without rejection.
 */
export const APPROVAL_EVENT_TYPES_LEGACY = [
  "request",
  "grant",
  "consume",
  "revoke",
  "expired",
] as const;

export const APPROVAL_EVENT_TYPES_REQUEST_SCOPED = [
  ...APPROVAL_EVENT_TYPES_LEGACY,
  "dispatch",
  "deny",
  "dispatch_failed",
  "dispatch_skipped_duplicate",
  "dispatch_skipped_stale",
  "dispatch_skipped_paused",
  "auto_granted_existing_token",
  "request_refused",
  "legacy_payload_backfilled",
  "rollback_requeued",
] as const;

export const APPROVAL_EVENT_TYPES_GLOBAL = [
  "dispatch_skipped_capacity",
  "lease_skipped",
  "watcher_refused",
  "boot_snapshot",
  "schema_backfilled",
  "alert",
  "config_reload_failed",
] as const;

export type ApprovalEventTypeRequestScoped = (typeof APPROVAL_EVENT_TYPES_REQUEST_SCOPED)[number];
export type ApprovalEventTypeGlobal = (typeof APPROVAL_EVENT_TYPES_GLOBAL)[number];
export type ApprovalEventType = ApprovalEventTypeRequestScoped | ApprovalEventTypeGlobal;

export function isApprovalEventType(t: string): t is ApprovalEventType {
  return (
    (APPROVAL_EVENT_TYPES_REQUEST_SCOPED as readonly string[]).includes(t) ||
    (APPROVAL_EVENT_TYPES_GLOBAL as readonly string[]).includes(t)
  );
}

export function isRequestScopedApprovalEvent(t: string): t is ApprovalEventTypeRequestScoped {
  return (APPROVAL_EVENT_TYPES_REQUEST_SCOPED as readonly string[]).includes(t);
}

export function isGlobalApprovalEvent(t: string): t is ApprovalEventTypeGlobal {
  return (APPROVAL_EVENT_TYPES_GLOBAL as readonly string[]).includes(t);
}

export type MemoryConfig = {
  obsidianVaultPath?: string;
  obsidianDailyNotesSubdir: string;
  maxConversationTurns: number;
  flushModel: string;
  /** Phase 5 §8.6: per-agent compounding expertise file curation. */
  expertise?: {
    enabled: boolean;
    maxLinesPerFile: number;
    promoteThresholdProjects: number;
    globalDir: string;
    projectDirSubpath: string;
  };
};

export type CompletedRun = {
  runId: string;
  workflow: string;
  goal: string;
  verdict: Exclude<Verdict, "NEEDS_MORE"> | "ABORTED";
  artifacts: string[];
  changedFiles: string[];
  completedAt: string;
  wisdom: {
    learnings: string[];
    decisions: string[];
    issues_found: string[];
    gotchas: string[];
  };
};
