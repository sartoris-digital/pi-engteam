import type { FactoryDeps } from "../controller/lane-runner.js";
import { QUEUE_STATES, readQueue } from "./enqueue.js";
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
    if (entry.waitingOn !== undefined) lines.push(`waitingOn: ${entry.waitingOn}`);
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
  const grouped = new Map<string, typeof queue.entries>();
  for (const e of queue.entries) {
    const list = grouped.get(e.state) ?? [];
    list.push(e);
    grouped.set(e.state, list);
  }
  const lines: string[] = [];
  for (const state of QUEUE_STATES) {
    const list = grouped.get(state);
    if (list === undefined || list.length === 0) continue;
    lines.push(`${state}:`);
    for (const e of list) {
      lines.push(`  ${e.ref}\t${e.state}\t${e.lane ?? e.kind}\t${e.runId ?? "-"}`);
    }
  }
  return lines.join("\n");
}
