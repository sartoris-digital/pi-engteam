import type { AcceptanceCriterion, Brief, BriefFlag, TicketKind } from "./brief-schema.js";

const TOKEN_RE = /[a-z0-9]+/g;

function unique<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function quotedCount(brief: Brief): number {
  return brief.acceptanceCriteria.filter((ac) => ac.source === "quoted").length;
}

export function acTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(TOKEN_RE)) {
    if (m[0] !== undefined && m[0].length > 0) tokens.add(m[0]);
  }
  return tokens;
}

function sampleTokenSet(brief: Brief): Set<string> {
  const tokens = new Set<string>();
  for (const ac of brief.acceptanceCriteria) {
    for (const t of acTokens(`${ac.text} ${ac.quote}`)) tokens.add(t);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Pairwise-average Jaccard over each sample's normalised AC token set (spec §3.8). */
export function acAgreement(samples: readonly Brief[]): number {
  if (samples.length <= 1) return 1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i++) {
    const left = sampleTokenSet(samples[i]!);
    for (let j = i + 1; j < samples.length; j++) {
      sum += jaccard(left, sampleTokenSet(samples[j]!));
      n += 1;
    }
  }
  return n === 0 ? 1 : sum / n;
}

function majorityKind(samples: readonly Brief[]): TicketKind {
  const counts = new Map<TicketKind, number>();
  for (const s of samples) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  let best: TicketKind = samples[0]?.kind ?? "chore";
  let bestN = -1;
  for (const [kind, n] of counts) {
    if (n > bestN) {
      best = kind;
      bestN = n;
    }
  }
  return best;
}

function majoritySize(samples: readonly Brief[]): Brief["size"] {
  const counts = new Map<Brief["size"], number>();
  for (const s of samples) counts.set(s.size, (counts.get(s.size) ?? 0) + 1);
  let best: Brief["size"] = samples[0]?.size ?? "M";
  let bestN = -1;
  for (const [size, n] of counts) {
    if (n > bestN) {
      best = size;
      bestN = n;
    }
  }
  return best;
}

function pickAcceptance(samples: readonly Brief[]): AcceptanceCriterion[] {
  let best = samples[0]?.acceptanceCriteria ?? [];
  let bestQuoted = -1;
  for (const s of samples) {
    const n = quotedCount(s);
    if (n > bestQuoted) {
      bestQuoted = n;
      best = s.acceptanceCriteria;
    }
  }
  return best.map((ac) => ({ ...ac }));
}

function intersectDuplicates(samples: readonly Brief[]): string | undefined {
  const sets = samples.map((s) => (s.possibleDuplicateOf !== undefined ? new Set([s.possibleDuplicateOf]) : new Set<string>()));
  if (sets.length === 0) return undefined;
  let inter = sets[0]!;
  for (const next of sets.slice(1)) {
    const keep = new Set<string>();
    for (const v of inter) if (next.has(v)) keep.add(v);
    inter = keep;
  }
  const first = [...inter][0];
  return first;
}

/** Deterministic merge of k samples (spec §3.8 table). Host fields are placeholders. */
export function mergeSamples(samples: Brief[]): Brief {
  if (samples.length === 0) {
    throw new Error("mergeSamples: need at least one sample");
  }
  const first = samples[0]!;
  const kind = majorityKind(samples);
  const flags = unique(samples.flatMap((s) => s.flags)) as BriefFlag[];
  const likelyPaths = unique(samples.flatMap((s) => s.likelyPaths));
  const questions = unique(samples.flatMap((s) => s.questions));
  const duplicate = intersectDuplicates(samples);
  const present = samples.filter((s) => s.reproSteps === "present").length;
  const merged: Brief = {
    kind,
    flags,
    size: majoritySize(samples),
    reproSteps: present >= Math.ceil(samples.length / 2) ? "present" : "absent",
    acceptanceCriteria: pickAcceptance(samples),
    likelyPaths,
    questions,
    goal: samples.map((s) => s.goal).find((g) => g.trim().length > 0) ?? first.goal,
    samples: {
      n: samples.length,
      kinds: samples.map((s) => s.kind),
      acAgreement: acAgreement(samples),
    },
    prior: { ...first.prior },
    confidence: first.confidence,
    tier: first.tier,
    lane: kind,
  };
  if (duplicate !== undefined) merged.possibleDuplicateOf = duplicate;
  return merged;
}
