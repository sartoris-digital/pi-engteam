import type { FactoryDeps } from "../controller/lane-runner.js";
import { runTicket } from "../controller/lane-runner.js";
import type { RunState } from "../engine/types.js";
import { queueStateFor, readQueue, writeQueue } from "../scheduler/queue.js";
import type { TicketRef } from "../trackers/adapter.js";
import type { ParsedFactoryArgs } from "./router.js";

export { queueStateFor } from "../scheduler/queue.js";

export async function runStart(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RunState[]> {
  const repoFilter = typeof parsed.flags.repo === "string" ? parsed.flags.repo : undefined;
  const started: RunState[] = [];
  for (;;) {
    const queue = await readQueue(deps.runsDir);
    const entry = queue.entries.find(
      (e) =>
        (e.state === "queued" || e.state === "ready") && (repoFilter === undefined || e.repo === repoFilter),
    );
    if (entry === undefined) break;

    entry.state = "running";
    entry.updatedAt = new Date().toISOString();
    await writeQueue(deps.runsDir, queue);

    const ref: TicketRef = { tracker: entry.tracker, id: entry.ref };
    try {
      await deps.tracker.setStatus(ref, "running").catch(() => undefined);
      const ticket = await deps.tracker.fetch(ref);
      const state = await runTicket(ticket, entry.repo, deps, entry.lane === undefined ? undefined : { lane: entry.lane });
      entry.state = queueStateFor(state.status, state.pauseForUser, state.escalation?.code);
      entry.runId = state.runId;
      entry.updatedAt = new Date().toISOString();
      if (entry.state === "awaiting-steer") entry.waitingOn = "steer";
      if (entry.state === "blocked" && (state.pauseForUser?.reason === "approval-needed" || state.escalation?.code === "approval-needed")) {
        entry.waitingOn = "approval";
      }
      if (state.status === "succeeded") await deps.tracker.setStatus(ref, "done").catch(() => undefined);
      if (state.status === "failed" || state.status === "cancelled") {
        await deps.tracker.setStatus(ref, "failed").catch(() => undefined);
      }
      started.push(state);
      if (entry.state === "awaiting-steer") break;
    } catch (err) {
      entry.state = "blocked";
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.updatedAt = new Date().toISOString();
      throw err;
    } finally {
      await writeQueue(deps.runsDir, queue);
    }
  }
  return started;
}
