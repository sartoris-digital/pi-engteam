// Phase E item E10 — active-run-aware activity pruner.
//
// Walks `<runsDir>/_activity/<runId>/` and applies the retention
// policy from PLAN item E10:
//   - active runs: NEVER pruned outright. Under quota pressure
//     they degrade to `essential-only` (set in their queue's
//     auto-disable; this module doesn't touch their files).
//   - recently-failed runs within `incidentPinTtlMs`: pinned.
//   - operator-pinned runs (in `<runsDir>/_activity/.pinned.json`):
//     pinned.
//   - terminal, non-pinned, age-past-retention runs: pruned
//     oldest-first.
// Each prune emits a tombstone at
// `<runsDir>/_activity/.tombstones/<runId>.json` so replay
// (Phase B item 17) returns "pruned, see tombstone" instead of
// a silent missing-file.
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

export type PruneInput = {
  runsDir: string;
  activeRunIds: ReadonlySet<string>;
  // Per-run state lookup — returns terminal status + endTs if
  // known. Pruner uses `endTs` to compute age, and `status` to
  // decide whether incident pinning applies.
  lookupRunState?: (runId: string) => { status: "succeeded" | "failed" | "halted" | "active"; endTs?: string } | undefined;
  // Retention knobs from PLAN.
  retentionMs?: number;
  incidentPinTtlMs?: number;
  // Global quota — if usage exceeds this we prune oldest first
  // regardless of age (after honoring pins).
  globalQuotaBytes?: number;
};

export type PruneResult = {
  inspected: number;
  pinnedActive: number;
  pinnedIncident: number;
  pinnedOperator: number;
  prunedRunIds: string[];
  bytesReclaimed: number;
};

const DEFAULTS = {
  retentionMs: 14 * 24 * 60 * 60 * 1000, // 14 days
  incidentPinTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days for failed runs
  globalQuotaBytes: 4 * 1024 * 1024 * 1024, // 4 GB
};

type Entry = {
  runId: string;
  dir: string;
  bytes: number;
  mirrorBytes: number; // <runsDir>/<runId>/agent-activity.jsonl (E12 legacy mirror)
  ageMs: number;
  status?: "succeeded" | "failed" | "halted" | "active";
  endTs?: string;
};

function dirSize(path: string): number {
  let total = 0;
  try {
    for (const f of readdirSync(path)) {
      try {
        const p = join(path, f);
        const st = statSync(p);
        if (st.isFile()) total += st.size;
        else if (st.isDirectory()) total += dirSize(p);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function readPinSet(activityRoot: string): Set<string> {
  const path = join(activityRoot, ".pinned.json");
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed?.runIds)) return new Set(parsed.runIds);
  } catch { /* corrupt — ignore */ }
  return new Set();
}

function writeTombstone(activityRoot: string, runId: string, entry: Entry): void {
  const dir = join(activityRoot, ".tombstones");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  const tmp = path + ".tmp";
  const tombstone = {
    runId,
    prunedAt: new Date().toISOString(),
    reason: "retention-or-quota",
    bytes: entry.bytes,
    ageMs: entry.ageMs,
    status: entry.status ?? "unknown",
  };
  writeFileSync(tmp, JSON.stringify(tombstone, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function prune(input: PruneInput): PruneResult {
  const opts = {
    retentionMs: input.retentionMs ?? DEFAULTS.retentionMs,
    incidentPinTtlMs: input.incidentPinTtlMs ?? DEFAULTS.incidentPinTtlMs,
    globalQuotaBytes: input.globalQuotaBytes ?? DEFAULTS.globalQuotaBytes,
  };
  const activityRoot = join(input.runsDir, "_activity");
  if (!existsSync(activityRoot)) {
    return { inspected: 0, pinnedActive: 0, pinnedIncident: 0, pinnedOperator: 0, prunedRunIds: [], bytesReclaimed: 0 };
  }
  const pinned = readPinSet(activityRoot);
  const now = Date.now();
  const entries: Entry[] = [];
  for (const f of readdirSync(activityRoot)) {
    if (f.startsWith(".")) continue; // .pinned.json, .tombstones
    const dir = join(activityRoot, f);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      const state = input.lookupRunState?.(f);
      const endTs = state?.endTs;
      const ageMs = endTs ? now - new Date(endTs).getTime() : now - st.mtimeMs;
      // E12: also account for legacy-mirror bytes at <runsDir>/<runId>/agent-activity.jsonl
      let mirrorBytes = 0;
      try {
        const mst = statSync(join(input.runsDir, f, "agent-activity.jsonl"));
        if (mst.isFile()) mirrorBytes = mst.size;
      } catch { /* no mirror */ }
      entries.push({
        runId: f,
        dir,
        bytes: dirSize(dir),
        mirrorBytes,
        ageMs,
        status: state?.status,
        endTs,
      });
    } catch { /* skip */ }
  }
  let pinnedActive = 0;
  let pinnedIncident = 0;
  let pinnedOperator = 0;
  const toPrune: Entry[] = [];
  for (const e of entries) {
    if (input.activeRunIds.has(e.runId) || e.status === "active") {
      pinnedActive++;
      continue;
    }
    if (e.status === "failed" && e.ageMs < opts.incidentPinTtlMs) {
      pinnedIncident++;
      continue;
    }
    if (pinned.has(e.runId)) {
      pinnedOperator++;
      continue;
    }
    if (e.ageMs > opts.retentionMs) {
      toPrune.push(e);
    }
  }
  // Quota-driven prune: if disk usage still exceeds quota, drop
  // oldest non-pinned terminal runs even if they're under TTL.
  // E12: mirror bytes count toward the global quota.
  const totalBytes = entries.reduce((s, e) => s + e.bytes + e.mirrorBytes, 0);
  if (totalBytes > opts.globalQuotaBytes) {
    const candidates = entries
      .filter((e) => !input.activeRunIds.has(e.runId) && e.status !== "active" && !pinned.has(e.runId))
      .filter((e) => !(e.status === "failed" && e.ageMs < opts.incidentPinTtlMs))
      .filter((e) => !toPrune.includes(e))
      .sort((a, b) => b.ageMs - a.ageMs); // oldest first
    let projected = totalBytes;
    for (const cand of candidates) {
      if (projected <= opts.globalQuotaBytes) break;
      toPrune.push(cand);
      projected -= cand.bytes + cand.mirrorBytes;
    }
  }
  // Execute prune.
  let reclaimed = 0;
  const pruned: string[] = [];
  for (const e of toPrune) {
    try {
      writeTombstone(activityRoot, e.runId, e);
      rmSync(e.dir, { recursive: true, force: true });
      // E12: also remove legacy mirror file when present.
      try { unlinkSync(join(input.runsDir, e.runId, "agent-activity.jsonl")); } catch { /* no mirror */ }
      reclaimed += e.bytes + e.mirrorBytes;
      pruned.push(e.runId);
    } catch { /* best-effort */ }
  }
  return {
    inspected: entries.length,
    pinnedActive,
    pinnedIncident,
    pinnedOperator,
    prunedRunIds: pruned,
    bytesReclaimed: reclaimed,
  };
}

/** Operator-pin a run for `ttlMs` (default 7d) — write into `.pinned.json`. */
export function pinRun(runsDir: string, runId: string): void {
  const activityRoot = join(runsDir, "_activity");
  mkdirSync(activityRoot, { recursive: true });
  const path = join(activityRoot, ".pinned.json");
  const set = readPinSet(activityRoot);
  set.add(runId);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ runIds: [...set] }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Operator-unpin. */
export function unpinRun(runsDir: string, runId: string): void {
  const activityRoot = join(runsDir, "_activity");
  if (!existsSync(activityRoot)) return;
  const set = readPinSet(activityRoot);
  set.delete(runId);
  const path = join(activityRoot, ".pinned.json");
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify({ runIds: [...set] }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

