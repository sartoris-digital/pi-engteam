/** Five operator actions from the steer dialog, plus "pending" when none is chosen yet. */
export type SteerAction = "approve" | "steer" | "replan" | "edit-approve" | "drop";

/**
 * In-memory steer decision handed to Engine.resumeRun.
 * Group 8 extends this module with the dialog UI; persist via src/steer/stage.ts.
 */
export interface SteerDecision {
  action: SteerAction | "pending";
  notes?: string;
  waive?: string[];
}
