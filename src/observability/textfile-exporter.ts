// Phase E items E5 + E8 — Prometheus textfile-collector exporter
// with atomic write-temp-rename per scrape interval.
//
// Reads canonical totals from CounterWal + caller-provided gauges,
// renders Prometheus exposition format, writes to
// `<configDir>/telemetry/metrics.prom.<pid>` atomically. A single
// aggregator (flock-owned) merges per-pid fragments into
// `metrics.prom` that node-exporter reads.
//
// Isolated from runsDir per round 13 MED #3 + round 15 HIGH #1:
// a full or read-only runsDir cannot blind the disk-pressure
// alerts the exporter publishes.
//
// Cross-platform safe: only depends on `fs` primitives + Node's
// child_process not needed.
import { constants, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync, appendFileSync, openSync, closeSync } from "fs";
import { join } from "path";
import { METRIC_CATALOG, type MetricEntry } from "./metric-catalog.js";
import type { CounterWal } from "./counter-wal.js";

export type GaugeReader = () => Array<{ name: string; labels: Record<string, string>; value: number }>;

export type AlertThreshold = {
  name: string;
  threshold: number;
  direction: "above" | "below";
};

export type ExporterOptions = {
  configDir: string;
  wal?: CounterWal;
  // Optional caller-supplied gauges (e.g. queue depth, disk usage).
  // Called on every render so the snapshot is fresh.
  gaugeReaders?: GaugeReader[];
  // Default 60s — node-exporter typically scrapes at 60s.
  scrapeIntervalMs?: number;
  // Optional alert thresholds; breaches are appended to alerts.jsonl.
  alertThresholds?: AlertThreshold[];
};

function labelsToProm(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`);
  return `{${parts.join(",")}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function counterKeyParse(key: string): { name: string; labels: Record<string, string> } {
  const [name, labelsCanonical] = key.split("|");
  const labels: Record<string, string> = {};
  if (labelsCanonical) {
    for (const part of labelsCanonical.split(",")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return { name, labels };
}

export class TextfileExporter {
  private readonly opts: Required<Omit<ExporterOptions, "wal" | "gaugeReaders" | "alertThresholds">> & {
    wal?: CounterWal;
    gaugeReaders: GaugeReader[];
    alertThresholds: AlertThreshold[];
  };
  private readonly pid = process.pid;
  private readonly fragmentDir: string;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: ExporterOptions) {
    this.opts = {
      configDir: opts.configDir,
      wal: opts.wal,
      gaugeReaders: opts.gaugeReaders ?? [],
      scrapeIntervalMs: opts.scrapeIntervalMs ?? 60_000,
      alertThresholds: opts.alertThresholds ?? [],
    };
    this.fragmentDir = join(opts.configDir, "telemetry");
    mkdirSync(this.fragmentDir, { recursive: true });
  }

  /** Returns the emergency spool path (env-overridable). */
  private emergencySpoolPath(): string {
    return process.env["PI_ENGINEERING_EMERGENCY_SPOOL"] ?? "/var/tmp/pi-eng-emergency.jsonl";
  }

  /** Write a JSONL entry to the emergency spool and emit a stderr notice. */
  private fallbackToEmergencySpool(
    name: string,
    value: number,
    labels: Record<string, string>,
    err: unknown,
  ): void {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      kind: "alert",
      name,
      value,
      labels,
      reason: "export-write-failed",
      error: err instanceof Error ? err.message : String(err),
    });
    process.stderr.write(`[pi-eng-emergency] export write failed: ${entry}\n`);
    try {
      appendFileSync(this.emergencySpoolPath(), entry + "\n");
    } catch {
      // best-effort: if the spool itself fails there's nothing more we can do
    }
  }

  /** Render one snapshot and write atomically. */
  render(): string {
    const lines: string[] = [];
    // Emit HELP/TYPE per cataloged metric, then values.
    const emittedHelp = new Set<string>();
    const emit = (name: string, entry: MetricEntry, labels: Record<string, string>, value: number) => {
      if (!emittedHelp.has(name)) {
        lines.push(`# HELP ${name} ${entry.description.replace(/\n/g, " ")}`);
        lines.push(`# TYPE ${name} ${entry.type}`);
        emittedHelp.add(name);
      }
      lines.push(`${name}${labelsToProm(labels)} ${value}`);
    };
    // Counters from WAL.
    if (this.opts.wal) {
      const totals = this.opts.wal.computeTotals();
      for (const [k, v] of Object.entries(totals)) {
        const { name, labels } = counterKeyParse(k);
        const e = METRIC_CATALOG[name];
        if (!e || e.type !== "counter") continue;
        emit(name, e, labels, v);
      }
    }
    // Gauges from readers.
    for (const reader of this.opts.gaugeReaders) {
      let snapshot: ReturnType<GaugeReader>;
      try { snapshot = reader(); } catch { continue; }
      for (const g of snapshot) {
        const e = METRIC_CATALOG[g.name];
        if (!e || (e.type !== "gauge" && e.type !== "histogram")) continue;
        emit(g.name, e, g.labels, g.value);
      }
    }
    return lines.join("\n") + "\n";
  }

  /** Check alert thresholds and append breaches to alerts.jsonl. */
  private checkThresholds(metrics: Array<{ name: string; labels: Record<string, string>; value: number }>): void {
    if (this.opts.alertThresholds.length === 0) return;
    const alertsPath = join(this.fragmentDir, "alerts.jsonl");
    const ts = new Date().toISOString();
    for (const m of metrics) {
      for (const t of this.opts.alertThresholds) {
        if (t.name !== m.name) continue;
        const breached =
          t.direction === "above" ? m.value > t.threshold : m.value < t.threshold;
        if (!breached) continue;
        const entry = JSON.stringify({
          ts,
          name: m.name,
          value: m.value,
          labels: m.labels,
          threshold: t.threshold,
          direction: t.direction,
        });
        try {
          appendFileSync(alertsPath, entry + "\n");
        } catch {
          // best-effort
        }
      }
    }
  }

  /** Collect all current metric name/value/labels for threshold evaluation. */
  private collectMetrics(): Array<{ name: string; labels: Record<string, string>; value: number }> {
    const result: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
    if (this.opts.wal) {
      const totals = this.opts.wal.computeTotals();
      for (const [k, v] of Object.entries(totals)) {
        const { name, labels } = counterKeyParse(k);
        result.push({ name, labels, value: v });
      }
    }
    for (const reader of this.opts.gaugeReaders) {
      try {
        const snapshot = reader();
        for (const g of snapshot) result.push(g);
      } catch { /* skip */ }
    }
    return result;
  }

  /** Write one fragment atomically + emit the aggregated file. */
  writeOnce(): string {
    const text = this.render();
    const fragmentPath = join(this.fragmentDir, `metrics.prom.${this.pid}`);
    const tmp = fragmentPath + ".tmp";
    try {
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, fragmentPath);
    } catch (err) {
      // E5: fall back to emergency spool on write failure
      this.fallbackToEmergencySpool(`metrics.prom.${this.pid}`, 0, {}, err);
    }
    // Check alert thresholds.
    if (this.opts.alertThresholds.length > 0) {
      this.checkThresholds(this.collectMetrics());
    }
    // Aggregate every per-pid fragment into `metrics.prom`.
    this.aggregate();
    return fragmentPath;
  }

  /** Periodic write. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.writeOnce(); } catch { /* never throw */ } }, this.opts.scrapeIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /**
   * Aggregate every per-pid fragment in the dir into a single
   * `metrics.prom` file. Stale fragments (>10× scrape interval
   * since last update) get GC'd.
   *
   * E8: Uses a try-lock via O_CREAT|O_EXCL to prevent concurrent
   * aggregator processes from writing simultaneously. Only the
   * process that creates the lock file runs; others skip silently.
   */
  aggregate(): void {
    const lockPath = join(this.fragmentDir, ".aggregator.lock");
    let lockFd: number | undefined;

    // Try to acquire the lock (non-blocking: O_CREAT|O_EXCL fails with EEXIST if already held).
    try {
      lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      // Write our pid into the lock file for diagnostics.
      writeFileSync(lockPath, String(process.pid));
    } catch (err: unknown) {
      // EEXIST means another process holds the lock; skip silently.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return;
      // Any other error acquiring the lock — proceed without lock (best-effort).
    }

    try {
      const out = join(this.fragmentDir, "metrics.prom");
      const staleAfterMs = this.opts.scrapeIntervalMs * 10;
      const now = Date.now();
      let combined = "";
      try {
        for (const f of readdirSync(this.fragmentDir)) {
          const m = f.match(/^metrics\.prom\.(\d+)$/);
          if (!m) continue;
          const path = join(this.fragmentDir, f);
          try {
            const st = statSync(path);
            if (now - st.mtimeMs > staleAfterMs) {
              unlinkSync(path);
              continue;
            }
            combined += "# pid " + m[1] + "\n";
            combined += require("fs").readFileSync(path, "utf8");
          } catch { /* skip */ }
        }
      } catch { /* readdir failed */ }
      try {
        const tmp = out + ".tmp";
        writeFileSync(tmp, combined, { mode: 0o600 });
        renameSync(tmp, out);
      } catch { /* best-effort */ }
    } finally {
      // Release the lock.
      if (lockFd !== undefined) {
        try { closeSync(lockFd); } catch { /* ignore */ }
      }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}
