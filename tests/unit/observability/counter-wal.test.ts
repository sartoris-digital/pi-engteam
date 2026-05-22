import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CounterWal } from "../../../src/observability/counter-wal.js";

describe("CounterWal", () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "wal-"));
  });

  it("accumulates deltas in memory until flush", () => {
    const w = new CounterWal({ configDir });
    w.inc("pi_eng_fallback_fired_total", { tier: "stdout-scan", agent: "a", step: "s", provider: "p" });
    w.inc("pi_eng_fallback_fired_total", { tier: "stdout-scan", agent: "a", step: "s", provider: "p" });
    expect(existsSync(join(configDir, "telemetry", "counter-wal.jsonl"))).toBe(false);
    w.flush();
    const text = readFileSync(join(configDir, "telemetry", "counter-wal.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(1); // aggregated into ONE line per E13
    const parsed = JSON.parse(lines[0]);
    expect(parsed.delta).toBe(2);
  });

  it("rejects unknown metric names", () => {
    const w = new CounterWal({ configDir });
    expect(() => w.inc("pi_eng_not_a_real_metric")).toThrow(/unknown metric/);
  });

  it("rejects gauges (only counters allowed)", () => {
    const w = new CounterWal({ configDir });
    expect(() => w.inc("pi_eng_activity_disk_usage_bytes", { surface: "canonical" })).toThrow(/not counter/);
  });

  it("computeTotals returns the aggregate across flushes", () => {
    const w = new CounterWal({ configDir });
    w.inc("pi_eng_fallback_fired_total", { tier: "synthesis", agent: "a", step: "s", provider: "p" });
    w.flush();
    w.inc("pi_eng_fallback_fired_total", { tier: "synthesis", agent: "a", step: "s", provider: "p" }, 5);
    w.flush();
    const totals = w.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
    expect(key).toBeDefined();
    expect(totals[key!]).toBe(6);
  });

  it("compact rolls the WAL into the checkpoint + truncates", () => {
    const w = new CounterWal({ configDir });
    w.inc("pi_eng_verdict_timeout_total", { agent: "a", step: "s" }, 3);
    w.flush();
    w.compact();
    expect(existsSync(join(configDir, "telemetry", "counter-checkpoint.json"))).toBe(true);
    const wal = readFileSync(join(configDir, "telemetry", "counter-wal.jsonl"), "utf8");
    expect(wal).toBe("");
    const totals = w.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_verdict_timeout_total"));
    expect(totals[key!]).toBe(3);
  });

  it("counter survives short-lived process simulation (round 7 MED #5)", () => {
    // First "process": increment + flush + exit (release WAL handle).
    const w1 = new CounterWal({ configDir });
    w1.inc("pi_eng_fallback_fired_total", { tier: "stdout-scan", agent: "a", step: "s", provider: "p" }, 5);
    w1.flush();
    // Second "process": new instance reads the WAL and adds more.
    const w2 = new CounterWal({ configDir });
    const t1 = w2.computeTotals();
    const key = Object.keys(t1).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
    expect(t1[key!]).toBe(5);
    w2.inc("pi_eng_fallback_fired_total", { tier: "stdout-scan", agent: "a", step: "s", provider: "p" }, 2);
    w2.flush();
    // Third "process" sees the full 7.
    const w3 = new CounterWal({ configDir });
    const t3 = w3.computeTotals();
    expect(t3[key!]).toBe(7);
  });
});
