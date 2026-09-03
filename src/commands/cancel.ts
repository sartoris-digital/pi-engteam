import type { FactoryDeps } from "../controller/lane-runner.js";
import type { RunState } from "../engine/types.js";
import { findQueueEntry, readQueue, writeQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runCancel(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RunState | { ref: string; state: string }> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("cancel: missing ref");
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`cancel: ${ref} not in queue`);
  let state: RunState | undefined;
  if (entry.runId !== undefined) {
    state = await deps.engine.cancelRun(entry.runId);
  }
  entry.state = "closed";
  entry.updatedAt = new Date().toISOString();
  await writeQueue(deps.runsDir, queue);
  return state ?? { ref: entry.ref, state: entry.state };
}
