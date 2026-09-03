import type { Verdict } from "../engine/types.js";

export const FUSION_MODES = [
  "sample",
  "opinion",
  "fuse",
  "debate",
  "adversarial",
  "veto",
  "collaborate",
] as const;
export type FusionMode = (typeof FUSION_MODES)[number];

export interface FusionSlot {
  name: string;
  model: string;
  thinking?: string;
}

export interface FusionRequest {
  mode: FusionMode;
  slots: FusionSlot[];
  stage: string;
  synthesizer?: string;
  syncBack?: boolean;
  /** Debate rounds, capped at 3. */
  rounds?: number;
}

export function isFusionMode(value: string): value is FusionMode {
  return (FUSION_MODES as readonly string[]).includes(value);
}

export interface SlotResult {
  name: string;
  model: string;
  verdict?: Verdict;
  text: string;
  artifact?: string;
  timedOut?: boolean;
  costUsd?: number;
  durationMs?: number;
  flags?: string[];
  issues?: string[];
  error?: string;
  fenced?: string;
}
