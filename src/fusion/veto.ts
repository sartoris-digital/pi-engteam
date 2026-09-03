import type { StepResult, Verdict } from "../engine/types.js";
import type { SlotResult } from "./types.js";

function missing(slot: SlotResult): boolean {
  return slot.timedOut === true || slot.verdict === undefined || Boolean(slot.error);
}

export function mergeVeto(slots: SlotResult[]): StepResult {
  if (slots.length === 0 || slots.some(missing)) {
    const issues = slots.length === 0 ? ["missing slot"] : slots.filter(missing).map((s) => `[${s.name}] missing vote`);
    return { verdict: "FAIL", issues };
  }
  const issues: string[] = [];
  let verdict: Verdict = "PASS";
  for (const slot of slots) {
    for (const issue of slot.issues ?? []) issues.push(`[${slot.name}] ${issue}`);
    if (slot.verdict === "FAIL") verdict = "FAIL";
    else if (slot.verdict === "NEEDS_MORE" && verdict !== "FAIL") verdict = "NEEDS_MORE";
  }
  return { verdict, ...(issues.length > 0 ? { issues } : {}) };
}
