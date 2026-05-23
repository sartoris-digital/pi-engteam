// CounterWal.computeTotals() merge verification tests
//
// These tests explicitly verify that computeTotals() correctly merges
// checkpoint + WAL tail to maintain monotonicity guarantees.
//
// Oracle: counter-storm.test.ts validates that totals never decrease
// across snapshots under load. These tests verify the merge logic
// edge cases that the oracle doesn't explicitly exercise.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CounterWal } from "../../../src/observability/counter-wal.js";

describe("CounterWal — Checkpoint + WAL Merge Verification", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "wal-merge-"));
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Explicit merge verification tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("Merge Logic: Checkpoint + WAL", () => {
    it("merges checkpoint totals with WAL deltas correctly", () => {
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });

      // Create checkpoint with total=100
      const checkpoint = {
        ts: "2026-05-23T00:00:00.000Z",
        totals: {
          "pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis": 100,
        },
      };
      writeFileSync(
        join(telemetryDir, "counter-checkpoint.json"),
        JSON.stringify(checkpoint),
        "utf8"
      );

      // Create WAL with delta=50
      const walEntry = {
        ts: "2026-05-23T00:01:00.000Z",
        pid: 12345,
        name: "pi_eng_fallback_fired_total",
        labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
        delta: 50,
      };
      writeFileSync(
        join(telemetryDir, "counter-wal.jsonl"),
        JSON.stringify(walEntry) + "\n",
        "utf8"
      );

      const w = new CounterWal({ configDir });
      const totals = w.computeTotals();

      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(150); // 100 from checkpoint + 50 from WAL
    });

    it("checkpoint-only returns checkpoint totals (WAL doesn't exist)", () => {
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });

      const checkpoint = {
        ts: "2026-05-23T00:00:00.000Z",
        totals: {
          "pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis": 75,
        },
      };
      writeFileSync(
        join(telemetryDir, "counter-checkpoint.json"),
        JSON.stringify(checkpoint),
        "utf8"
      );

      // WAL doesn't exist
      const w = new CounterWal({ configDir });
      const totals = w.computeTotals();

      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(75);
    });

    it("WAL-only returns WAL totals (checkpoint doesn't exist)", () => {
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });

      // Checkpoint doesn't exist, only WAL
      const walEntries = [
        {
          ts: "2026-05-23T00:00:00.000Z",
          pid: 12345,
          name: "pi_eng_fallback_fired_total",
          labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
          delta: 30,
        },
        {
          ts: "2026-05-23T00:01:00.000Z",
          pid: 12345,
          name: "pi_eng_fallback_fired_total",
          labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
          delta: 20,
        },
      ];
      writeFileSync(
        join(telemetryDir, "counter-wal.jsonl"),
        walEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8"
      );

      const w = new CounterWal({ configDir });
      const totals = w.computeTotals();

      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(50); // 30 + 20 from WAL only
    });

    it("handles checkpoint with empty totals object", () => {
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });

      // Checkpoint with empty totals
      const checkpoint = {
        ts: "2026-05-23T00:00:00.000Z",
        totals: {},
      };
      writeFileSync(
        join(telemetryDir, "counter-checkpoint.json"),
        JSON.stringify(checkpoint),
        "utf8"
      );

      // WAL with data
      const walEntry = {
        ts: "2026-05-23T00:01:00.000Z",
        pid: 12345,
        name: "pi_eng_fallback_fired_total",
        labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
        delta: 42,
      };
      writeFileSync(
        join(telemetryDir, "counter-wal.jsonl"),
        JSON.stringify(walEntry) + "\n",
        "utf8"
      );

      const w = new CounterWal({ configDir });
      const totals = w.computeTotals();

      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(42);
    });

    it("merges multiple counters from checkpoint and WAL", () => {
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });

      // Checkpoint with counter A and B
      const checkpoint = {
        ts: "2026-05-23T00:00:00.000Z",
        totals: {
          "pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis": 100,
          "pi_eng_verdict_timeout_total|agent=a,step=s": 50,
        },
      };
      writeFileSync(
        join(telemetryDir, "counter-checkpoint.json"),
        JSON.stringify(checkpoint),
        "utf8"
      );

      // WAL with counter B update and counter C new
      const walEntries = [
        {
          ts: "2026-05-23T00:01:00.000Z",
          pid: 12345,
          name: "pi_eng_verdict_timeout_total",
          labels: { agent: "a", step: "s" },
          delta: 25,
        },
        {
          ts: "2026-05-23T00:02:00.000Z",
          pid: 12345,
          name: "pi_eng_activity_drops_total",
          labels: { kind: "thinking", provider: "anthropic" },
          delta: 10,
        },
      ];
      writeFileSync(
        join(telemetryDir, "counter-wal.jsonl"),
        walEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8"
      );

      const w = new CounterWal({ configDir });
      const totals = w.computeTotals();

      const keyA = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      const keyB = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_verdict_timeout_total")
      );
      const keyC = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_activity_drops_total")
      );

      expect(totals[keyA!]).toBe(100); // Only in checkpoint
      expect(totals[keyB!]).toBe(75); // 50 from checkpoint + 25 from WAL
      expect(totals[keyC!]).toBe(10); // Only in WAL
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Monotonicity guarantees during merge
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("Monotonicity: Merge never decreases totals", () => {
    it("totals never decrease when adding WAL deltas to checkpoint", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      // Build checkpoint
      w.inc("pi_eng_fallback_fired_total", labels, 100);
      w.flush();
      w.compact();

      const totalsFromCheckpoint = w.computeTotals();
      const key = Object.keys(totalsFromCheckpoint).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totalsFromCheckpoint[key!]).toBe(100);

      // Add WAL deltas
      w.inc("pi_eng_fallback_fired_total", labels, 0); // Zero delta
      w.flush();

      const totalsAfterZeroDelta = w.computeTotals();
      expect(totalsAfterZeroDelta[key!]).toBe(100); // No decrease

      w.inc("pi_eng_fallback_fired_total", labels, 50);
      w.flush();

      const totalsAfterPositiveDelta = w.computeTotals();
      expect(totalsAfterPositiveDelta[key!]).toBe(150); // Increased
      expect(totalsAfterPositiveDelta[key!]).toBeGreaterThanOrEqual(
        totalsAfterZeroDelta[key!]
      );
    });

    it("computeTotals is stable when called multiple times without changes", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w.inc("pi_eng_fallback_fired_total", labels, 123);
      w.flush();
      w.compact();

      const totals1 = w.computeTotals();
      const totals2 = w.computeTotals();
      const totals3 = w.computeTotals();

      expect(totals1).toEqual(totals2);
      expect(totals2).toEqual(totals3);
    });

    it("merge maintains monotonicity across checkpoint updates", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      const snapshots: number[] = [];

      // Phase 1: Build initial checkpoint
      w.inc("pi_eng_fallback_fired_total", labels, 50);
      w.flush();
      w.compact();
      snapshots.push(w.computeTotals()["pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis"]);

      // Phase 2: Add WAL tail
      w.inc("pi_eng_fallback_fired_total", labels, 30);
      w.flush();
      snapshots.push(w.computeTotals()["pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis"]);

      // Phase 3: Compact again
      w.compact();
      snapshots.push(w.computeTotals()["pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis"]);

      // Phase 4: Add more WAL tail
      w.inc("pi_eng_fallback_fired_total", labels, 20);
      w.flush();
      snapshots.push(w.computeTotals()["pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis"]);

      // Verify monotonicity across all snapshots
      for (let i = 1; i < snapshots.length; i++) {
        expect(snapshots[i]).toBeGreaterThanOrEqual(snapshots[i - 1]);
      }

      expect(snapshots).toEqual([50, 80, 80, 100]);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Edge cases specific to merge behavior
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("Merge Edge Cases", () => {
    it("handles WAL with multiple deltas for same counter", () => {
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });

      const checkpoint = {
        ts: "2026-05-23T00:00:00.000Z",
        totals: {
          "pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis": 10,
        },
      };
      writeFileSync(
        join(telemetryDir, "counter-checkpoint.json"),
        JSON.stringify(checkpoint),
        "utf8"
      );

      // WAL with 5 deltas for the same counter
      const walEntries = [];
      for (let i = 0; i < 5; i++) {
        walEntries.push({
          ts: new Date(2026, 4, 23, 0, i, 0).toISOString(),
          pid: 12345,
          name: "pi_eng_fallback_fired_total",
          labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
          delta: 10,
        });
      }
      writeFileSync(
        join(telemetryDir, "counter-wal.jsonl"),
        walEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8"
      );

      const w = new CounterWal({ configDir });
      const totals = w.computeTotals();

      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(60); // 10 from checkpoint + 5×10 from WAL
    });

    it("handles checkpoint with counter not in WAL", () => {
      const telemetryDir = join(configDir, "telemetry");
      mkdirSync(telemetryDir, { recursive: true });

      const checkpoint = {
        ts: "2026-05-23T00:00:00.000Z",
        totals: {
          "pi_eng_fallback_fired_total|agent=a,provider=p,step=s,tier=synthesis": 100,
          "pi_eng_verdict_timeout_total|agent=b,step=t": 50,
        },
      };
      writeFileSync(
        join(telemetryDir, "counter-checkpoint.json"),
        JSON.stringify(checkpoint),
        "utf8"
      );

      // WAL only has updates for one counter
      const walEntry = {
        ts: "2026-05-23T00:01:00.000Z",
        pid: 12345,
        name: "pi_eng_fallback_fired_total",
        labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
        delta: 25,
      };
      writeFileSync(
        join(telemetryDir, "counter-wal.jsonl"),
        JSON.stringify(walEntry) + "\n",
        "utf8"
      );

      const w = new CounterWal({ configDir });
      const totals = w.computeTotals();

      const key1 = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      const key2 = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_verdict_timeout_total")
      );

      expect(totals[key1!]).toBe(125); // Updated
      expect(totals[key2!]).toBe(50); // Unchanged from checkpoint
    });

    it("handles zero deltas in WAL correctly", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w.inc("pi_eng_fallback_fired_total", labels, 100);
      w.flush();
      w.compact();

      // Add zero delta
      w.inc("pi_eng_fallback_fired_total", labels, 0);
      w.flush();

      const totals = w.computeTotals();
      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(100); // No change
    });

    it("handles very large totals without precision loss", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      // Build checkpoint with large total
      const largeDelta = 1_000_000_000; // 1 billion
      w.inc("pi_eng_fallback_fired_total", labels, largeDelta);
      w.flush();
      w.compact();

      // Add more
      w.inc("pi_eng_fallback_fired_total", labels, largeDelta);
      w.flush();

      const totals = w.computeTotals();
      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(2_000_000_000); // 2 billion - no precision loss
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Oracle verification: Comparing against counter-storm expectations
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("Oracle Verification: counter-storm compatibility", () => {
    it("exact count match after N increments (oracle invariant)", () => {
      const w = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 64 * 1024 });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      const INCREMENTS = 10_000;

      // Simulate the counter-storm pattern
      for (let i = 0; i < INCREMENTS; i++) {
        w.inc("pi_eng_fallback_fired_total", labels);
      }
      w.flush();

      const totals = w.computeTotals();
      const key = Object.keys(totals).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals[key!]).toBe(INCREMENTS); // Exact match
    });

    it("monotonic across snapshots under repeated flush (oracle invariant)", () => {
      const w = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 32 * 1024 });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      let lastTotal = 0;
      const ROUNDS = 10;
      const PER_ROUND = 1000;

      for (let r = 0; r < ROUNDS; r++) {
        for (let i = 0; i < PER_ROUND; i++) {
          w.inc("pi_eng_fallback_fired_total", labels);
        }
        w.flush();

        const totals = w.computeTotals();
        const key = Object.keys(totals).find((k) =>
          k.startsWith("pi_eng_fallback_fired_total")
        );
        const current = totals[key!];

        // Oracle invariant: never decrease
        expect(current).toBeGreaterThanOrEqual(lastTotal);
        lastTotal = current;
      }

      expect(lastTotal).toBe(ROUNDS * PER_ROUND); // Exact final total
    });

    it("compact() preserves exact totals (oracle critical path)", () => {
      const w = new CounterWal({ configDir, flushIntervalMs: 0 });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      const EXACT_COUNT = 12345;

      // Increment exact count
      w.inc("pi_eng_fallback_fired_total", labels, EXACT_COUNT);
      w.flush();

      const totalsBeforeCompact = w.computeTotals();
      const key = Object.keys(totalsBeforeCompact).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totalsBeforeCompact[key!]).toBe(EXACT_COUNT);

      // Compact
      w.compact();

      const totalsAfterCompact = w.computeTotals();
      expect(totalsAfterCompact[key!]).toBe(EXACT_COUNT); // Exact preservation

      // Add more and verify total is still exact
      const ADDITIONAL = 6789;
      w.inc("pi_eng_fallback_fired_total", labels, ADDITIONAL);
      w.flush();

      const totalsFinal = w.computeTotals();
      expect(totalsFinal[key!]).toBe(EXACT_COUNT + ADDITIONAL);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Regression tests for potential merge bugs
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("Regression: Potential merge bugs", () => {
    it("does not double-count checkpoint totals when reading WAL", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w.inc("pi_eng_fallback_fired_total", labels, 100);
      w.flush();
      w.compact();

      // WAL should be empty after compact
      const totals1 = w.computeTotals();
      const key = Object.keys(totals1).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals1[key!]).toBe(100);

      // Multiple computeTotals() calls should return the same value
      const totals2 = w.computeTotals();
      const totals3 = w.computeTotals();
      expect(totals2[key!]).toBe(100);
      expect(totals3[key!]).toBe(100);
    });

    it("handles interleaved inc() and computeTotals() correctly", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w.inc("pi_eng_fallback_fired_total", labels, 10);
      w.flush();

      const totals1 = w.computeTotals();
      const key = Object.keys(totals1).find((k) =>
        k.startsWith("pi_eng_fallback_fired_total")
      );
      expect(totals1[key!]).toBe(10);

      w.inc("pi_eng_fallback_fired_total", labels, 20);
      // Note: Not flushed yet

      const totals2 = w.computeTotals();
      expect(totals2[key!]).toBe(10); // Still 10, not flushed

      w.flush();

      const totals3 = w.computeTotals();
      expect(totals3[key!]).toBe(30); // Now 30
    });

    it("handles rapid compact() calls without data loss", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      for (let i = 0; i < 10; i++) {
        w.inc("pi_eng_fallback_fired_total", labels, 10);
        w.flush();
        w.compact();
        w.compact(); // Double compact
        w.compact(); // Triple compact

        const totals = w.computeTotals();
        const key = Object.keys(totals).find((k) =>
          k.startsWith("pi_eng_fallback_fired_total")
        );
        expect(totals[key!]).toBe((i + 1) * 10);
      }
    });
  });
});
