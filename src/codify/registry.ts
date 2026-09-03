import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodifyConfig } from "../config/schema.js";
import { eventNameForState } from "./events.js";
import { appendCodifiedLedger } from "./ledger.js";

export type RegistryState =
  | "staged"
  | "probationary"
  | "active"
  | "assist"
  | "demoted"
  | "retired"
  | "rejected"
  | "drifted";

export type ToolClass = "stage-tool" | "task-tool" | "verifier-script" | "rule-predicate";
export type TransitionBy = "nonce" | "shadow" | "system" | "safety";
export type PromoteReason = "unbound-secrets" | "not-landed" | "human-modified" | "no-ui";
export type HitKind =
  | "exact"
  | "partial"
  | "shadow-agree"
  | "shadow-disagree"
  | "shadow-disagree-scope"
  | "precondition"
  | "fail";
export type RecentHit = "ok" | "fail" | "precondition" | "shadow-agree" | "shadow-disagree";

export interface RegistryHistoryEntry {
  at: string;
  from: RegistryState;
  to: RegistryState;
  by: TransitionBy;
  reason: string;
}

export interface RegistryStats {
  exact: number;
  partial: number;
  shadowAgree: number;
  shadowDisagree: number;
  preconditionRefusals: number;
  failures: number;
  recentHits: RecentHit[];
  savedUsd: number;
  savedWallSeconds: number;
  lastHitAt?: string;
}

export interface RegistryEntry {
  name: string;
  version: number;
  class: ToolClass;
  scope: "repo" | "global";
  repo?: string;
  state: RegistryState;
  toolSha256: string;
  manifestSha256: string;
  skillSha256: string;
  judgedSha?: string;
  validation: { baseSha: string; uvVersion?: string; formatterVersion?: string };
  approver?: { user: string; nonceAt: string };
  secretsBound: boolean;
  landedAs?: "clean" | "human-modified" | "partial" | "closed";
  matcher: { titlePatterns: string[]; planStepPatterns: string[]; pathGlobs: string[] };
  writeGlobs: string[];
  readGlobs: string[];
  fixtureIds?: string[];
  residuals?: string[];
  supervisedSuccesses?: number;
  executingSha256?: string;
  skillMarkdown?: string;
  signature?: string;
  stats: RegistryStats;
  history: RegistryHistoryEntry[];
}

export interface Registry {
  entries: Record<string, RegistryEntry>;
  rejected: Record<string, { residuals: string[]; until: string }>;
}

export const REGISTRY_STATES: readonly RegistryState[] = [
  "staged",
  "probationary",
  "active",
  "assist",
  "demoted",
  "retired",
  "rejected",
  "drifted",
];

/** Frozen v1.5 graph. Safety `any → retired` is handled in `transition`, not listed here. */
export const LEGAL_TRANSITIONS: ReadonlyArray<readonly [RegistryState, RegistryState]> = [
  ["staged", "probationary"],
  ["staged", "rejected"],
  ["probationary", "active"],
  ["probationary", "assist"],
  ["probationary", "demoted"],
  ["probationary", "retired"],
  ["probationary", "drifted"],
  ["active", "demoted"],
  ["active", "drifted"],
  ["active", "retired"],
  ["demoted", "retired"],
  ["demoted", "probationary"],
  ["drifted", "probationary"],
  ["drifted", "retired"],
  ["assist", "retired"],
];

const LEGAL = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}→${to}`));

const RECENT_CAP = 10;

export class IllegalTransitionError extends Error {
  readonly from: RegistryState;
  readonly to: RegistryState;
  constructor(from: RegistryState, to: RegistryState) {
    super(`illegal registry transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function emptyRegistry(): Registry {
  return { entries: {}, rejected: {} };
}

export function registryPath(home: string): string {
  return join(home, "codified", "registry.json");
}

export async function loadRegistry(home: string): Promise<Registry> {
  try {
    const raw = JSON.parse(await readFile(registryPath(home), "utf8")) as Registry;
    return {
      entries: raw.entries ?? {},
      rejected: raw.rejected ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw err;
  }
}

export async function saveRegistry(home: string, reg: Registry): Promise<void> {
  const path = registryPath(home);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

function cloneRegistry(reg: Registry): Registry {
  return structuredClone(reg);
}

function cloneEntry(entry: RegistryEntry): RegistryEntry {
  return structuredClone(entry);
}

function isLegal(from: RegistryState, to: RegistryState, by: TransitionBy): boolean {
  if (by === "safety" && to === "retired") return true;
  return LEGAL.has(`${from}→${to}`);
}

export function transition(
  reg: Registry,
  name: string,
  to: RegistryState,
  by: TransitionBy,
  reason: string,
  now: Date = new Date(),
): Registry {
  const current = reg.entries[name];
  if (current === undefined) throw new Error(`registry: unknown entry ${JSON.stringify(name)}`);
  const from = current.state;
  if (from === to) return cloneRegistry(reg);
  if (!isLegal(from, to, by)) throw new IllegalTransitionError(from, to);
  const next = cloneRegistry(reg);
  const entry = next.entries[name];
  if (entry === undefined) throw new Error(`registry: unknown entry ${JSON.stringify(name)}`);
  entry.state = to;
  entry.history = [
    ...entry.history,
    { at: now.toISOString(), from, to, by, reason },
  ];
  if (to === "rejected" && entry.signature) {
    next.rejected[entry.signature] = { residuals: entry.residuals ?? [], until: "" };
  }
  return next;
}

export async function applyTransition(
  home: string,
  name: string,
  to: RegistryState,
  by: TransitionBy,
  reason: string,
  now: Date = new Date(),
): Promise<{ registry: Registry; event: string }> {
  const current = await loadRegistry(home);
  const registry = transition(current, name, to, by, reason, now);
  await saveRegistry(home, registry);
  const entry = registry.entries[name];
  if (entry === undefined) throw new Error(`registry: unknown entry ${JSON.stringify(name)}`);
  const event = eventNameForState(to);
  const from = entry.history.at(-1)?.from;
  await appendCodifiedLedger(home, {
    at: now.toISOString(),
    name,
    version: entry.version,
    from,
    to,
    by,
    reason,
    event: by === "safety" ? "factory.codified.blocked" : event,
  });
  return { registry, event };
}

export function canPromote(
  entry: RegistryEntry,
  ctx: { hasUI: boolean } = { hasUI: false },
): { ok: true } | { ok: false; reason: PromoteReason } {
  if (!entry.secretsBound) return { ok: false, reason: "unbound-secrets" };
  if (entry.landedAs === "human-modified") return { ok: false, reason: "human-modified" };
  if (entry.landedAs !== "clean") return { ok: false, reason: "not-landed" };
  if (!ctx.hasUI) return { ok: false, reason: "no-ui" };
  return { ok: true };
}

function pushRecent(hits: RecentHit[], hit: RecentHit): RecentHit[] {
  const next = [...hits, hit];
  return next.length > RECENT_CAP ? next.slice(next.length - RECENT_CAP) : next;
}

export function recordHit(entry: RegistryEntry, hit: { kind: HitKind }, now: Date = new Date()): RegistryEntry {
  const next = cloneEntry(entry);
  const stats = next.stats;
  stats.lastHitAt = now.toISOString();
  switch (hit.kind) {
    case "exact":
      stats.exact += 1;
      stats.recentHits = pushRecent(stats.recentHits, "ok");
      break;
    case "partial":
      stats.partial += 1;
      stats.recentHits = pushRecent(stats.recentHits, "ok");
      break;
    case "shadow-agree":
      stats.shadowAgree += 1;
      stats.recentHits = pushRecent(stats.recentHits, "shadow-agree");
      break;
    case "shadow-disagree":
    case "shadow-disagree-scope":
      stats.shadowDisagree += 1;
      stats.recentHits = pushRecent(stats.recentHits, "shadow-disagree");
      break;
    case "precondition":
      stats.preconditionRefusals += 1;
      stats.recentHits = pushRecent(stats.recentHits, "precondition");
      break;
    case "fail":
      stats.failures += 1;
      stats.recentHits = pushRecent(stats.recentHits, "fail");
      break;
  }
  return next;
}

function applyState(
  entry: RegistryEntry,
  to: RegistryState,
  by: TransitionBy,
  reason: string,
  now: Date,
): RegistryEntry {
  if (entry.state === to) return entry;
  const next = cloneEntry(entry);
  const from = next.state;
  if (!isLegal(from, to, by)) throw new IllegalTransitionError(from, to);
  next.state = to;
  next.history = [...next.history, { at: now.toISOString(), from, to, by, reason }];
  return next;
}

function trailingFails(hits: RecentHit[]): number {
  let n = 0;
  for (let i = hits.length - 1; i >= 0; i--) {
    if (hits[i] !== "fail") break;
    n += 1;
  }
  return n;
}

export function maybeDemote(
  entry: RegistryEntry,
  cfg: CodifyConfig,
  opts: { safety?: boolean; now?: Date } = {},
): RegistryEntry {
  const now = opts.now ?? new Date();
  if (opts.safety) return applyState(entry, "retired", "safety", "codified-safety", now);
  const hits = entry.stats.recentHits;
  const consecutive = trailingFails(hits) >= 2;
  const failCount = hits.filter((h) => h === "fail").length;
  const threshold = cfg.demoteAfterFailures;
  if (entry.state === "demoted" && (trailingFails(hits) >= 3 || failCount > threshold)) {
    return applyState(entry, "retired", "system", "one more failure after demotion", now);
  }
  if (entry.state === "active" && (consecutive || failCount >= threshold)) {
    return applyState(entry, "demoted", "system", consecutive ? "two consecutive failures" : "demoteAfterFailures", now);
  }
  return entry;
}

export function maybeActivate(entry: RegistryEntry, cfg: CodifyConfig, now: Date = new Date()): RegistryEntry {
  if (entry.state !== "probationary") return entry;
  if (entry.stats.shadowAgree < cfg.shadowAgreeToActivate || entry.stats.shadowDisagree !== 0) return entry;
  if (entry.class === "task-tool") {
    if ((entry.supervisedSuccesses ?? 0) < 2 || !entry.secretsBound) return entry;
  }
  return applyState(entry, "active", "shadow", "shadowAgree", now);
}

function reliability(entry: RegistryEntry): number {
  const hits = entry.stats.recentHits;
  if (hits.length === 0) return 0;
  const ok = hits.filter((h) => h === "ok" || h === "shadow-agree").length;
  return ok / hits.length;
}

function usage(entry: RegistryEntry, maxExact: number): number {
  if (maxExact <= 0) return 0;
  return Math.min(1, entry.stats.exact / maxExact);
}

function recency(entry: RegistryEntry, now: Date, staleDays: number): number {
  if (!entry.stats.lastHitAt) return 0;
  const ageMs = now.getTime() - Date.parse(entry.stats.lastHitAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  const days = ageMs / 86_400_000;
  return Math.max(0, 1 - days / Math.max(1, staleDays));
}

export function utilityScore(entry: RegistryEntry, now: Date, cfg: CodifyConfig, maxExact: number): number {
  return 0.5 * reliability(entry) + 0.3 * usage(entry, maxExact) + 0.2 * recency(entry, now, cfg.staleDays);
}

function fixtureOverlap(entry: RegistryEntry, others: RegistryEntry[]): number {
  const mine = new Set(entry.fixtureIds ?? []);
  if (mine.size === 0) return 0;
  const theirs = new Set(others.flatMap((e) => e.fixtureIds ?? []));
  let n = 0;
  for (const id of mine) if (theirs.has(id)) n += 1;
  return n;
}

function activeEntries(reg: Registry): RegistryEntry[] {
  return Object.values(reg.entries).filter((e) => e.state === "active");
}

function pickEviction(candidates: RegistryEntry[], allActive: RegistryEntry[], cfg: CodifyConfig, now: Date): RegistryEntry {
  const maxExact = Math.max(1, ...allActive.map((e) => e.stats.exact));
  let best: RegistryEntry | undefined;
  let bestOverlap = -1;
  let bestUtility = Infinity;
  for (const c of candidates) {
    const overlap = fixtureOverlap(c, allActive.filter((e) => e.name !== c.name));
    const util = utilityScore(c, now, cfg, maxExact);
    if (overlap > bestOverlap || (overlap === bestOverlap && util < bestUtility)) {
      best = c;
      bestOverlap = overlap;
      bestUtility = util;
    }
  }
  if (best === undefined) throw new Error("evictIfNeeded: empty candidate set");
  return best;
}

export function evictIfNeeded(reg: Registry, cfg: CodifyConfig, now: Date = new Date()): Registry {
  let next = cloneRegistry(reg);
  for (;;) {
    const active = activeEntries(next);
    const overGlobal = active.length > cfg.maxActiveGlobal;
    const perRepo = new Map<string, RegistryEntry[]>();
    for (const e of active) {
      const key = e.scope === "global" ? "*global*" : (e.repo ?? "");
      const list = perRepo.get(key) ?? [];
      list.push(e);
      perRepo.set(key, list);
    }
    let overRepo: RegistryEntry[] | undefined;
    for (const list of perRepo.values()) {
      if (list.length > cfg.maxActivePerRepo) {
        overRepo = list;
        break;
      }
    }
    if (!overGlobal && overRepo === undefined) return next;
    const pool = overRepo ?? active;
    const victim = pickEviction(pool, active, cfg, now);
    next = transition(next, victim.name, "retired", "system", "evicted: over cap", now);
  }
}

export function markStale(reg: Registry, cfg: CodifyConfig, now: Date = new Date()): Registry {
  let next = cloneRegistry(reg);
  const cutoff = now.getTime() - cfg.staleDays * 86_400_000;
  for (const entry of Object.values(next.entries)) {
    if (entry.state !== "active" && entry.state !== "probationary" && entry.state !== "assist") continue;
    const hit = entry.stats.lastHitAt ? Date.parse(entry.stats.lastHitAt) : Number.NaN;
    if (!Number.isFinite(hit) || hit > cutoff) continue;
    next = transition(next, entry.name, "retired", "system", "stale", now);
  }
  return next;
}
