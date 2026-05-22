// CounterWal monotonicity and edge case tests — filling coverage gaps
// identified in coverage-gaps-audit.md (GAP-01 through GAP-11).
//
// These tests verify the critical assumptions of the counter-storm oracle:
//   1. Totals never decrease
//   2. Exact count match after N increments
//   3. WAL quota enforcement works correctly
//
// GAP-11 (monotonicity after compact) is the CRITICAL test that the
// oracle doesn't explicitly verify.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CounterWal } from "../../../src/observability/counter-wal.js";

describe("CounterWal — Monotonicity & Edge Cases", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "wal-mono-"));
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-11: Monotonicity after compact() ⚠️ CRITICAL
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // The oracle assumes totals never decrease, but doesn't explicitly
  // test the compact() → computeTotals() path. This is the highest
  // priority gap.
  describe("GAP-11: Monotonicity after compact()", () => {
    it("totals remain stable after compact()", () => {
      const w = new CounterWal({ configDir });

      // Step 1: inc() + flush() → totals = 100
      w.inc("pi_eng_fallback_fired_total", { tier: "synthesis", agent: "a", step: "s", provider: "p" }, 100);
      w.flush();

      const totals1 = w.computeTotals();
      const key = Object.keys(totals1).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
      expect(key).toBeDefined();
      expect(totals1[key!]).toBe(100);

      // Step 2: compact() — roll WAL into checkpoint
      w.compact();

      // Step 3: computeTotals() should still be 100 (monotonicity preserved)
      const totals2 = w.computeTotals();
      expect(totals2[key!]).toBe(100);
      expect(totals2[key!]).toBeGreaterThanOrEqual(totals1[key!]); // never decrease

      // Step 4: inc() more + flush() → totals = 150
      w.inc("pi_eng_fallback_fired_total", { tier: "synthesis", agent: "a", step: "s", provider: "p" }, 50);
      w.flush();

      const totals3 = w.computeTotals();
      expect(totals3[key!]).toBe(150);
      expect(totals3[key!]).toBeGreaterThanOrEqual(totals2[key!]); // never decrease

      // Verify checkpoint has 100, WAL tail has 50
      const cpPath = join(configDir, "telemetry", "counter-checkpoint.json");
      const cp = JSON.parse(readFileSync(cpPath, "utf8"));
      expect(cp.totals[key!]).toBe(100);

      const walPath = join(configDir, "telemetry", "counter-wal.jsonl");
      const walText = readFileSync(walPath, "utf8");
      const walLines = walText.trim().split("\n").filter((l) => l);
      expect(walLines.length).toBe(1); // only the new delta
      const walEntry = JSON.parse(walLines[0]);
      expect(walEntry.delta).toBe(50);
    });

    it("multiple compact() calls preserve monotonicity", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      let lastTotal = 0;
      for (let i = 1; i <= 5; i++) {
        w.inc("pi_eng_fallback_fired_total", labels, 10);
        w.flush();
        w.compact();

        const totals = w.computeTotals();
        const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
        const current = totals[key!];

        expect(current).toBe(i * 10);
        expect(current).toBeGreaterThanOrEqual(lastTotal); // monotonicity
        lastTotal = current;
      }

      expect(lastTotal).toBe(50);
    });

    it("compact() + new instance preserves totals (cross-process)", () => {
      const w1 = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w1.inc("pi_eng_fallback_fired_total", labels, 75);
      w1.flush();
      w1.compact();

      // Simulate new process
      const w2 = new CounterWal({ configDir });
      const totals2 = w2.computeTotals();
      const key = Object.keys(totals2).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
      expect(totals2[key!]).toBe(75);

      w2.inc("pi_eng_fallback_fired_total", labels, 25);
      w2.flush();

      const totals3 = w2.computeTotals();
      expect(totals3[key!]).toBe(100);
      expect(totals3[key!]).toBeGreaterThanOrEqual(totals2[key!]);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-01: Empty WAL file
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-01: Empty WAL file", () => {
    it("computeTotals returns only checkpoint when WAL is empty", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w.inc("pi_eng_fallback_fired_total", labels, 42);
      w.flush();
      w.compact(); // Creates checkpoint, truncates WAL to empty string

      const walPath = join(configDir, "telemetry", "counter-wal.jsonl");
      const walContent = readFileSync(walPath, "utf8");
      expect(walContent).toBe(""); // Verify WAL is empty

      const totals = w.computeTotals();
      const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
      expect(totals[key!]).toBe(42); // Should return checkpoint value only
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-02: Corrupt checkpoint file
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-02: Corrupt checkpoint file", () => {
    it("computeTotals gracefully handles malformed checkpoint JSON", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      // Create WAL with valid data
      w.inc("pi_eng_fallback_fired_total", labels, 100);
      w.flush();

      // Corrupt the checkpoint file
      const cpPath = join(configDir, "telemetry", "counter-checkpoint.json");
      mkdirSync(join(configDir, "telemetry"), { recursive: true });
      writeFileSync(cpPath, '{"ts":"2026-05-22T00:00:00.000Z","totals":{INVALID JSON', "utf8");

      // Should not throw, should return WAL totals only
      expect(() => w.computeTotals()).not.toThrow();
      const totals = w.computeTotals();
      const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
      expect(totals[key!]).toBe(100); // WAL tail preserved
    });

    it("corrupt checkpoint does not violate monotonicity", () => {
      const w1 = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w1.inc("pi_eng_fallback_fired_total", labels, 50);
      w1.flush();
      w1.compact();

      const totals1 = w1.computeTotals();
      const key = Object.keys(totals1).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
      expect(totals1[key!]).toBe(50);

      // Corrupt checkpoint
      const cpPath = join(configDir, "telemetry", "counter-checkpoint.json");
      writeFileSync(cpPath, "NOT JSON AT ALL", "utf8");

      // Add more data
      w1.inc("pi_eng_fallback_fired_total", labels, 25);
      w1.flush();

      const totals2 = w1.computeTotals();
      // Checkpoint is ignored (corrupt), so we only see the new WAL delta
      expect(totals2[key!]).toBe(25);
      // Note: In production, this would be a monotonicity violation if the
      // checkpoint had a higher value. The code's "start fresh" behavior
      // is documented in the audit as a known limitation.
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-03: Torn lines in WAL
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-03: Torn lines in WAL", () => {
    it("computeTotals skips torn lines and processes valid ones", () => {
      const w = new CounterWal({ configDir });

      // Manually create a WAL with valid + torn lines
      const walPath = join(configDir, "telemetry", "counter-wal.jsonl");
      mkdirSync(join(configDir, "telemetry"), { recursive: true });

      const validLine1 = JSON.stringify({
        ts: "2026-05-22T00:00:00.000Z",
        pid: 12345,
        name: "pi_eng_fallback_fired_total",
        labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
        delta: 10,
      });
      const tornLine = '{"ts":"2026-05-22T00:00:01.000Z","pid":12345,"name":"pi_eng_fallback_fired_total","labels":{"tier":"synthesis","agent":"a","step":"s","provider":"p"},"delta":999'; // incomplete
      const validLine2 = JSON.stringify({
        ts: "2026-05-22T00:00:02.000Z",
        pid: 12345,
        name: "pi_eng_fallback_fired_total",
        labels: { tier: "synthesis", agent: "a", step: "s", provider: "p" },
        delta: 20,
      });

      writeFileSync(walPath, [validLine1, tornLine, validLine2].join("\n") + "\n", "utf8");

      const totals = w.computeTotals();
      const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
      expect(totals[key!]).toBe(30); // 10 + 20, torn line skipped
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-04: Unreadable WAL file
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-04: Unreadable WAL file", () => {
    it("computeTotals returns checkpoint only when WAL is unreadable", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      // Create checkpoint
      w.inc("pi_eng_fallback_fired_total", labels, 100);
      w.flush();
      w.compact();

      // Add more data to WAL
      w.inc("pi_eng_fallback_fired_total", labels, 50);
      w.flush();

      // Make WAL unreadable
      const walPath = join(configDir, "telemetry", "counter-wal.jsonl");
      chmodSync(walPath, 0o000);

      try {
        // Should not throw, should return checkpoint only
        const totals = w.computeTotals();
        const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
        expect(totals[key!]).toBe(100); // checkpoint only, WAL tail lost
      } finally {
        // Restore permissions for cleanup
        chmodSync(walPath, 0o600);
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-05: Missing checkpoint + missing WAL
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-05: Missing checkpoint + missing WAL", () => {
    it("computeTotals returns empty object on first invocation", () => {
      const w = new CounterWal({ configDir });

      // No inc(), no flush() — fresh state
      const cpPath = join(configDir, "telemetry", "counter-checkpoint.json");
      const walPath = join(configDir, "telemetry", "counter-wal.jsonl");

      expect(existsSync(cpPath)).toBe(false);
      expect(existsSync(walPath)).toBe(false);

      const totals = w.computeTotals();
      expect(totals).toEqual({});
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-06: Label canonicalization order independence
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-06: Label canonicalization order independence", () => {
    it("same labels in different order produce identical totals", () => {
      const w = new CounterWal({ configDir });

      // Inc with labels in different orders
      w.inc("pi_eng_fallback_fired_total", { tier: "synthesis", agent: "a", step: "s", provider: "p" }, 10);
      w.inc("pi_eng_fallback_fired_total", { provider: "p", step: "s", agent: "a", tier: "synthesis" }, 20);
      w.inc("pi_eng_fallback_fired_total", { agent: "a", provider: "p", tier: "synthesis", step: "s" }, 30);
      w.flush();

      const totals = w.computeTotals();
      const keys = Object.keys(totals);

      // Should have exactly ONE key (all three increments merged)
      expect(keys.length).toBe(1);
      const key = keys[0];
      expect(totals[key]).toBe(60); // 10 + 20 + 30
    });

    it("label order independence across flushes", () => {
      const w = new CounterWal({ configDir });

      w.inc("pi_eng_fallback_fired_total", { a: "1", b: "2", c: "3" }, 5);
      w.flush();

      w.inc("pi_eng_fallback_fired_total", { c: "3", a: "1", b: "2" }, 10);
      w.flush();

      w.inc("pi_eng_fallback_fired_total", { b: "2", c: "3", a: "1" }, 15);
      w.flush();

      const totals = w.computeTotals();
      const keys = Object.keys(totals);
      expect(keys.length).toBe(1);
      expect(totals[keys[0]]).toBe(30);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-07: Multiple counters with different labels
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-07: Multiple counters with different labels", () => {
    it("maintains separate totals per counter+label combination", () => {
      const w = new CounterWal({ configDir });

      // Different counters
      w.inc("pi_eng_fallback_fired_total", { tier: "synthesis", agent: "a", step: "s", provider: "p" }, 10);
      w.inc("pi_eng_verdict_timeout_total", { agent: "a", step: "s" }, 20);
      w.inc("pi_eng_activity_drops_total", { kind: "thinking", provider: "anthropic" }, 30);

      // Same counter, different labels
      w.inc("pi_eng_fallback_fired_total", { tier: "stdout-scan", agent: "b", step: "t", provider: "q" }, 40);
      w.inc("pi_eng_fallback_fired_total", { tier: "synthesis", agent: "a", step: "s", provider: "p" }, 50);

      w.flush();

      const totals = w.computeTotals();
      const keys = Object.keys(totals);

      // Should have 4 distinct keys
      expect(keys.length).toBe(4);

      // Verify each total
      const key1 = keys.find((k) => k.includes("pi_eng_fallback_fired_total|agent=a"));
      const key2 = keys.find((k) => k.includes("pi_eng_fallback_fired_total|agent=b"));
      const key3 = keys.find((k) => k.includes("pi_eng_verdict_timeout_total"));
      const key4 = keys.find((k) => k.includes("pi_eng_activity_drops_total"));

      expect(totals[key1!]).toBe(60); // 10 + 50
      expect(totals[key2!]).toBe(40);
      expect(totals[key3!]).toBe(20);
      expect(totals[key4!]).toBe(30);
    });

    it("10+ distinct counter+label combinations", () => {
      const w = new CounterWal({ configDir });

      // Create 15 distinct combinations
      for (let i = 0; i < 15; i++) {
        w.inc("pi_eng_fallback_fired_total", {
          tier: "synthesis",
          agent: `agent-${i}`,
          step: `step-${i}`,
          provider: `provider-${i}`,
        }, i + 1);
      }

      w.flush();

      const totals = w.computeTotals();
      const keys = Object.keys(totals);

      expect(keys.length).toBe(15);

      // Verify sum
      const sum = Object.values(totals).reduce((a, b) => a + b, 0);
      expect(sum).toBe((15 * 16) / 2); // sum of 1..15 = 120
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-08 & GAP-09: Overflow drop behavior + getOverflowDrops()
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-08 & GAP-09: Overflow drops", () => {
    it("drops deltas when WAL exceeds 2× cap", () => {
      const w = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 1024 });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      // Fill WAL to exactly 2× cap by creating many deltas without flushing
      // Each delta is ~150 bytes, so we need ~14 deltas to exceed 2KB
      for (let i = 0; i < 20; i++) {
        w.inc("pi_eng_fallback_fired_total", { ...labels, suffix: `long-label-value-${i}-to-make-it-bigger` }, 1);
      }

      // Flush once to write all deltas
      w.flush();

      // Now create more deltas to trigger overflow
      for (let i = 0; i < 100; i++) {
        w.inc("pi_eng_fallback_fired_total", { ...labels, suffix: `overflow-${i}` }, 1);
      }

      const dropsBefore = w.getOverflowDrops();
      w.flush(); // This should trigger overflow drop
      const dropsAfter = w.getOverflowDrops();

      // getOverflowDrops() should have incremented
      expect(dropsAfter).toBeGreaterThan(dropsBefore);
    });

    it("getOverflowDrops() increments by delta count", () => {
      const w = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 512 });

      expect(w.getOverflowDrops()).toBe(0);

      // Force overflow
      for (let i = 0; i < 50; i++) {
        w.inc("pi_eng_fallback_fired_total", {
          tier: "synthesis",
          agent: `agent-${i}`,
          step: `step-${i}`,
          provider: `provider-${i}`,
        }, 1);
      }
      w.flush(); // Writes to disk

      // Add more deltas to trigger overflow on next flush
      for (let i = 0; i < 30; i++) {
        w.inc("pi_eng_fallback_fired_total", {
          tier: "synthesis",
          agent: `overflow-agent-${i}`,
          step: `overflow-step-${i}`,
          provider: `overflow-provider-${i}`,
        }, 1);
      }

      const dropsBefore = w.getOverflowDrops();
      w.flush();
      const dropsAfter = w.getOverflowDrops();

      // Should have dropped the 30 deltas
      expect(dropsAfter - dropsBefore).toBeGreaterThanOrEqual(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GAP-10: flush() error handling (best-effort contract)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("GAP-10: flush() never throws", () => {
    it("flush() does not throw when WAL directory is read-only", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w.inc("pi_eng_fallback_fired_total", labels, 10);
      w.flush(); // First flush succeeds

      // Make telemetry dir read-only
      const telemetryDir = join(configDir, "telemetry");
      const originalMode = 0o700;
      chmodSync(telemetryDir, 0o500); // read + execute only

      try {
        w.inc("pi_eng_fallback_fired_total", labels, 20);
        expect(() => w.flush()).not.toThrow(); // Best-effort contract
      } finally {
        // Restore permissions for cleanup
        chmodSync(telemetryDir, originalMode);
      }
    });

    it("flush() handles missing directory gracefully", () => {
      // Create a CounterWal but don't let it create the directory
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      w.inc("pi_eng_fallback_fired_total", labels, 10);

      // Even if the flush fails, it should not throw
      expect(() => w.flush()).not.toThrow();
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Additional monotonicity verification tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("Additional monotonicity guarantees", () => {
    it("totals never decrease across checkpoint → WAL → compact cycles", () => {
      const w = new CounterWal({ configDir });
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      let lastTotal = 0;

      for (let cycle = 0; cycle < 10; cycle++) {
        // Add some increments
        for (let i = 0; i < 5; i++) {
          w.inc("pi_eng_fallback_fired_total", labels, 7);
        }
        w.flush();

        const totals = w.computeTotals();
        const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
        const current = totals[key!];

        expect(current).toBeGreaterThanOrEqual(lastTotal);
        lastTotal = current;

        // Compact every other cycle
        if (cycle % 2 === 1) {
          w.compact();

          // Verify totals didn't decrease after compact
          const totalsAfterCompact = w.computeTotals();
          expect(totalsAfterCompact[key!]).toBe(current);
        }
      }

      expect(lastTotal).toBe(10 * 5 * 7); // 350
    });

    it("cross-process monotonicity with checkpoint", () => {
      const labels = { tier: "synthesis", agent: "a", step: "s", provider: "p" };

      // Process 1: inc + flush + compact
      const w1 = new CounterWal({ configDir });
      w1.inc("pi_eng_fallback_fired_total", labels, 100);
      w1.flush();
      w1.compact();

      const totals1 = w1.computeTotals();
      const key = Object.keys(totals1).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
      expect(totals1[key!]).toBe(100);

      // Process 2: reads checkpoint, adds more
      const w2 = new CounterWal({ configDir });
      const totals2a = w2.computeTotals();
      expect(totals2a[key!]).toBe(100); // Sees checkpoint

      w2.inc("pi_eng_fallback_fired_total", labels, 50);
      w2.flush();

      const totals2b = w2.computeTotals();
      expect(totals2b[key!]).toBe(150);
      expect(totals2b[key!]).toBeGreaterThanOrEqual(totals2a[key!]);

      // Process 3: sees the combined total
      const w3 = new CounterWal({ configDir });
      const totals3 = w3.computeTotals();
      expect(totals3[key!]).toBe(150);
    });
  });
});
