// CounterWal.computeTotals() monotonicity and edge case tests.
//
// Covers critical gaps identified in audit:
//   GAP-11: Monotonicity after compact() — the oracle test validates
//           monotonicity during flush but not after compact(), which
//           could decrease totals without failing the storm test.
//   GAP-01 to GAP-10: File state edge cases (empty WAL, corrupt
//                     checkpoint, torn lines in WAL).
//   GAP-06: Label canonicalization order independence.
//   GAP-14: getOverflowDrops() behavior verification.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CounterWal } from "../../../src/observability/counter-wal.js";
import type { CounterCheckpoint, CounterDelta } from "../../../src/observability/counter-wal.js";

describe("CounterWal.computeTotals() — monotonicity", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cwal-mono-"));
  });

  it("GAP-11: totals are monotonic AFTER compact() is called", () => {
    // This is the CRITICAL missing test — the counter-storm oracle
    // validates monotonicity during flush but not after compact().
    // compact() could incorrectly decrease totals if it has a bug.
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });

    // Initial increments using a cataloged metric.
    for (let i = 0; i < 1000; i++) {
      wal.inc("pi_eng_fallback_fired_total", { tier: "1", agent: "test", step: "compact", provider: "anthropic" });
    }
    wal.flush();

    const beforeCompact = wal.computeTotals();
    const keyBefore = Object.keys(beforeCompact).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
    expect(keyBefore).toBeTruthy();
    const totalBefore = beforeCompact[keyBefore!];
    expect(totalBefore).toBe(1000);

    // Compact the WAL.
    wal.compact();

    // Add more increments after compact.
    for (let i = 0; i < 500; i++) {
      wal.inc("pi_eng_fallback_fired_total", { tier: "1", agent: "test", step: "compact", provider: "anthropic" });
    }
    wal.flush();

    const afterCompact = wal.computeTotals();
    const keyAfter = Object.keys(afterCompact).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
    expect(keyAfter).toBeTruthy();
    const totalAfter = afterCompact[keyAfter!];

    // CRITICAL ASSERTION: totals must NEVER decrease after compact.
    expect(totalAfter).toBeGreaterThanOrEqual(totalBefore);
    expect(totalAfter).toBe(1500); // exact total verification

    wal.stop();
  });

  it("GAP-11: multiple compactions maintain monotonicity under load", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 1024 });

    let cumulativeTotal = 0;
    const ROUNDS = 10;

    for (let round = 0; round < ROUNDS; round++) {
      // Increment and flush using a cataloged metric.
      for (let i = 0; i < 200; i++) {
        wal.inc("pi_eng_verdict_timeout_total", { agent: "test", step: String(round) });
      }
      wal.flush();
      cumulativeTotal += 200;

      // Force compact every other round.
      if (round % 2 === 1) {
        wal.compact();
      }

      // Verify monotonicity after each operation.
      const totals = wal.computeTotals();
      const keys = Object.keys(totals).filter((k) => k.startsWith("pi_eng_verdict_timeout_total"));
      const currentTotal = keys.reduce((sum, k) => sum + totals[k], 0);
      expect(currentTotal).toBeGreaterThanOrEqual(cumulativeTotal);
    }

    wal.stop();
  });

  it("GAP-11: compact() preserves exact totals across all label sets", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });

    // Create counters with multiple label sets using a cataloged metric.
    const labelSets = [
      { agent: "a", step: "s1" },
      { agent: "b", step: "s2" },
      { agent: "c", step: "s3" },
    ];

    for (const labels of labelSets) {
      for (let i = 0; i < 100; i++) {
        wal.inc("pi_eng_verdict_timeout_total", labels);
      }
    }
    wal.flush();

    const beforeCompact = wal.computeTotals();
    const keysBefore = Object.keys(beforeCompact).filter((k) => k.startsWith("pi_eng_verdict_timeout_total"));
    expect(keysBefore).toHaveLength(3);

    // Compact.
    wal.compact();

    const afterCompact = wal.computeTotals();
    const keysAfter = Object.keys(afterCompact).filter((k) => k.startsWith("pi_eng_verdict_timeout_total"));
    expect(keysAfter).toHaveLength(3);

    // Every key must have the same total before and after compact.
    for (const key of keysBefore) {
      expect(afterCompact[key]).toBe(beforeCompact[key]);
      expect(afterCompact[key]).toBe(100);
    }

    wal.stop();
  });
});

describe("CounterWal.computeTotals() — file state edge cases", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cwal-edge-"));
  });

  it("GAP-01: empty WAL file returns checkpoint totals only", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });
    const telemetryDir = join(configDir, "telemetry");

    // Create a checkpoint with existing totals using cataloged metric key format.
    const checkpoint: CounterCheckpoint = {
      ts: new Date().toISOString(),
      totals: {
        "pi_eng_fallback_fired_total|agent=a,provider=anthropic,step=s,tier=1": 500,
      },
    };
    writeFileSync(join(telemetryDir, "counter-checkpoint.json"), JSON.stringify(checkpoint), { mode: 0o600 });

    // Create an empty WAL file.
    writeFileSync(join(telemetryDir, "counter-wal.jsonl"), "", { mode: 0o600 });

    const totals = wal.computeTotals();
    expect(totals["pi_eng_fallback_fired_total|agent=a,provider=anthropic,step=s,tier=1"]).toBe(500);

    wal.stop();
  });

  it("GAP-02: corrupt checkpoint is ignored, WAL is still read", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });
    const telemetryDir = join(configDir, "telemetry");

    // Write corrupt checkpoint (invalid JSON).
    writeFileSync(join(telemetryDir, "counter-checkpoint.json"), "{ broken json }", { mode: 0o600 });

    // Write valid WAL using a cataloged metric.
    wal.inc("pi_eng_activity_drops_total", { kind: "thinking", provider: "anthropic" }, 100);
    wal.flush();

    const totals = wal.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_activity_drops_total"));
    expect(key).toBeTruthy();
    expect(totals[key!]).toBe(100);

    wal.stop();
  });

  it("GAP-03: torn lines in WAL are skipped, valid lines are counted", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });
    const telemetryDir = join(configDir, "telemetry");
    const walPath = join(telemetryDir, "counter-wal.jsonl");

    // Write a mix of valid and torn lines using a cataloged metric.
    const validDelta: CounterDelta = {
      ts: new Date().toISOString(),
      pid: process.pid,
      name: "pi_eng_stuck_warning_total",
      labels: { kind: "thinking" },
      delta: 50,
    };
    appendFileSync(walPath, JSON.stringify(validDelta) + "\n", { mode: 0o600 });
    appendFileSync(walPath, "{ torn line without closing brac\n", { mode: 0o600 });
    appendFileSync(walPath, JSON.stringify(validDelta) + "\n", { mode: 0o600 });

    const totals = wal.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_stuck_warning_total"));
    expect(key).toBeTruthy();
    // Should count both valid lines (2 × 50 = 100), skip torn line.
    expect(totals[key!]).toBe(100);

    wal.stop();
  });

  it("GAP-04: missing checkpoint and WAL returns empty totals", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });

    // Don't write anything — both files are missing.
    const totals = wal.computeTotals();
    expect(Object.keys(totals)).toHaveLength(0);

    wal.stop();
  });

  it("GAP-05: checkpoint with missing totals field is handled gracefully", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });
    const telemetryDir = join(configDir, "telemetry");

    // Write checkpoint with missing totals field.
    writeFileSync(
      join(telemetryDir, "counter-checkpoint.json"),
      JSON.stringify({ ts: new Date().toISOString() }),
      { mode: 0o600 }
    );

    // Add some WAL data using a cataloged metric.
    wal.inc("pi_eng_usage_unavailable_total", { provider: "anthropic" }, 25);
    wal.flush();

    const totals = wal.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_usage_unavailable_total"));
    expect(key).toBeTruthy();
    expect(totals[key!]).toBe(25);

    wal.stop();
  });

  it("GAP-06: label canonicalization is order-independent", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });

    // Increment with labels in different orders — should map to same key.
    // Use a cataloged metric (workflow_success_total has workflow and cohort labels).
    wal.inc("pi_eng_workflow_success_total", { cohort: "c1", workflow: "w1" }, 10);
    wal.inc("pi_eng_workflow_success_total", { workflow: "w1", cohort: "c1" }, 20);
    wal.flush();

    const totals = wal.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_workflow_success_total"));
    expect(key).toBeTruthy();
    // Both increments should map to the same key due to label canonicalization.
    expect(totals[key!]).toBe(30);

    wal.stop();
  });

  it("GAP-07: checkpoint + WAL merge correctly with overlapping keys", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });
    const telemetryDir = join(configDir, "telemetry");

    // Create checkpoint with existing total using a cataloged metric.
    const checkpoint: CounterCheckpoint = {
      ts: new Date().toISOString(),
      totals: {
        "pi_eng_capability_override_total|mode=warn": 100,
      },
    };
    writeFileSync(join(telemetryDir, "counter-checkpoint.json"), JSON.stringify(checkpoint), { mode: 0o600 });

    // Add more to the same key via WAL.
    wal.inc("pi_eng_capability_override_total", { mode: "warn" }, 50);
    wal.flush();

    const totals = wal.computeTotals();
    expect(totals["pi_eng_capability_override_total|mode=warn"]).toBe(150);

    wal.stop();
  });

  it("GAP-08: computeTotals() handles very large checkpoint files", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });
    const telemetryDir = join(configDir, "telemetry");

    // Create checkpoint with many keys using cataloged metrics.
    // Use different label combinations to create many unique keys.
    const totals: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      // Use workflow_success_total with varying cohort values
      totals[`pi_eng_workflow_success_total|cohort=c${i},workflow=w1`] = i;
    }
    const checkpoint: CounterCheckpoint = {
      ts: new Date().toISOString(),
      totals,
    };
    writeFileSync(join(telemetryDir, "counter-checkpoint.json"), JSON.stringify(checkpoint), { mode: 0o600 });

    const result = wal.computeTotals();
    expect(Object.keys(result)).toHaveLength(1000);
    expect(result["pi_eng_workflow_success_total|cohort=c999,workflow=w1"]).toBe(999);

    wal.stop();
  });

  it("GAP-09: computeTotals() handles WAL with many deltas per key", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });

    // Write many small deltas to the same key using a cataloged metric.
    for (let i = 0; i < 100; i++) {
      wal.inc("pi_eng_capability_mismatch_total", { provider: "anthropic", kind: "tool" }, 1);
      wal.flush(); // Force separate WAL lines.
    }

    const totals = wal.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_capability_mismatch_total"));
    expect(key).toBeTruthy();
    expect(totals[key!]).toBe(100);

    wal.stop();
  });

  it("GAP-10: empty lines in WAL are skipped gracefully", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0 });
    const telemetryDir = join(configDir, "telemetry");
    const walPath = join(telemetryDir, "counter-wal.jsonl");

    // Write valid delta with empty lines interspersed using a cataloged metric.
    const delta: CounterDelta = {
      ts: new Date().toISOString(),
      pid: process.pid,
      name: "pi_eng_capability_stale_total",
      labels: { provider: "anthropic" },
      delta: 42,
    };
    appendFileSync(walPath, "\n", { mode: 0o600 });
    appendFileSync(walPath, JSON.stringify(delta) + "\n", { mode: 0o600 });
    appendFileSync(walPath, "\n\n", { mode: 0o600 });
    appendFileSync(walPath, JSON.stringify(delta) + "\n", { mode: 0o600 });

    const totals = wal.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_capability_stale_total"));
    expect(key).toBeTruthy();
    expect(totals[key!]).toBe(84);

    wal.stop();
  });
});

describe("CounterWal — overflow drop behavior", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cwal-overflow-"));
  });

  it("GAP-14: getOverflowDrops() returns drop count when WAL is way over quota", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 100 }); // tiny cap

    // Fill WAL to trigger overflow using a cataloged metric.
    for (let i = 0; i < 100; i++) {
      wal.inc("pi_eng_protection_block_total", { path_class: "config", rule: "r1", surface: String(i) }, 1);
    }
    wal.flush();

    // Force another flush — this should trigger overflow drop.
    for (let i = 100; i < 200; i++) {
      wal.inc("pi_eng_protection_block_total", { path_class: "config", rule: "r1", surface: String(i) }, 1);
    }
    wal.flush();

    const drops = wal.getOverflowDrops();
    // Should have dropped some deltas.
    expect(drops).toBeGreaterThan(0);

    wal.stop();
  });

  it("GAP-14: overflow drops accumulate across multiple flush cycles", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 50 }); // very tiny cap

    let totalDrops = 0;

    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 50; i++) {
        wal.inc("pi_eng_cohort_overflow_total", { provider: String(round + i) }, 1);
      }
      wal.flush();
      const drops = wal.getOverflowDrops();
      expect(drops).toBeGreaterThanOrEqual(totalDrops);
      totalDrops = drops;
    }

    expect(totalDrops).toBeGreaterThan(0);

    wal.stop();
  });
});
