import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FactoryDeps } from "../controller/lane-runner.js";
import type { Ticket, TicketKind } from "../trackers/adapter.js";
import { isTicketKind, refToString } from "../trackers/adapter.js";
import type { ParsedFactoryArgs } from "./router.js";

export const QUEUE_STATES = [
  "queued",
  "running",
  "waiting_user",
  "published",
  "failed",
  "cancelled",
  "landed",
  "closed",
  "needs-rebase",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];
export type LandedAs = "clean" | "human-modified" | "partial";

export interface QueueWorkspace {
  provider: "git" | "herdr";
  path: string;
  workspaceId?: string;
  branch: string;
  lane: string;
}

export interface QueueEntry {
  key: string;
  tracker: string;
  repo: string;
  ref: string;
  priority: "p0" | "p1" | "p2" | "p3";
  state: QueueState;
  kind: TicketKind;
  lane?: string;
  runId?: string;
  enqueuedAt: string;
  updatedAt: string;
  prUrl?: string;
  prNumber?: number;
  judgedSha?: string;
  hostCommits?: string[];
  patchIds?: string[];
  baseSha?: string;
  writebacks?: Record<string, string>;
  workspace?: QueueWorkspace;
  changedFiles?: string[];
  landedAs?: LandedAs;
  landedSha?: string;
  landedBy?: "git" | "operator";
  lastReconciledSha?: string;
}

export interface QueueFile {
  schemaVersion: 1;
  entries: QueueEntry[];
}

export function queuePath(runsDir: string): string {
  return join(runsDir, "_factory", "queue.json");
}

export function queueKey(tracker: string, repo: string, ref: string): string {
  return `${tracker}:${repo}:${ref}`;
}

export async function readQueue(runsDir: string): Promise<QueueFile> {
  try {
    const raw = JSON.parse(await readFile(queuePath(runsDir), "utf8")) as QueueFile;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
      return { schemaVersion: 1, entries: [] };
    }
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: [] };
    throw err;
  }
}

export async function writeQueue(runsDir: string, queue: QueueFile): Promise<void> {
  const path = queuePath(runsDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(queue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

const TERMINAL: ReadonlySet<QueueState> = new Set(["published", "failed", "cancelled"]);

export async function runEnqueue(
  parsed: ParsedFactoryArgs,
  deps: FactoryDeps,
): Promise<{ ticket: Ticket; entry: QueueEntry }> {
  const repoFlag = flagString(parsed.flags, "repo");
  let repo = repoFlag;
  if (repo === undefined) {
    if (deps.repos.length > 1) throw new Error("enqueue: --repo is required when multiple repos are registered");
    repo = deps.repos[0] ?? deps.projectRootDefault;
  }
  const kindFlag = flagString(parsed.flags, "kind");
  const kind: TicketKind = isTicketKind(kindFlag) ? kindFlag : "chore";
  const lane = flagString(parsed.flags, "lane");
  const now = new Date().toISOString();

  let ticket: Ticket;
  const refArg = parsed.args[0];
  if (typeof parsed.flags.task === "string") {
    ticket = await deps.tracker.createFromTask(parsed.flags.task, { kind });
  } else if (refArg !== undefined) {
    const parsedRef = deps.tracker.parseRef(refArg) ?? { tracker: "local", id: refArg };
    ticket = await deps.tracker.fetch(parsedRef);
  } else {
    throw new Error("enqueue: --task is required (or pass an existing local ref)");
  }

  const ref = ticket.ref.tracker === "local" ? ticket.ref.id : refToString(ticket.ref);
  const key = queueKey(ticket.ref.tracker, repo, ref);
  const queue = await readQueue(deps.runsDir);
  const existing = queue.entries.find((e) => e.key === key && !TERMINAL.has(e.state));
  if (existing !== undefined) {
    existing.updatedAt = now;
    existing.priority = "p2";
    await writeQueue(deps.runsDir, queue);
    return { ticket, entry: existing };
  }

  const entry: QueueEntry = {
    key,
    tracker: ticket.ref.tracker,
    repo,
    ref,
    priority: "p2",
    state: "queued",
    kind: ticket.kind ?? kind,
    ...(lane === undefined ? {} : { lane }),
    enqueuedAt: now,
    updatedAt: now,
  };
  queue.entries.push(entry);
  await writeQueue(deps.runsDir, queue);
  return { ticket, entry };
}
