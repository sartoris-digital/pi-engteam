import type { RunState, Verdict } from "../types.js";
import type { TeamRuntime } from "../team/TeamRuntime.js";
import type { Observer } from "../observer/Observer.js";
import type { ADWEngine } from "../adw/ADWEngine.js";

export type StepContext = {
  run: RunState;
  team: TeamRuntime;
  observer: Observer;
  engine: ADWEngine;
};

export type StepResult = {
  success: boolean;
  verdict: Verdict;
  issues?: string[];
  artifacts?: Record<string, string>;
  handoffHint?: string;
  error?: string;
  /**
   * PLAN.md round-A1 HIGH 4 + round-A5 (TYPE ONLY in Phase 1; ADWEngine
   * consumption lands in Phase 10).
   *
   * Future contract (NOT YET IMPLEMENTED): when a step's `run()` returns
   * `pauseForUser`, ADWEngine will transition the run to
   * `status: "waiting_user"`, record the reason in state.json for
   * /run-status, and keep the ApprovalWatcher registered. The run sits
   * in waiting_user until /run-resume (clears the field) or /run-cancel.
   * Used by the `adhoc-shell` workflow to hold a long-lived
   * approvals-only run.
   *
   * Phase 1 only lands the type so Phase 10 workflow code can declare
   * the field without TypeScript errors. Workflows that emit this field
   * BEFORE Phase 10 will see ADWEngine ignore it silently — see Phase 10
   * in PLAN.md for the consumption work.
   */
  pauseForUser?: { reason: string };
};

export type Step = {
  name: string;
  required: boolean;
  /** If set, engine pauses with this phase after a PASS verdict */
  pauseAfter?: "answering" | "approving";
  /** If set, engine applies this planMode to the run state before running the step */
  planMode?: boolean;
  /** Phase 3: when true, dispatch the verifier after the worker emits PASS for this step. */
  verify?: boolean;
  /** Phase 3: bound on verify→fail→re-iterate cycles for this step. Default 3. */
  maxVerifyLoops?: number;
  /** Phase 3: name of the worker agent that owns this step (used by the verifier loop to address corrective messages). If omitted, no verifier loop runs. */
  agent?: string;
  /** Phase 4: when false, force sequential execution after siblings sharing the same dependsOn set. Default true. */
  parallel?: boolean;
  /** Phase 4: step names that must complete (any verdict) before this step is eligible. */
  dependsOn?: string[];
  /**
   * Phase A item 5: absolute wall-clock budget for the step's
   * agent-deliver call. Defaults to 240s for normal steps and 360s
   * for judge-gate steps (handled at the engine level — workflows
   * may override). Includes any forced-retry attempts (the budget
   * is per-step, not per-attempt).
   */
  timeoutSeconds?: number;
  run: (ctx: StepContext) => Promise<StepResult>;
};

export type WorkflowTransition = {
  from: string;
  when: (r: StepResult) => boolean;
  to: string | "halt";
};

export type Workflow = {
  name: string;
  description: string;
  steps: Step[];
  transitions: WorkflowTransition[];
  defaults: Partial<RunState["budget"]>;
};
