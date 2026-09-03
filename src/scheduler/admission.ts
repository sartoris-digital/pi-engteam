import { matchGlob, normalizeRelPath } from "../gate/glob.js";
import { TERMINAL_QUEUE_STATES, type QueueEntry } from "./queue.js";

export type AdmissionRefusal =
  | "max-lanes"
  | "max-lanes-per-repo"
  | "overlap"
  | "exclusive"
  | "base-red"
  | "env-setup"
  | "daily-tickets"
  | "daily-budget"
  | "dor"
  | "unauthorized"
  | "dedupe-open"
  | "dedupe-pr";

export type RunningEntry = QueueEntry & { predictedPaths?: string[] };

export interface AdmissionWorld {
  running: RunningEntry[];
  maxLanes: number;
  maxLanesPerRepo: number;
  ticketsToday: number;
  maxTicketsPerDay: number;
  spendToday: number;
  dailyBudgetUsd: number;
  exclusiveRunning: boolean;
  predictedPaths: string[];
  openPrHeads?: string[];
  baseRed?: boolean;
  envSetupTripped?: boolean;
  dorFailed?: boolean;
  unauthorized?: boolean;
  exclusive?: boolean;
}

function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (matchGlob(x, y) || matchGlob(y, x)) return true;
      const xn = normalizeRelPath(x);
      const yn = normalizeRelPath(y);
      if (xn.startsWith(`${yn}/`) || yn.startsWith(`${xn}/`)) return true;
    }
  }
  return false;
}

export function factoryBranchPrefix(tracker: string, issueId: string): string {
  return `factory/${tracker}-${issueId}-`;
}

export function admit(entry: QueueEntry, world: AdmissionWorld): { ok: true } | { ok: false; reason: AdmissionRefusal } {
  if (world.running.length >= world.maxLanes) return { ok: false, reason: "max-lanes" };
  const sameRepo = world.running.filter((r) => r.repo === entry.repo).length;
  if (sameRepo >= world.maxLanesPerRepo) return { ok: false, reason: "max-lanes-per-repo" };
  const runningPaths = world.running.flatMap((r) => r.predictedPaths ?? []);
  if (world.predictedPaths.length > 0 && runningPaths.length > 0 && pathsOverlap(world.predictedPaths, runningPaths)) {
    return { ok: false, reason: "overlap" };
  }
  if (world.exclusiveRunning || (world.exclusive === true && world.running.length > 0)) {
    return { ok: false, reason: "exclusive" };
  }
  if (world.baseRed === true) return { ok: false, reason: "base-red" };
  if (world.envSetupTripped === true) return { ok: false, reason: "env-setup" };
  if (entry.priority !== "p0" && world.ticketsToday >= world.maxTicketsPerDay) return { ok: false, reason: "daily-tickets" };
  if (world.spendToday > world.dailyBudgetUsd) return { ok: false, reason: "daily-budget" };
  if (world.dorFailed === true) return { ok: false, reason: "dor" };
  if (world.unauthorized === true) return { ok: false, reason: "unauthorized" };
  const open = [entry, ...world.running].filter((e) => !TERMINAL_QUEUE_STATES.has(e.state));
  if (open.filter((e) => e.key === entry.key).length > 1) return { ok: false, reason: "dedupe-open" };
  const heads = world.openPrHeads ?? [];
  const prefix = factoryBranchPrefix(entry.tracker, entry.ref);
  if (heads.some((h) => h.startsWith(prefix))) return { ok: false, reason: "dedupe-pr" };
  return { ok: true };
}
