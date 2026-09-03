import type { FactoryDeps } from "../controller/lane-runner.js";
import { findQueueEntry, readQueue, writeQueue, type QueueEntry } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

/** Marks the entry closed. Worktree is retained — do not call provider.remove. */
export async function runClosed(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<QueueEntry> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("closed: missing ref");
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`closed: ${ref} not in queue`);
  entry.state = "closed";
  entry.updatedAt = new Date().toISOString();
  await writeQueue(deps.runsDir, queue);
  return entry;
}
