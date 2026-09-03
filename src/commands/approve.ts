import { join } from "node:path";
import { Observer } from "../observer/events.js";
import { attachRunWorkflow, runObservers } from "../controller/lane-runner.js";
import type { FactoryDeps } from "../controller/lane-runner.js";
import type { RunState } from "../engine/types.js";
import { writeSteerDecision } from "../steer/stage.js";
import { readQueue, writeQueue } from "./enqueue.js";
import { queueStateFor } from "./start.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runApprove(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RunState> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("approve: missing run ref");
  const notesRaw = parsed.args.slice(1).join(" ").trim();
  const notes = notesRaw.length > 0 ? notesRaw : undefined;
  const waiveFlag = parsed.flags.waive;
  const waive = typeof waiveFlag === "string" ? [waiveFlag] : undefined;

  const queue = await readQueue(deps.runsDir);
  const entry = queue.entries.find((e) => e.ref === ref || e.runId === ref);
  if (entry === undefined) throw new Error(`approve: ${ref} not in queue`);
  if (entry.state !== "waiting_user") throw new Error(`approve: ${ref} is ${entry.state}, not waiting_user`);
  if (entry.runId === undefined) throw new Error(`approve: ${ref} has no runId`);

  const runDir = join(deps.runsDir, entry.runId);
  if (!runObservers.has(entry.runId)) {
    runObservers.set(entry.runId, new Observer(runDir, entry.runId));
  }

  await writeSteerDecision(
    runDir,
    { action: "approve", ...(notes === undefined ? {} : { notes }), ...(waive === undefined ? {} : { waive }) },
    "command",
  );
  await attachRunWorkflow(deps, await deps.engine.getRun(entry.runId));
  await deps.engine.resumeRun(entry.runId);
  const state = await deps.engine.executeRun(entry.runId);
  const obs = runObservers.get(entry.runId);
  await obs?.flush();
  if (state.status !== "waiting_user" && state.status !== "paused") {
    runObservers.delete(entry.runId);
  }

  const latest = await readQueue(deps.runsDir);
  const live = latest.entries.find((e) => e.key === entry.key);
  if (live !== undefined) {
    live.state = queueStateFor(state.status);
    live.runId = state.runId;
    live.updatedAt = new Date().toISOString();
    await writeQueue(deps.runsDir, latest);
  }
  return state;
}
