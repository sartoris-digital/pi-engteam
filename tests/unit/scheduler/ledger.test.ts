import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, ledgerPath, readLedger } from "../../../src/scheduler/ledger.js";

describe("ledger", () => {
  it("appends jsonl and sequential concurrent writes do not tear lines", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-ledger-"));
    try {
      const events = Array.from({ length: 20 }, (_, i) => ({
        ts: `2026-09-03T00:00:${String(i).padStart(2, "0")}.000Z`,
        type: "tick",
        key: `k${i}`,
        from: "queued" as const,
        to: "classifying" as const,
      }));
      for (const event of events) await appendLedger(runs, event);
      const raw = await readFile(ledgerPath(runs), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(20);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect(raw.endsWith("\n")).toBe(true);
      const loaded = await readLedger(runs);
      expect(loaded.map((e) => e.key)).toEqual(events.map((e) => e.key));
      const since = await readLedger(runs, { since: new Date("2026-09-03T00:00:10.000Z") });
      expect(since.map((e) => e.key)).toEqual(events.slice(10).map((e) => e.key));
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });
});
