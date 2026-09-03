import { stagingDir } from "../codify/layout.js";
import { v3Enabled, type V3HostConfig } from "./dispatch.js";

export interface LedgerEvent {
  ts: string;
  type: string;
  ref?: string;
  code?: string;
  data?: Record<string, unknown>;
}

export interface LearnerGateOpts {
  now?: Date;
  forwardRoi?: number;
}

const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Fail-closed: empty/partial ledgers never justify the learner. */
export function learnerJustified(events: readonly LedgerEvent[], opts?: LearnerGateOpts): { ok: boolean; reason: string } {
  const now = opts?.now ?? new Date();
  const forwardRoi = opts?.forwardRoi ?? 3;
  const cutoff = now.getTime() - WINDOW_MS;
  const gaps = events.filter((event) => {
    if (event.type !== "verifier-gap") return false;
    const ts = Date.parse(event.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (gaps.length === 0) return { ok: false, reason: "no verifier-gap" };

  const bySignature = new Map<string, LedgerEvent[]>();
  for (const event of gaps) {
    const signature = asString(event.data?.signature);
    if (signature === undefined) continue;
    const list = bySignature.get(signature) ?? [];
    list.push(event);
    bySignature.set(signature, list);
  }

  let best = 0;
  let sawActive = false;
  let sawRoiFail = false;
  for (const [signature, list] of bySignature) {
    best = Math.max(best, list.length);
    if (list.length < 20) continue;
    if (list.some((event) => event.data?.codifyActive === true)) {
      sawActive = true;
      continue;
    }
    const saved = asNumber(list[0]?.data?.estimatedSavedUsd);
    const cost = asNumber(list[0]?.data?.estimatedLaneCost);
    if (saved === undefined || cost === undefined || cost <= 0) {
      sawRoiFail = true;
      continue;
    }
    if (saved >= forwardRoi * cost) return { ok: true, reason: `verifier-gap ${signature}` };
    sawRoiFail = true;
  }
  if (best < 20) return { ok: false, reason: `verifier-gap count ${best} < 20` };
  if (sawActive) return { ok: false, reason: "signature already active codify tool" };
  if (sawRoiFail) return { ok: false, reason: "roi below forwardRoi" };
  return { ok: false, reason: "not justified" };
}

export function maybeLearnerAgent(
  cfg: V3HostConfig,
  ledger: readonly LedgerEvent[],
  opts?: LearnerGateOpts,
): "learner" | null {
  if (!v3Enabled(cfg, "learner")) return null;
  return learnerJustified(ledger, opts).ok ? "learner" : null;
}

export function loadLearnerIfJustified(input: {
  cfg: V3HostConfig;
  events: readonly LedgerEvent[];
  now?: Date;
  forwardRoi?: number;
}): string[] {
  const extra = maybeLearnerAgent(input.cfg, input.events, { now: input.now, forwardRoi: input.forwardRoi });
  return extra === null ? [] : [extra];
}

export interface LearnerExecutor {
  run(req: {
    agent: "learner";
    extraUpsert: string[];
    tools: readonly string[];
    promote: boolean;
  }): Promise<{ ok: boolean }>;
}

export const LEARNER_TOOLS = ["read", "grep", "find", "write", "edit"] as const;

export async function runLearnerGap(
  gap: { signature: string; stagingId: string },
  opts: {
    cfg: V3HostConfig;
    events: readonly LedgerEvent[];
    executor: LearnerExecutor;
    home: string;
    now?: Date;
    forwardRoi?: number;
  },
): Promise<{ skipped: true; reason: string } | { skipped: false; state: "staged"; stagingDir: string }> {
  if (!v3Enabled(opts.cfg, "learner")) return { skipped: true, reason: "learner-flag-off" };
  const gate = learnerJustified(opts.events, { now: opts.now, forwardRoi: opts.forwardRoi });
  if (!gate.ok) return { skipped: true, reason: gate.reason };
  const dest = stagingDir(opts.home, gap.stagingId);
  await opts.executor.run({
    agent: "learner",
    extraUpsert: [dest],
    tools: LEARNER_TOOLS,
    promote: false,
  });
  return { skipped: false, state: "staged", stagingDir: dest };
}
