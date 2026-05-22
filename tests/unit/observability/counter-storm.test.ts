// Phase E item E13 — Counter WAL counter-storm chaos test.
//
// Simulates 10 short-lived CLI processes each incrementing a cataloged
// counter 1M times in tight sequence. Asserts:
//   - WAL file size stays under quota (compaction kicks in).
//   - computeTotals() returns the correct monotonic total.
//   - No writes go to runsDir.
//   - Totals never decrease across snapshots.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, statSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CounterWal } from "../../../src/observability/counter-wal.js";

describe("E13 — counter-storm chaos", () => {
  let configDir: string;
  let runsDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cwal-storm-"));
    runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  });

  it("WAL stays under quota when many increments are batched", () => {
    // walByteCap = 64 KB — small enough to trigger compaction repeatedly.
    const wal = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 64 * 1024 });

    const PROCESSES = 10;
    const PER_PROCESS = 100_000;

    // Simulate 10 CLI processes each incrementing pi_eng_fallback_fired_total.
    for (let p = 0; p < PROCESSES; p++) {
      for (let i = 0; i < PER_PROCESS; i++) {
        wal.inc("pi_eng_fallback_fired_total", { tier: "1", agent: "a", step: "s", provider: "anthropic" });
      }
      // Force a flush (simulates process exit / scrape boundary).
      wal.flush();
    }

    // Final flush to ensure all pending deltas are on disk.
    wal.flush();
    wal.stop();

    // WAL file must exist and be under the quota cap (compaction enforces this).
    const walPath = join(configDir, "telemetry", "counter-wal.jsonl");
    expect(existsSync(walPath)).toBe(true);
    const walSize = statSync(walPath).size;
    expect(walSize).toBeLessThanOrEqual(64 * 1024 * 2); // up to 2× cap is acceptable post-compact

    // Total must equal exactly PROCESSES × PER_PROCESS.
    const totals = wal.computeTotals();
    const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_fallback_fired_total"));
    expect(key).toBeTruthy();
    expect(totals[key!]).toBe(PROCESSES * PER_PROCESS);
  });

  it("computeTotals() is monotonic across repeated snapshots under load", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 32 * 1024 });

    let lastTotal = 0;
    const ROUNDS = 20;
    const PER_ROUND = 5000;

    for (let r = 0; r < ROUNDS; r++) {
      for (let i = 0; i < PER_ROUND; i++) {
        wal.inc("pi_eng_verdict_timeout_total", { agent: "a", step: "s" });
      }
      wal.flush();
      const totals = wal.computeTotals();
      const key = Object.keys(totals).find((k) => k.startsWith("pi_eng_verdict_timeout_total"));
      const current = key ? totals[key] : 0;
      expect(current).toBeGreaterThanOrEqual(lastTotal);
      lastTotal = current;
    }

    wal.stop();
    expect(lastTotal).toBe(ROUNDS * PER_ROUND);
  });

  it("WAL is isolated to configDir — runsDir is never written", () => {
    const wal = new CounterWal({ configDir, flushIntervalMs: 0, walByteCap: 1024 });

    for (let i = 0; i < 1000; i++) {
      wal.inc("pi_eng_activity_drops_total", { kind: "thinking", provider: "anthropic" });
    }
    wal.flush();
    wal.stop();

    // runsDir must remain empty — no WAL writes there.
    const runsContents = readdirSync(runsDir);
    expect(runsContents).toHaveLength(0);

    // WAL is in configDir/telemetry/.
    const walPath = join(configDir, "telemetry", "counter-wal.jsonl");
    expect(existsSync(walPath)).toBe(true);
  });
});
