import type { FactoryDeps } from "../controller/lane-runner.js";
import { applyIntake } from "../scheduler/intake-claim.js";
import { TERMINAL_QUEUE_STATES, queueKey, readQueue, writeQueue, type QueueEntry } from "../scheduler/queue.js";
import type { Ticket, TicketKind } from "../trackers/adapter.js";
import { isTicketKind, refToString } from "../trackers/adapter.js";
import { looksLikeSecret } from "../vault/input-guard.js";
import type { ParsedFactoryArgs } from "./router.js";

export {
  QUEUE_STATES,
  TERMINAL_QUEUE_STATES,
  findQueueEntry,
  isQueueState,
  queueKey,
  queuePath,
  queueStateFor,
  readQueue,
  writeQueue,
} from "../scheduler/queue.js";
export type {
  BriefConfidence,
  LandedAs,
  QueueEntry,
  QueueFile,
  QueueState,
  QueueWorkspace,
} from "../scheduler/queue.js";

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

const TERMINAL = TERMINAL_QUEUE_STATES;

export async function runEnqueue(
  parsed: ParsedFactoryArgs,
  deps: FactoryDeps,
): Promise<{ ticket: Ticket; entry: QueueEntry }> {
  const repoFlag = flagString(parsed.flags, "repo");
  let repo = repoFlag;
  if (repo === undefined) {
    if (deps.repos.length > 1) throw new Error("enqueue: --repo is required when multiple repos are registered");
    repo = deps.repos[0] ?? deps.projectRootDefault;
  }
  const kindFlag = flagString(parsed.flags, "kind");
  const kindOverride = isTicketKind(kindFlag) ? kindFlag : undefined;
  const kind: TicketKind = kindOverride ?? "chore";
  const lane = flagString(parsed.flags, "lane");
  const now = new Date().toISOString();

  let ticket: Ticket;
  const refArg = parsed.args[0];
  if (typeof parsed.flags.task === "string") {
    if (looksLikeSecret(parsed.flags.task)) throw new Error("enqueue: looks like a secret; use /factory secret set");
    ticket = await deps.tracker.createFromTask(parsed.flags.task, { kind });
  } else if (refArg !== undefined) {
    const parsedRef = deps.tracker.parseRef(refArg) ?? { tracker: "local", id: refArg };
    ticket = await deps.tracker.fetch(parsedRef);
  } else {
    throw new Error("enqueue: --task is required (or pass an existing local ref)");
  }

  const ref = ticket.ref.tracker === "local" ? ticket.ref.id : refToString(ticket.ref);
  const key = queueKey(ticket.ref.tracker, repo, ref);
  const queue = await readQueue(deps.runsDir);
  const existing = queue.entries.find((e) => e.key === key && !TERMINAL.has(e.state));
  if (existing !== undefined) {
    existing.updatedAt = now;
    existing.priority = "p2";
    await writeQueue(deps.runsDir, queue);
    return { ticket, entry: existing };
  }

  const entry: QueueEntry = {
    key,
    tracker: ticket.ref.tracker,
    repo,
    ref,
    priority: "p2",
    state: "queued",
    kind: ticket.kind ?? kind,
    ...(lane === undefined ? {} : { lane }),
    enqueuedAt: now,
    updatedAt: now,
  };
  queue.entries.push(entry);
  if (kindOverride !== undefined) {
    await applyIntake({
      ticket,
      entry,
      adapter: deps.tracker,
      analyst: deps.analyst,
      kindOverride,
      lanes: deps.lanes,
      repoResolvable: true,
    });
  }
  await writeQueue(deps.runsDir, queue);
  return { ticket, entry };
}
