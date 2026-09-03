import { DEFAULTS } from "../config/defaults.js";
import { matchesAny } from "../gate/glob.js";
import type { TicketKind } from "../trackers/adapter.js";
import type { Brief, BriefConfidence, BriefFlag, BriefTier } from "./brief-schema.js";

export interface ConfidenceOpts {
  prior?: { kind?: TicketKind; from: string };
  samples: Brief[];
  merged: Brief;
}

export interface ConfidenceResult {
  confidence: BriefConfidence;
  priorDisagreed?: true;
}

function priorKind(prior?: { kind?: TicketKind; from: string }): TicketKind | undefined {
  if (prior === undefined || prior.from === "none" || prior.kind === undefined) return undefined;
  return prior.kind;
}

function allSameKind(samples: readonly Brief[]): boolean {
  if (samples.length === 0) return false;
  const kind = samples[0]!.kind;
  return samples.every((s) => s.kind === kind);
}

function downgrade(level: BriefConfidence): BriefConfidence {
  if (level === "HIGH") return "MEDIUM";
  return "LOW";
}

/** Code-computed confidence (spec §3.8). Never read from the model. */
export function computeConfidence(opts: ConfidenceOpts): ConfidenceResult {
  const { samples, merged, prior } = opts;
  const unanimous = samples.length >= 2 && allSameKind(samples);
  const pk = priorKind(prior);
  let priorDisagreed: true | undefined;
  let confidence: BriefConfidence;

  if (!unanimous) {
    confidence = "LOW";
  } else if (pk === undefined) {
    confidence = "MEDIUM";
  } else if (pk === samples[0]!.kind) {
    confidence = "HIGH";
  } else {
    confidence = "MEDIUM";
    priorDisagreed = true;
  }

  if (merged.samples.acAgreement < 0.5) confidence = downgrade(confidence);

  return priorDisagreed === true ? { confidence, priorDisagreed } : { confidence };
}

const ELEVATED_FLAGS: ReadonlySet<BriefFlag> = new Set([
  "security",
  "needsDeps",
  "touchesMigrations",
  "injectionSuspect",
]);

export function computeTier(
  brief: Pick<Brief, "kind" | "flags" | "size" | "confidence" | "likelyPaths">,
  riskPaths: readonly string[] = DEFAULTS.repo.riskPaths,
): BriefTier {
  if (brief.flags.some((f) => ELEVATED_FLAGS.has(f))) return "elevated";
  if (brief.kind === "feature" && brief.confidence === "MEDIUM") return "elevated";
  if (brief.kind === "feature" && brief.size === "L") return "elevated";
  if (brief.likelyPaths.some((p) => matchesAny(p, riskPaths))) return "elevated";
  return "low";
}
