import { createHash } from "node:crypto";
import type { Verdict } from "../engine/types.js";
import { vendorPrefix } from "../fusion/stack.js";
import type { FusionSlot } from "../fusion/types.js";
import { DispatchDisabled, assertV3, type V3HostConfig } from "./dispatch.js";

const HASH_PREFIX = "v3.secondReview\0";

export interface ReviewVerdict {
  verdict: Verdict;
  issues?: string[];
}

export interface SecondReviewRun {
  runId: string;
  tier: "low" | "elevated";
  firstModel?: string;
  stack?: FusionSlot[];
}

export function sampleSecondReview(runId: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  const digest = createHash("sha256").update(`${HASH_PREFIX}${runId}`).digest();
  const n = digest.readUInt32BE(0) / 0x1_0000_0000;
  return n < rate;
}

export function pickSecondSlot(stack: FusionSlot[], firstModel: string): FusionSlot | null {
  const vendor = vendorPrefix(firstModel);
  for (const slot of stack) {
    if (vendorPrefix(slot.model) !== vendor) return slot;
  }
  return null;
}

export function shouldSecondReview(cfg: V3HostConfig, run: SecondReviewRun): boolean {
  try {
    assertV3(cfg, "secondReview");
  } catch (err) {
    if (err instanceof DispatchDisabled) return false;
    throw err;
  }
  if (run.tier !== "low") return false;
  const rate = cfg.v3?.secondReview?.rate ?? 0.1;
  if (!sampleSecondReview(run.runId, rate)) return false;
  if (run.stack !== undefined && run.firstModel !== undefined) {
    return pickSecondSlot(run.stack, run.firstModel) !== null;
  }
  return true;
}

function attr(tag: string, issues: readonly string[] | undefined): string[] {
  return (issues ?? []).map((issue) => `[${tag}] ${issue}`);
}

/** Stricter-wins lattice: FAIL > NEEDS_MORE > PASS. PASS iff both PASS. */
export function mergeSecondReview(primary: ReviewVerdict, sampled: ReviewVerdict): ReviewVerdict {
  const issues = [...attr("primary", primary.issues), ...attr("sampled", sampled.issues)];
  let verdict: Verdict = "PASS";
  if (primary.verdict === "FAIL" || sampled.verdict === "FAIL") verdict = "FAIL";
  else if (primary.verdict === "NEEDS_MORE" || sampled.verdict === "NEEDS_MORE") verdict = "NEEDS_MORE";
  if (verdict === "PASS") return { verdict };
  return issues.length > 0 ? { verdict, issues } : { verdict };
}

export interface ApplySecondReviewOpts {
  cfg: V3HostConfig;
  run: { runId: string; tier: "low" | "elevated" };
  stack: FusionSlot[];
  firstModel: string;
  primary: ReviewVerdict;
  runSampled?: () => ReviewVerdict;
  mergeFn?: (primary: ReviewVerdict, sampled: ReviewVerdict) => ReviewVerdict;
}

export interface ApplySecondReviewResult {
  applied: boolean;
  verdict: ReviewVerdict;
  slot?: FusionSlot;
  evidence?: { fusion: { mode: "second-sample"; slots: Array<{ name: string; model: string; verdict?: Verdict }> } };
}

/**
 * Host wrapper. When the flag is off, the hash misses, the tier is elevated, or no
 * different-vendor slot exists, merge is not called and the primary verdict stands.
 */
export function applySecondReview(opts: ApplySecondReviewOpts): ApplySecondReviewResult {
  const should = shouldSecondReview(opts.cfg, {
    ...opts.run,
    firstModel: opts.firstModel,
    stack: opts.stack,
  });
  if (!should) return { applied: false, verdict: opts.primary };
  const slot = pickSecondSlot(opts.stack, opts.firstModel);
  if (slot === null) return { applied: false, verdict: opts.primary };
  const sampled = opts.runSampled?.();
  if (sampled === undefined) return { applied: false, verdict: opts.primary };
  const merge = opts.mergeFn ?? mergeSecondReview;
  const verdict = merge(opts.primary, sampled);
  return {
    applied: true,
    verdict,
    slot,
    evidence: {
      fusion: {
        mode: "second-sample",
        slots: [
          { name: "primary", model: opts.firstModel, verdict: opts.primary.verdict },
          { name: slot.name, model: slot.model, verdict: sampled.verdict },
        ],
      },
    },
  };
}
