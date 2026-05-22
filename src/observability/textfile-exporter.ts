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
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { METRIC_CATALOG, type MetricEntry } from "./metric-catalog.js";
import type { CounterWal } from "./counter-wal.js";

export type GaugeReader = () => Array<{ name: string; labels: Record<string, string>; value: number }>;

export type ExporterOptions = {
  configDir: string;
  wal?: CounterWal;
  // Optional caller-supplied gauges (e.g. queue depth, disk usage).
  // Called on every render so the snapshot is fresh.
  gaugeReaders?: GaugeReader[];
  // Default 60s — node-exporter typically scrapes at 60s.
  scrapeIntervalMs?: number;
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
  private readonly opts: Required<Omit<ExporterOptions, "wal" | "gaugeReaders">> & {
    wal?: CounterWal;
    gaugeReaders: GaugeReader[];
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
    };
    this.fragmentDir = join(opts.configDir, "telemetry");
    mkdirSync(this.fragmentDir, { recursive: true });
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

  /** Write one fragment atomically + emit the aggregated file. */
  writeOnce(): string {
    const text = this.render();
    const fragmentPath = join(this.fragmentDir, `metrics.prom.${this.pid}`);
    const tmp = fragmentPath + ".tmp";
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, fragmentPath);
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
   */
  aggregate(): void {
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
  }
}
