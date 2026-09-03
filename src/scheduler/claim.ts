import type { Ticket, TrackerAdapter } from "../trackers/adapter.js";
import { splitGitHubId } from "../trackers/github.js";
import { appendLedger } from "./ledger.js";
import { factoryBranchPrefix } from "./admission.js";
import {
  TERMINAL_QUEUE_STATES,
  queueKey,
  type QueueEntry,
  type QueueFile,
} from "./queue.js";

export interface ClaimTicketOptions {
  adapter: TrackerAdapter;
  ticket: Ticket;
  queue: QueueFile;
  authorized: boolean;
  runsDir: string;
  now?: () => Date;
  openPrHeads?: string[];
  repo?: string;
}

function githubParts(ticket: Ticket): { repo: string; number: string } | null {
  if (ticket.ref.tracker !== "github") return null;
  const split = splitGitHubId(ticket.ref.id);
  if (split === null) return null;
  return { repo: split.repo, number: String(split.number) };
}

function entryKey(ticket: Ticket, repo: string): string {
  const gh = githubParts(ticket);
  if (gh !== null) return queueKey("github", gh.repo, gh.number);
  return queueKey(ticket.ref.tracker, repo, ticket.ref.id);
}

function priorityOf(ticket: Ticket): QueueEntry["priority"] {
  if (ticket.labels.includes("factory:urgent") || ticket.priority === "p0") return "p0";
  if (ticket.priority === "p1" || ticket.priority === "p2" || ticket.priority === "p3") return ticket.priority;
  return "p2";
}

export async function claimTicket(opts: ClaimTicketOptions): Promise<{ entry: QueueEntry; skipped?: "unauthorized" | "dedupe-open" }> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const gh = githubParts(opts.ticket);
  const repo = opts.repo ?? gh?.repo ?? opts.ticket.ref.id;
  const key = entryKey(opts.ticket, repo);
  const ref = gh?.number ?? opts.ticket.ref.id;

  if (!opts.authorized) {
    await appendLedger(opts.runsDir, {
      ts: now,
      type: "unauthorized-trigger",
      code: "unauthorized-trigger",
      key,
      ref,
    });
    const ghost: QueueEntry = {
      key,
      tracker: opts.ticket.ref.tracker,
      repo,
      ref,
      priority: priorityOf(opts.ticket),
      state: "abandoned",
      enqueuedAt: now,
      updatedAt: now,
    };
    return { entry: ghost, skipped: "unauthorized" };
  }

  const existing = opts.queue.entries.find((e) => e.key === key && !TERMINAL_QUEUE_STATES.has(e.state));
  if (existing !== undefined) return { entry: existing, skipped: "dedupe-open" };

  const prefix = factoryBranchPrefix(opts.ticket.ref.tracker, ref);
  if ((opts.openPrHeads ?? []).some((h) => h.startsWith(prefix))) {
    return {
      entry: {
        key,
        tracker: opts.ticket.ref.tracker,
        repo,
        ref,
        priority: priorityOf(opts.ticket),
        state: "abandoned",
        enqueuedAt: now,
        updatedAt: now,
      },
      skipped: "dedupe-open",
    };
  }

  await opts.adapter.removeLabel(opts.ticket.ref, "factory:ready");
  await opts.adapter.addLabel(opts.ticket.ref, "factory:in-progress");
  await opts.adapter.acknowledge(opts.ticket.ref);

  const entry: QueueEntry = {
    key,
    tracker: opts.ticket.ref.tracker,
    repo,
    ref,
    ...(opts.ticket.url === undefined ? {} : { url: opts.ticket.url }),
    priority: priorityOf(opts.ticket),
    state: "classifying",
    ...(opts.ticket.kind === undefined ? {} : { kind: opts.ticket.kind }),
    claimedAt: now,
    attempts: 1,
    writebacks: { [`claim:${opts.ticket.ref.id}`]: now },
    enqueuedAt: now,
    updatedAt: now,
  };
  opts.queue.entries.push(entry);
  await appendLedger(opts.runsDir, { ts: now, type: "factory.ticket.claimed", key, ref, to: "classifying" });
  return { entry };
}
