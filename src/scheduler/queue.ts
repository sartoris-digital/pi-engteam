import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EscalationCode, RunStatus, StepResult } from "../engine/types.js";
import type { TicketKind } from "../trackers/adapter.js";

export const QUEUE_STATES = [
  "queued",
  "classifying",
  "needs-triage",
  "needs-info",
  "needs-decision",
  "ready",
  "waiting_lane",
  "running",
  "awaiting-steer",
  "awaiting-operator",
  "blocked",
  "published",
  "landed",
  "needs-rebase",
  "human-owned",
  "closed",
  "abandoned",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export type BriefConfidence = "HIGH" | "MEDIUM" | "LOW";
export type LandedAs = "clean" | "human-modified" | "partial";

export const TERMINAL_QUEUE_STATES: ReadonlySet<QueueState> = new Set(["landed", "closed", "abandoned"]);

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
  url?: string;
  priority: "p0" | "p1" | "p2" | "p3";
  state: QueueState;
  waitingOn?: "steer" | "operator" | "approval" | "rebase";
  runId?: string;
  workspace?: QueueWorkspace;
  kind?: TicketKind;
  tier?: "low" | "elevated";
  confidence?: BriefConfidence;
  configSha?: string;
  pushUrl?: string;
  remoteUrl?: string;
  hostCommits?: string[];
  judgedSha?: string;
  baseSha?: string;
  patchIds?: string[];
  prUrl?: string;
  prNumber?: number;
  landedAs?: LandedAs;
  landedSha?: string;
  landedBy?: "git" | "operator";
  lastReconciledSha?: string;
  claimedAt?: string;
  attempts?: number;
  rounds?: Record<string, number>;
  escalations?: Array<{ code: string; at: string; detail?: string }>;
  writebacks?: Record<string, string>;
  lastError?: string;
  lane?: string;
  enqueuedAt: string;
  updatedAt: string;
  changedFiles?: string[];
  rebaseCount?: number;
  reviseRounds?: number;
  lastReviseAt?: string;
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

export function isQueueState(value: unknown): value is QueueState {
  return typeof value === "string" && (QUEUE_STATES as readonly string[]).includes(value);
}

export function findQueueEntry(queue: QueueFile, ref: string): QueueEntry | undefined {
  return queue.entries.find((e) => e.ref === ref || e.runId === ref || e.key === ref);
}

export function queueStateFor(
  status: RunStatus,
  pause?: StepResult["pauseForUser"],
  escalation?: EscalationCode,
): QueueState {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "running";
    case "waiting_user":
      if (pause?.reason === "approval-needed" || escalation === "approval-needed") return "blocked";
      if (pause?.reason === "handoff") return "awaiting-operator";
      return "awaiting-steer";
    case "succeeded":
      return "published";
    case "failed":
      return "blocked";
    case "cancelled":
      return "closed";
  }
}

function parseEntry(raw: unknown): QueueEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.key !== "string" || typeof e.tracker !== "string" || typeof e.repo !== "string" || typeof e.ref !== "string") {
    return null;
  }
  if (!isQueueState(e.state)) return null;
  if (e.priority !== "p0" && e.priority !== "p1" && e.priority !== "p2" && e.priority !== "p3") return null;
  if (typeof e.enqueuedAt !== "string" || typeof e.updatedAt !== "string") return null;
  return raw as QueueEntry;
}

export async function readQueue(runsDir: string): Promise<QueueFile> {
  try {
    const raw = JSON.parse(await readFile(queuePath(runsDir), "utf8")) as { schemaVersion?: unknown; entries?: unknown };
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
      return { schemaVersion: 1, entries: [] };
    }
    return { schemaVersion: 1, entries: raw.entries.map(parseEntry).filter((e): e is QueueEntry => e !== null) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: [] };
    throw err;
  }
}

export async function writeQueue(runsDir: string, queue: QueueFile): Promise<void> {
  for (const entry of queue.entries) {
    if (!isQueueState(entry.state)) throw new Error(`writeQueue: unknown queue state ${JSON.stringify(entry.state)}`);
  }
  const path = queuePath(runsDir);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(queue, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);
}
