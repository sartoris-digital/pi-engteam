import { fenceData } from "../safety/fence.js";
import { refToString, type Ticket, type TicketKind } from "../trackers/adapter.js";
import { sanitizeTicketText, stripTrackerPrior, type TrackerPrior } from "../trackers/sanitize.js";
import { screenText } from "../trackers/screen.js";
import { parseBrief, type Brief, type BriefFlag } from "./brief-schema.js";
import { computeConfidence, computeTier } from "./confidence.js";
import { evaluateDoR, type DorOpts, type DorResult } from "./dor.js";
import { mergeSamples } from "./merge-samples.js";

export type AnalystSlot = "A" | "B" | "tiebreak";

export interface AnalystPort {
  sample(input: { blindedTicket: string; slot: AnalystSlot }): Promise<Brief>;
}

export interface RunIntakeOptions {
  analyst: AnalystPort;
  nonce: string;
  prior: TrackerPrior;
  kindOverride?: TicketKind;
  k?: 2;
  writeRoots: string[];
  repoResolvable: boolean;
  body: string;
  assignedToHuman?: boolean;
  timeoutMs?: number;
}

export interface IntakeAnalysis {
  brief: Brief;
  dor: DorResult;
  modelCalls: number;
}

function uniqueFlags(flags: readonly BriefFlag[]): BriefFlag[] {
  const seen = new Set<BriefFlag>();
  const out: BriefFlag[] = [];
  for (const f of flags) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

function withScreen(brief: Brief, text: string): Brief {
  const screen = screenText(text);
  if (!screen.injectionSuspect) return { ...brief, flags: uniqueFlags(brief.flags) };
  return { ...brief, flags: uniqueFlags([...brief.flags, "injectionSuspect"]) };
}

function stampHost(brief: Brief, prior: Brief["prior"], samples: Brief[]): Brief {
  const screened = brief;
  const { confidence } = computeConfidence({ prior, samples, merged: screened });
  const next: Brief = {
    ...screened,
    prior,
    confidence,
    lane: screened.kind,
  };
  next.tier = computeTier(next);
  return next;
}

function fallbackBrief(kind: TicketKind, prior: Brief["prior"]): Brief {
  return {
    kind,
    flags: [],
    size: "M",
    reproSteps: "absent",
    acceptanceCriteria: [],
    likelyPaths: [],
    questions: ["intake samples failed"],
    goal: `${kind}: unclassified`,
    samples: { n: 0, kinds: [], acAgreement: 0 },
    prior,
    confidence: "LOW",
    tier: "low",
    lane: kind,
  };
}

const PATH_RE = /(?:^|[\s`'"(])((?:src|lib|tests|docs|scripts|apps|packages)\/[\w./-]+)/g;

function extractPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1];
    if (p === undefined || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function hostOverrideBrief(ticket: Ticket, kind: TicketKind, body: string, flags: BriefFlag[]): Brief {
  const prior: Brief["prior"] = { kind, from: "human" };
  const brief: Brief = {
    kind,
    flags: uniqueFlags(flags),
    size: "M",
    reproSteps: /\b(repro|steps to|expected)\b/i.test(body) ? "present" : "absent",
    acceptanceCriteria: [],
    likelyPaths: extractPaths(`${ticket.title}\n${ticket.body}\n${body}`),
    questions: [],
    goal: `${kind}: ${ticket.title} [${refToString(ticket.ref)}]`,
    samples: { n: 0, kinds: [], acAgreement: 1 },
    prior,
    confidence: "HIGH",
    tier: "low",
    lane: kind,
  };
  brief.tier = computeTier(brief);
  return brief;
}

function dorOpts(opts: RunIntakeOptions): DorOpts {
  return {
    repoResolvable: opts.repoResolvable,
    body: opts.body,
    assignedToHuman: opts.assignedToHuman,
    writeRoots: opts.writeRoots,
  };
}

async function sampleOnce(
  analyst: AnalystPort,
  blindedTicket: string,
  slot: AnalystSlot,
  timeoutMs: number | undefined,
): Promise<{ brief?: Brief; called: true }> {
  const work = (async () => {
    const raw = await analyst.sample({ blindedTicket, slot });
    return parseBrief(raw);
  })();
  if (timeoutMs === undefined || timeoutMs <= 0) {
    try {
      return { brief: await work, called: true };
    } catch {
      return { called: true };
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const brief = await Promise.race([
      work,
      new Promise<Brief>((_, reject) => {
        timer = setTimeout(() => reject(new Error("analyst timeout")), timeoutMs);
      }),
    ]);
    return { brief, called: true };
  } catch {
    return { called: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function briefPrior(prior: TrackerPrior, override?: TicketKind): Brief["prior"] {
  if (override !== undefined) return { kind: override, from: "human" };
  return prior.kind !== undefined ? { kind: prior.kind, from: prior.from } : { from: prior.from };
}

function analystPayload(ticket: Ticket, nonce: string): { fenced: string; sanitized: string } {
  const sanitized = sanitizeTicketText(`${ticket.title}\n\n${ticket.body}`);
  const { blinded } = stripTrackerPrior(sanitized);
  return { sanitized, fenced: fenceData(blinded, nonce, "TICKET") };
}

/**
 * k=2 blind intake. `--kind` / kindOverride skips model samples (D6) so v0
 * `enqueue --task --kind chore` never spawns issue-analyst.
 */
export async function runIntakeAnalysis(ticket: Ticket, opts: RunIntakeOptions): Promise<IntakeAnalysis> {
  const { sanitized, fenced } = analystPayload(ticket, opts.nonce);
  const screen = screenText(sanitized);
  const screenFlags: BriefFlag[] = screen.injectionSuspect ? ["injectionSuspect"] : [];

  if (opts.kindOverride !== undefined) {
    const brief = withScreen(hostOverrideBrief(ticket, opts.kindOverride, opts.body, screenFlags), sanitized);
    return { brief, dor: evaluateDoR(brief, dorOpts(opts)), modelCalls: 0 };
  }

  const slots: AnalystSlot[] = ["A", "B"];
  const parallel = await Promise.all(slots.map((slot) => sampleOnce(opts.analyst, fenced, slot, opts.timeoutMs)));
  let modelCalls = parallel.filter((r) => r.called).length;
  const collected: Brief[] = [];
  for (const r of parallel) if (r.brief !== undefined) collected.push(r.brief);

  const kinds = new Set(collected.map((b) => b.kind));
  if (collected.length >= 2 && kinds.size > 1 && modelCalls < 3) {
    const tie = await sampleOnce(opts.analyst, fenced, "tiebreak", opts.timeoutMs);
    modelCalls += 1;
    if (tie.brief !== undefined) collected.push(tie.brief);
  }

  const prior = briefPrior(opts.prior);
  let brief: Brief;
  if (collected.length === 0) {
    brief = fallbackBrief(prior.kind ?? "chore", prior);
    brief.samples = { n: 0, kinds: [], acAgreement: 0 };
  } else {
    brief = mergeSamples(collected);
    brief = stampHost(brief, prior, collected);
  }
  brief = withScreen(brief, sanitized);
  brief.tier = computeTier(brief);
  if (modelCalls > 3) modelCalls = 3;
  return { brief, dor: evaluateDoR(brief, dorOpts(opts)), modelCalls };
}
