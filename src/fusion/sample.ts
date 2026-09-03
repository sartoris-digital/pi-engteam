import type { StepResult, Verdict } from "../engine/types.js";
import type { SlotResult } from "./types.js";

export function mergeSample(slots: SlotResult[]): StepResult {
  const votes = new Map<Verdict, number>();
  const flags = new Set<string>();
  const issues: string[] = [];
  for (const slot of slots) {
    if (slot.verdict && !slot.timedOut) {
      votes.set(slot.verdict, (votes.get(slot.verdict) ?? 0) + 1);
    }
    for (const flag of slot.flags ?? []) flags.add(flag);
    for (const issue of slot.issues ?? []) issues.push(`[${slot.name}] ${issue}`);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  const verdict: Verdict =
    top === undefined ? "FAIL" : second !== undefined && second[1] === top[1] ? "NEEDS_MORE" : top[0];
  if (flags.size > 0) issues.push(`flags: ${[...flags].join(", ")}`);
  return { verdict, ...(issues.length > 0 ? { issues } : {}) };
}
