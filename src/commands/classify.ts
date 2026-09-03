import type { FactoryDeps } from "../controller/lane-runner.js";
import { isTicketKind } from "../trackers/adapter.js";
import { findQueueEntry, readQueue, writeQueue, type QueueEntry } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runClassify(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<QueueEntry> {
  const ref = parsed.args[0];
  const kind = parsed.args[1];
  if (ref === undefined || kind === undefined) throw new Error("classify: <ref> <kind> required");
  if (!isTicketKind(kind)) throw new Error(`classify: unknown kind ${kind}`);
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`classify: ${ref} not in queue`);
  entry.kind = kind;
  entry.state = "queued";
  entry.updatedAt = new Date().toISOString();
  await writeQueue(deps.runsDir, queue);
  return entry;
}
