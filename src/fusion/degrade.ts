import type { StepResult, Verdict } from "../engine/types.js";
import type { FusionMode, FusionSlot, SlotResult } from "./types.js";

export interface FusionEvidenceSlot {
  name: string;
  model: string;
  verdict?: Verdict;
  durationMs?: number;
  cost?: number;
  artifact?: string;
}

export interface FusionEvidence {
  mode: string;
  slots: FusionEvidenceSlot[];
  merge: { method: string; discarded: string[] };
  requested: string[];
  ran: FusionEvidenceSlot[];
}

export function isDroppedSlot(slot: SlotResult): boolean {
  return slot.timedOut === true || slot.verdict === undefined || Boolean(slot.error);
}

export function degradeSlots(
  mode: FusionMode,
  slots: SlotResult[],
): { remaining: SlotResult[]; discarded: SlotResult[]; failClosed: boolean } {
  const remaining = slots.filter((s) => !isDroppedSlot(s));
  const discarded = slots.filter(isDroppedSlot);
  const failClosed = remaining.length === 0 || (mode === "veto" && discarded.length > 0);
  return { remaining, discarded, failClosed };
}

export function resolvePinnedModel(
  pin: string,
  stack: FusionSlot[],
  defaultModel: string,
  unavailable: ReadonlySet<string> = new Set(),
): { model: string; degraded: boolean; requested: string } {
  const slot = stack.find((s) => s.name === pin || s.model === pin);
  if (!slot || unavailable.has(slot.name) || unavailable.has(slot.model)) {
    return { model: defaultModel, degraded: true, requested: pin };
  }
  return { model: slot.model, degraded: false, requested: pin };
}

export function slotEvidence(slot: SlotResult): FusionEvidenceSlot {
  return {
    name: slot.name,
    model: slot.model,
    ...(slot.verdict ? { verdict: slot.verdict } : {}),
    ...(slot.durationMs !== undefined ? { durationMs: slot.durationMs } : {}),
    cost: slot.costUsd ?? 0,
    ...(slot.artifact ? { artifact: slot.artifact } : {}),
  };
}

export function fusionEvidence(opts: {
  mode: FusionMode;
  all: SlotResult[];
  remaining: SlotResult[];
  discarded: SlotResult[];
}): FusionEvidence {
  return {
    mode: opts.mode,
    slots: opts.all.map(slotEvidence),
    merge: { method: opts.mode, discarded: opts.discarded.map((s) => s.name) },
    requested: opts.all.map((s) => s.name),
    ran: opts.remaining.map(slotEvidence),
  };
}

export function withFusionEvidence(result: StepResult, evidence: FusionEvidence, timedOut: boolean): StepResult {
  return {
    ...result,
    evidence: {
      ...result.evidence,
      timedOut: result.evidence?.timedOut === true || timedOut,
      fusion: evidence,
    },
  };
}
