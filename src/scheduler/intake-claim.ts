import { randomBytes } from "node:crypto";
import { runIntakeAnalysis, type AnalystPort } from "../intake/analyze.js";
import { routeBrief } from "../intake/route.js";
import { isTicketKind, type Ticket, type TicketKind, type TrackerAdapter } from "../trackers/adapter.js";
import { stripTrackerPrior } from "../trackers/sanitize.js";
import type { LaneDef } from "../lanes/schema.js";
import type { WorkspaceProvider } from "../workspace/types.js";
import type { QueueEntry } from "./queue.js";

export interface ApplyIntakeOptions {
  ticket: Ticket;
  entry: QueueEntry;
  adapter: TrackerAdapter;
  analyst?: AnalystPort;
  kindOverride?: TicketKind;
  lanes?: Record<string, LaneDef>;
  writeRoots?: string[];
  repoResolvable?: boolean;
  nonce?: string;
  provider?: WorkspaceProvider;
}

const silentAnalyst: AnalystPort = {
  async sample() {
    throw new Error("analyst should not be called");
  },
};

function kindFromLabels(labels: string[]): TicketKind | undefined {
  for (const label of labels) {
    if (!label.startsWith("factory:kind=")) continue;
    const kind = label.slice("factory:kind=".length);
    if (isTicketKind(kind)) return kind;
  }
  return undefined;
}

/** After a successful claim (or local enqueue --kind), classify and park or mark ready. */
export async function applyIntake(opts: ApplyIntakeOptions): Promise<QueueEntry> {
  const override = opts.kindOverride ?? kindFromLabels(opts.ticket.labels);
  const localOverride = opts.ticket.ref.tracker === "local" && opts.kindOverride !== undefined;
  if (opts.analyst === undefined && override === undefined) return opts.entry;
  const prior = stripTrackerPrior(`${opts.ticket.title}\n${opts.ticket.body}\n${opts.ticket.labels.join(" ")}`).prior;
  const analysis = await runIntakeAnalysis(opts.ticket, {
    analyst: opts.analyst ?? silentAnalyst,
    nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    prior,
    ...(override === undefined ? {} : { kindOverride: override }),
    writeRoots: opts.writeRoots ?? ["**"],
    repoResolvable: opts.repoResolvable ?? true,
    body: opts.ticket.body,
    assignedToHuman: false,
  });
  const brief = analysis.brief;
  opts.entry.kind = brief.kind;
  opts.entry.tier = brief.tier;
  opts.entry.confidence = brief.confidence;
  opts.entry.lane = brief.lane;

  if (localOverride) {
    opts.entry.state = "ready";
    return opts.entry;
  }

  if (!analysis.dor.ok) {
    if (opts.ticket.ref.tracker === "local") {
      if (opts.lanes !== undefined && opts.lanes.grill !== undefined) opts.entry.lane = "grill";
      else opts.entry.state = "needs-info";
      return opts.entry;
    }
    opts.entry.state = analysis.dor.queueState;
  }

  const route = routeBrief(brief);
  if (route.action !== "proceed") {
    opts.entry.state = route.action;
    if (opts.ticket.ref.tracker !== "local") {
      await opts.adapter.comment(opts.ticket.ref, route.comment, { idempotencyKey: `abstention:${opts.entry.key}` });
      await opts.adapter.addLabel(opts.ticket.ref, "factory:needs-triage");
    } else if (opts.lanes !== undefined && opts.lanes.grill !== undefined) {
      opts.entry.lane = "grill";
    }
    return opts.entry;
  }

  if (opts.entry.state === "classifying" || opts.entry.state === "queued") opts.entry.state = "ready";
  return opts.entry;
}
