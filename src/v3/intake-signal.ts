import { KINDS, type Kind } from "../config/schema.js";
import type { BriefConfidence } from "../intake/brief-schema.js";
import { DispatchDisabled, assertV3, type V3HostConfig } from "./dispatch.js";
import type { SetFitEncoder } from "./setfit.js";

const SETFIT_CLASSES: readonly Kind[] = KINDS;

export interface SetFitPrior {
  kind: Kind;
  from: "setfit";
  score: number;
}

export interface SetFitSignalResult {
  used: boolean;
  reason?: string;
  prior?: SetFitPrior;
  resolvedKind?: Kind;
  confidenceBump?: true;
  event?: { type: "factory.v3.setfit.disagree"; data: Record<string, unknown> };
}

export interface SetFitSignalInput {
  cfg: V3HostConfig;
  text: string;
  counts: Record<string, number>;
  encoder: SetFitEncoder;
  humanKind?: Kind;
  trackerPrior?: { kind?: Kind; from: string };
  minLabelsPerClass?: number;
}

/**
 * Fail-closed 40/class gate. Duplicate of ledger-gates.setfitReady until that module lands.
 * Missing class key or any class below min → not ready.
 */
export function setfitReady(counts: Record<string, number>, minPerClass: number): { ok: boolean; reason: string } {
  if (!Number.isFinite(minPerClass) || minPerClass <= 0) {
    return { ok: false, reason: "invalid-min" };
  }
  for (const kind of SETFIT_CLASSES) {
    const n = counts[kind];
    if (n === undefined) return { ok: false, reason: `missing-class:${kind}` };
    if (n < minPerClass) return { ok: false, reason: `class ${kind} has ${n} < ${minPerClass}` };
  }
  return { ok: true, reason: "ready" };
}

export function bumpConfidenceOneStep(level: BriefConfidence): BriefConfidence {
  if (level === "LOW") return "MEDIUM";
  return "HIGH";
}

/**
 * Fourth intake signal. Flag off or unready → `{ used: false }` and encoder.infer is not called.
 * Human override is terminal. Tracker prior is terminal on disagreement (log only).
 * SetFit is never shown to the analyst; this module does not fence or sample.
 */
export async function applySetFitSignal(input: SetFitSignalInput): Promise<SetFitSignalResult> {
  try {
    assertV3(input.cfg, "setfit");
  } catch (err) {
    if (err instanceof DispatchDisabled) return { used: false, reason: "flag-off" };
    throw err;
  }

  const min = input.minLabelsPerClass ?? input.cfg.v3?.setfit?.minLabelsPerClass ?? 40;
  const ready = setfitReady(input.counts, min);
  if (!ready.ok) return { used: false, reason: ready.reason };

  if (input.humanKind !== undefined) {
    return { used: false, reason: "human-override", resolvedKind: input.humanKind };
  }

  let pred: { kind: Kind; score: number };
  try {
    pred = await input.encoder.infer(input.text);
  } catch (err) {
    return { used: false, reason: `infer-failed:${(err as Error).message}` };
  }

  const prior: SetFitPrior = { kind: pred.kind, from: "setfit", score: pred.score };
  const trackerKind = input.trackerPrior?.kind;
  if (trackerKind !== undefined && trackerKind !== pred.kind) {
    return {
      used: true,
      prior,
      resolvedKind: trackerKind,
      event: {
        type: "factory.v3.setfit.disagree",
        data: { setfit: pred.kind, tracker: trackerKind, from: input.trackerPrior?.from },
      },
    };
  }
  if (trackerKind !== undefined && trackerKind === pred.kind) {
    return { used: true, prior, resolvedKind: trackerKind, confidenceBump: true };
  }
  return { used: true, prior, resolvedKind: pred.kind };
}
