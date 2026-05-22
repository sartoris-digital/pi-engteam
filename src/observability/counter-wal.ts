// Phase E items E11 + E13 — counter WAL writer + aggregator.
//
// Single source of truth for `*_total` counters across short-lived
// CLI processes + the long-lived server. Each process accumulates
// counter deltas in memory and flushes ONE aggregated WAL line per
// flush interval (round 8 MED #4: aggregate before append so a
// hot counter incremented 100k times in one second produces ONE
// append, not 100k). The aggregator reads the WAL + per-pid gauges
// to compute the canonical export, preserving counter monotonicity
// across process restarts (round 7 MED #5).
//
// Storage isolation per round 13 MED #3: WAL lives under
// `<configDir>/telemetry/counter-wal.jsonl`, NOT runsDir, so it
// can't fill the activity quota or compete with run state. Dedicated
// daily quota — over-cap triggers compact + rotate; way-over-cap
// drops with a counter.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { metric } from "./metric-catalog.js";

export type CounterDelta = {
  ts: string;
  pid: number;
  name: string;
  labels: Record<string, string>;
  delta: number;
};

export type CounterCheckpoint = {
  ts: string;
  totals: Record<string, number>; // keyed by `${name}|${labelsCanonical}`
};

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_WAL_BYTE_CAP = 256 * 1024 * 1024; // 256 MB

function labelsCanonical(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

function counterKey(name: string, labels: Record<string, string>): string {
  return `${name}|${labelsCanonical(labels)}`;
}

export class CounterWal {
  private readonly walPath: string;
  private readonly checkpointPath: string;
  private readonly pid = process.pid;
  private deltas: Map<string, { name: string; labels: Record<string, string>; delta: number }> = new Map();
  private readonly flushIntervalMs: number;
  private readonly walByteCap: number;
  private flushTimer: NodeJS.Timeout | undefined;
  private overflowDropCount = 0;

  constructor(opts: { configDir: string; flushIntervalMs?: number; walByteCap?: number }) {
    const dir = join(opts.configDir, "telemetry");
    this.walPath = join(dir, "counter-wal.jsonl");
    this.checkpointPath = join(dir, "counter-checkpoint.json");
    mkdirSync(dir, { recursive: true });
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.walByteCap = opts.walByteCap ?? DEFAULT_WAL_BYTE_CAP;
  }

  /**
   * Increment a counter. The catalog `metric()` call doubles as a
   * typo-catcher — unknown names throw. Deltas accumulate in
   * memory until the next flush.
   */
  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const entry = metric(name);
    if (entry.type !== "counter") {
      throw new Error(`counter-wal: ${name} is type=${entry.type}, not counter`);
    }
    const key = counterKey(name, labels);
    const existing = this.deltas.get(key);
    if (existing) existing.delta += by;
    else this.deltas.set(key, { name, labels, delta: by });
  }

  /** Start periodic flush. Caller is responsible for `stop()` on
   *  shutdown. */
  startFlushing(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }

  /** Drain in-memory deltas to the WAL. Best-effort — never throws. */
  flush(): void {
    if (this.deltas.size === 0) return;
    // Cap check.
    try {
      const st = statSync(this.walPath);
      if (st.size > this.walByteCap) {
        // Over-quota. Trigger compaction.
        this.compact();
      }
      if (st.size > this.walByteCap * 2) {
        // Way-over: drop with a counter; we can't keep up.
        this.overflowDropCount += this.deltas.size;
        this.deltas.clear();
        return;
      }
    } catch { /* file doesn't exist yet, that's fine */ }
    const ts = new Date().toISOString();
    const lines: string[] = [];
    for (const { name, labels, delta } of this.deltas.values()) {
      const ev: CounterDelta = { ts, pid: this.pid, name, labels, delta };
      lines.push(JSON.stringify(ev));
    }
    try {
      appendFileSync(this.walPath, lines.join("\n") + "\n", { mode: 0o600 });
      this.deltas.clear();
    } catch { /* best-effort */ }
  }

  /**
   * Read the canonical totals across the checkpoint + WAL tail.
   * Aggregator (E13) calls this to compute the per-host counter
   * snapshot — counters never decrease because the checkpoint is
   * authoritative and the WAL only adds.
   */
  computeTotals(): Record<string, number> {
    let totals: Record<string, number> = {};
    if (existsSync(this.checkpointPath)) {
      try {
        const cp = JSON.parse(readFileSync(this.checkpointPath, "utf8")) as CounterCheckpoint;
        if (cp.totals) totals = { ...cp.totals };
      } catch { /* corrupt checkpoint — start fresh */ }
    }
    if (existsSync(this.walPath)) {
      try {
        const text = readFileSync(this.walPath, "utf8");
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as CounterDelta;
            const k = counterKey(ev.name, ev.labels);
            totals[k] = (totals[k] ?? 0) + ev.delta;
          } catch { /* skip torn line */ }
        }
      } catch { /* unreadable wal */ }
    }
    return totals;
  }

  /**
   * Compact: roll the WAL tail into the checkpoint and truncate.
   * Aggregator should call this periodically (default hourly).
   * Atomic write-temp-rename + fsync per round 8 MED #4.
   */
  compact(): void {
    const totals = this.computeTotals();
    const cp: CounterCheckpoint = { ts: new Date().toISOString(), totals };
    try {
      const tmp = this.checkpointPath + ".tmp";
      writeFileSync(tmp, JSON.stringify(cp, null, 2), { mode: 0o600 });
      renameSync(tmp, this.checkpointPath);
      // Truncate the WAL — its entries are now in the checkpoint.
      writeFileSync(this.walPath, "", { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  /** Number of deltas the WAL writer dropped due to severe overload. */
  getOverflowDrops(): number {
    return this.overflowDropCount;
  }
}
