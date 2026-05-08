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
