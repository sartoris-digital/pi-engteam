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
