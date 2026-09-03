import { join } from "node:path";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { attachRunWorkflow, runObservers } from "../controller/lane-runner.js";
import { Observer } from "../observer/events.js";
import type { RunState } from "../engine/types.js";
import { writeSteerDecision } from "../steer/stage.js";
import { findQueueEntry, queueStateFor, readQueue, writeQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runReplan(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RunState> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("replan: missing ref");
  const notesRaw = parsed.args.slice(1).join(" ").trim();
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`replan: ${ref} not in queue`);
  if (entry.runId === undefined) throw new Error(`replan: ${ref} has no runId`);
  const runDir = join(deps.runsDir, entry.runId);
  if (!runObservers.has(entry.runId)) runObservers.set(entry.runId, new Observer(runDir, entry.runId));
  await writeSteerDecision(
    runDir,
    { action: "replan", ...(notesRaw.length === 0 ? {} : { notes: notesRaw }) },
    "command",
  );
  await attachRunWorkflow(deps, await deps.engine.getRun(entry.runId));
  const state = await deps.engine.resumeRun(entry.runId, { decision: { action: "replan", ...(notesRaw.length === 0 ? {} : { notes: notesRaw }) } });
  const latest = await readQueue(deps.runsDir);
  const live = findQueueEntry(latest, ref);
  if (live !== undefined) {
    live.state = queueStateFor(state.status, state.pauseForUser, state.escalation?.code);
    live.runId = state.runId;
    live.updatedAt = new Date().toISOString();
    await writeQueue(deps.runsDir, latest);
  }
  return state;
}
