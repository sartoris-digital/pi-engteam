import type { StepResult } from "../engine/types.js";
import type { SlotResult } from "./types.js";

export function mergeOpinion(slots: SlotResult[]): StepResult {
  const body = slots.map((slot) => `[${slot.name}]\n${slot.text}`.trimEnd()).join("\n\n");
  return { verdict: "PASS", artifacts: { opinion: body } };
}
