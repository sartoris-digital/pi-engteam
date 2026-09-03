import type { FactoryDeps } from "../controller/lane-runner.js";
import { findQueueEntry, readQueue, writeQueue, type QueueEntry } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runRetry(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<QueueEntry> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("retry: missing ref");
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`retry: ${ref} not in queue`);
  if (entry.state !== "abandoned") throw new Error(`retry: ${ref} is ${entry.state}, not abandoned`);
  entry.state = "queued";
  entry.updatedAt = new Date().toISOString();
  await writeQueue(deps.runsDir, queue);
  const adapter = deps.adapters?.get(entry.tracker) ?? deps.tracker;
  await adapter.removeLabel({ tracker: entry.tracker, id: entry.ref }, "factory:abandoned").catch(() => undefined);
  return entry;
}
