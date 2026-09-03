import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryDeps } from "../controller/lane-runner.js";
import { attachRunWorkflow } from "../controller/lane-runner.js";
import { runDirPath } from "../engine/state.js";
import type { RunState } from "../engine/types.js";
import { writeHumanInput } from "../steer/human-input.js";
import { findQueueEntry, queueStateFor, readQueue, writeQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export async function runResume(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RunState> {
  const ref = parsed.args[0];
  if (ref === undefined || ref.length === 0) throw new Error("resume: missing ref");
  const queue = await readQueue(deps.runsDir);
  const entry = findQueueEntry(queue, ref);
  if (entry === undefined) throw new Error(`resume: ${ref} not in queue`);
  if (entry.runId === undefined) throw new Error(`resume: ${ref} has no runId`);
  const runDir = runDirPath(deps.runsDir, entry.runId);
  const state = await deps.engine.getRun(entry.runId);
  const answer = flagString(parsed.flags, "answer");
  if (answer !== undefined) {
    const text = await readFile(answer, "utf8");
    let n = 1;
    try {
      n = (await readdir(join(runDir, "human-input"))).filter((f) => f.startsWith("steer-")).length + 1;
    } catch {
      n = 1;
    }
    await writeHumanInput(runDir, n, text, state.nonce);
  }
  const from = flagString(parsed.flags, "from");
  await attachRunWorkflow(deps, state);
  const resumed = await deps.engine.resumeRun(entry.runId, from === undefined ? {} : { fromStep: from });
  const latest = await readQueue(deps.runsDir);
  const live = findQueueEntry(latest, ref);
  if (live !== undefined) {
    live.state = queueStateFor(resumed.status, resumed.pauseForUser, resumed.escalation?.code);
    live.runId = resumed.runId;
    live.updatedAt = new Date().toISOString();
    await writeQueue(deps.runsDir, latest);
  }
  return resumed;
}
