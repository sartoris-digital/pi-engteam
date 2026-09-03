import type { FactoryDeps } from "../controller/lane-runner.js";
import { findQueueEntry, readQueue, writeQueue, type QueueEntry } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runLanded(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<QueueEntry> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("landed: missing ref");
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`landed: ${ref} not in queue`);
  entry.state = "landed";
  entry.landedBy = "operator";
  entry.landedAs = parsed.flags.modified === true ? "human-modified" : "clean";
  if (typeof parsed.flags.sha === "string") entry.landedSha = parsed.flags.sha;
  entry.updatedAt = new Date().toISOString();
  await writeQueue(deps.runsDir, queue);
  return entry;
}
