import type { StepContext, StepResult } from "../engine/types.js";
import type { StageDef } from "./schema.js";

export type StepRunner = (ctx: StepContext) => Promise<StepResult>;

export interface StageHooks {
  agentStep(def: StageDef, stage: string): StepRunner;
  hostStep(def: StageDef, stage: string): StepRunner;
  humanStep(def: StageDef, stage: string): StepRunner;
}
