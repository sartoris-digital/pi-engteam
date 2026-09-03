// src/git/sticky.ts — one living ticket comment edited per milestone (spec §6.1–6.2).
import type { QueueEntry } from "../commands/enqueue.js";
import type { CommentId, TicketRef, TrackerAdapter } from "../trackers/adapter.js";

export async function upsertStickyComment(opts: {
  adapter: TrackerAdapter;
  ref: TicketRef;
  runId: string;
  body: string;
  milestone: string;
  entry: QueueEntry;
}): Promise<CommentId | null> {
  const writebacks = (opts.entry.writebacks ??= {});
  const stickyKey = `${opts.runId}:sticky`;
  const mileKey = `${opts.runId}:${opts.milestone}`;
  const existingId = writebacks[stickyKey];

  if (writebacks[mileKey] !== undefined) {
    return existingId === undefined || existingId === "" ? null : existingId;
  }

  if (existingId === undefined) {
    const id = await opts.adapter.comment(opts.ref, opts.body, { idempotencyKey: `sticky:${opts.runId}` });
    writebacks[stickyKey] = id ?? "";
    writebacks[mileKey] = new Date().toISOString();
    return id;
  }

  if (existingId !== "" && opts.adapter.capabilities.has("editComment") && opts.adapter.editComment !== undefined) {
    await opts.adapter.editComment(opts.ref, existingId, opts.body);
  }
  writebacks[mileKey] = new Date().toISOString();
  return existingId === "" ? null : existingId;
}
