import type { FactoryDeps } from "../controller/lane-runner.js";
import { readQueue } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export async function runStatus(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<string> {
  const queue = await readQueue(deps.runsDir);
  if (parsed.flags.json === true) return `${JSON.stringify(queue, null, 2)}\n`;

  const ref = parsed.args[0];
  if (ref !== undefined) {
    const entry = queue.entries.find((e) => e.ref === ref || e.runId === ref);
    if (entry === undefined) return `${ref}: not in queue`;
    const lines = [
      `ref: ${entry.ref}`,
      `state: ${entry.state}`,
      `runId: ${entry.runId ?? "-"}`,
      `lane: ${entry.lane ?? entry.kind}`,
    ];
    if (entry.runId !== undefined) {
      try {
        const state = await deps.engine.getRun(entry.runId);
        lines.push(`currentStep: ${state.currentStep}`);
      } catch {
        /* run dir may not exist yet */
      }
    }
    return lines.join("\n");
  }

  if (queue.entries.length === 0) return "queue is empty";
  return queue.entries
    .map((e) => `${e.ref}\t${e.state}\t${e.lane ?? e.kind}\t${e.runId ?? "-"}`)
    .join("\n");
}
