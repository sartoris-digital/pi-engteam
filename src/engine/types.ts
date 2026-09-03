import type { EffectiveRepoConfig } from "../config/schema.js";
import type { FactoryEvent } from "../observer/index.js";
import type { SteerDecision } from "../steer/dialog.js";

/**
 * The event shape written to <runDir>/events.jsonl. Declared once in src/observer/events.ts
 * (Task 0.5) — categories come from EVENT_CATEGORIES there and the timestamp field is `ts`.
 * Re-exported so engine consumers have a single import site.
 */
export type { FactoryEvent };

export type Verdict = "PASS" | "FAIL" | "NEEDS_MORE";
export type StepKind = "agent" | "host" | "human";
export type RunStatus =
  | "pending"
  | "running"
  | "waiting_user"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "waiting_user",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
];

export type EscalationCode =
  | "needs-decision"
  | "env-setup-failed"
  | "checks-timeout"
  | "gate-invalid"
  | "gate-baseline-green"
  | "test-tampering"
  | "scope-violation"
  | "too-large"
  | "loop-exhausted"
  | "stall"
  | "budget-exhausted"
  | "safety-block"
  | "config-tampered"
  | "judge-fail-final"
  | "publish-refused"
  | "push-rejected"
  | "approval-needed"
  | "worker-crash"
  | "workspace-lost"
  | "steer-timeout"
  | "needs-triage"
  | "needs-info"
  | "duplicate-suspected"
  | "base-red"
  | "cannot-reproduce"
  | "gate-defect"
  | "dependency-denied"
  | "security-fail"
  | "rebase-conflict"
  | "rule-violation"
  | "needs-rebase"
  | "human-owned";

export const ESCALATION_CODES: readonly EscalationCode[] = [
  "needs-decision",
  "env-setup-failed",
  "checks-timeout",
  "gate-invalid",
  "gate-baseline-green",
  "test-tampering",
  "scope-violation",
  "too-large",
  "loop-exhausted",
  "stall",
  "budget-exhausted",
  "safety-block",
  "config-tampered",
  "judge-fail-final",
  "publish-refused",
  "push-rejected",
  "approval-needed",
  "worker-crash",
  "workspace-lost",
  "steer-timeout",
  "needs-triage",
  "needs-info",
  "duplicate-suspected",
  "base-red",
  "cannot-reproduce",
  "gate-defect",
  "dependency-denied",
  "security-fail",
  "rebase-conflict",
  "rule-violation",
  "needs-rebase",
  "human-owned",
];

export function isEscalationCode(value: unknown): value is EscalationCode {
  return typeof value === "string" && (ESCALATION_CODES as readonly string[]).includes(value);
}

/** Signed per-stage evidence record; written to <runDir>/evidence/stage-<stage>-r<round>.json (+ .sig). */
export interface EvidenceRecord {
  stage: string;
  round: number;
  agent: string; // agent name, "host:<action>", or "human"
  verdict: Verdict | "AUTO";
  predicates: { name: string; ok: boolean; note?: string }[];
  artifacts: { path: string; sha256: string }[];
  commands: { argv: string[]; exitCode: number; durationMs: number; outputTail: string }[];
  synthesized: string[];
  timedOut: boolean;
  headSha: string;
  skipped?: boolean;
  humanIntervened?: { turns: number };
  at: string;
  fusion?: {
    mode: string;
    slots: Array<{
      name: string;
      model: string;
      verdict?: Verdict;
      durationMs?: number;
      cost?: number;
      artifact?: string;
    }>;
    merge: { method: string; discarded: string[] };
    requested?: string[];
    ran?: Array<{
      name: string;
      model: string;
      verdict?: Verdict;
      durationMs?: number;
      cost?: number;
      artifact?: string;
    }>;
  };
}

export interface StepContext {
  state: RunState;
  runDir: string;
  workspaceDir: string;
  cfg: EffectiveRepoConfig;
  nonce: string;
  emit: (event: FactoryEvent) => void;
  signal: AbortSignal;
}

export interface StepResult {
  verdict: Verdict;
  issues?: string[];
  artifacts?: Record<string, string>; // logical name → absolute path
  evidence?: Partial<EvidenceRecord>; // predicates, commands, synthesized, timedOut
  pauseForUser?: { reason: "steer" | "approval-needed" | "plan-approval" | "handoff"; packetPath?: string };
  escalate?: EscalationCode;
  commit?: { message: string }; // host performs checkpoint commit after the step
  /** Engine addition: cost this step consumed; the engine adds it to RunState.costUsd. */
  costUsd?: number;
}

export interface Step {
  name: string;
  kind: StepKind;
  agent?: string;
  mode?: string;
  host?: string;
  when?: string; // expr.ts grammar; absent = always
  gates: string[]; // predicate ids from catalog
  onFail: "fix-round" | `escalate:${string}` | "continue";
  maxRounds?: number;
  locked?: boolean;
  safetyGating?: boolean;
  verify?: boolean;
  timeoutSeconds?: number;
  run: (ctx: StepContext) => Promise<StepResult>;
}

export interface Transition {
  from: string;
  when: (r: StepResult) => boolean;
  to: string | "halt" | "escalate";
}

export interface Workflow {
  name: string; // "factory-sdlc:<lane>@<sha8>"
  lane: string;
  laneClass: "build" | "pre-build" | "meta";
  steps: Step[];
  transitions: Transition[];
  budget: { fixRounds: number; maxWallSeconds: number; maxCostUsd: number; maxIterations: number };
}

export interface StepRecord {
  name: string;
  round: number;
  verdict: Verdict;
  issues?: string[];
  startedAt: string;
  endedAt: string;
  evidencePath?: string;
}

export interface Escalation {
  code: EscalationCode;
  detail: string;
  at: string;
  step: string;
  humanAction?: string;
}

export interface RunState {
  runId: string;
  workflow: string;
  lane: string;
  kind: "feature" | "enhancement" | "bug" | "chore";
  tier: "low" | "elevated";
  status: RunStatus;
  phase?: "cancelling";
  currentStep: string;
  iteration: number;
  rounds: Record<string, number>; // per fix-round stage
  steps: StepRecord[];
  artifacts: Record<string, string>;
  ticket: { tracker: string; ref: string; title: string; url?: string };
  workspaceDir: string;
  mainCheckout: string;
  branch: string;
  baseSha: string;
  hostCommits: string[];
  judgedSha?: string;
  escalation?: Escalation;
  pauseForUser?: StepResult["pauseForUser"];
  /**
   * Engine addition: the decision handed to Engine.resumeRun. Visible to the resumed step as
   * ctx.state.resumeDecision for exactly one attempt. Cleared from durable state before that
   * attempt is invoked. The engine never persists a steer-decision file — src/steer/stage.ts owns that.
   */
  resumeDecision?: SteerDecision;
  budget: { maxWallSeconds: number; maxCostUsd: number; maxIterations: number; fixRounds: number };
  wallSecondsUsed: number; // excludes paused time
  costUsd: number;
  configSha: string;
  nonce: string;
  startedAt: string;
  updatedAt: string;
}

/** Scope handed to the injected `when` evaluator (Engine deps.evalWhen). */
export interface WhenScope {
  tier: RunState["tier"];
  kind: RunState["kind"];
  lane: string;
  iteration: number;
  rounds: Record<string, number>;
  artifacts: Record<string, string>;
}
