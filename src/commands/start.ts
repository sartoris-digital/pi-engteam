import type { FactoryDeps } from "../controller/lane-runner.js";
import { runTicket } from "../controller/lane-runner.js";
import type { RunState, RunStatus } from "../engine/types.js";
import type { TicketRef } from "../trackers/adapter.js";
import { readQueue, writeQueue, type QueueState } from "./enqueue.js";
import type { ParsedFactoryArgs } from "./router.js";

export function queueStateFor(status: RunStatus): QueueState {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "waiting_user":
    case "paused":
      return "waiting_user";
    case "succeeded":
      return "published";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export async function runStart(parsed: ParsedFactoryArgs, deps: FactoryDeps): Promise<RunState[]> {
  const repoFilter = typeof parsed.flags.repo === "string" ? parsed.flags.repo : undefined;
  const started: RunState[] = [];
  for (;;) {
    const queue = await readQueue(deps.runsDir);
    const entry = queue.entries.find(
      (e) => e.state === "queued" && (repoFilter === undefined || e.repo === repoFilter),
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
      entry.state = queueStateFor(state.status);
      entry.runId = state.runId;
      entry.updatedAt = new Date().toISOString();
      if (state.status === "succeeded") await deps.tracker.setStatus(ref, "done").catch(() => undefined);
      if (state.status === "failed" || state.status === "cancelled") {
        await deps.tracker.setStatus(ref, "failed").catch(() => undefined);
      }
      started.push(state);
      if (entry.state === "waiting_user") break;
    } catch (err) {
      entry.state = "failed";
      entry.updatedAt = new Date().toISOString();
      throw err;
    } finally {
      await writeQueue(deps.runsDir, queue);
    }
  }
  return started;
}
