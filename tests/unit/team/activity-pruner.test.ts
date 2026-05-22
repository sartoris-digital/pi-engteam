import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prune, pinRun, unpinRun } from "../../../src/team/activity-pruner.js";

function plantRun(runsDir: string, runId: string, bytes: number, mtimeOffsetMs: number): void {
  const dir = join(runsDir, "_activity", runId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "agent-activity.jsonl");
  writeFileSync(file, "x".repeat(bytes));
  const { utimesSync } = require("fs") as typeof import("fs");
  const t = (Date.now() + mtimeOffsetMs) / 1000;
  utimesSync(file, t, t);
  utimesSync(dir, t, t);
}

describe("activity-pruner", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "pruner-"));
  });

  it("prunes terminal runs past retention", () => {
    plantRun(runsDir, "fresh", 1000, 0);
    plantRun(runsDir, "old", 1000, -30 * 24 * 60 * 60 * 1000); // 30d old
    const r = prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: (id) => ({ status: "succeeded", endTs: new Date(Date.now() + (id === "old" ? -30 * 24 * 60 * 60 * 1000 : 0)).toISOString() }),
      retentionMs: 14 * 24 * 60 * 60 * 1000,
    });
    expect(r.prunedRunIds).toContain("old");
    expect(r.prunedRunIds).not.toContain("fresh");
  });

  it("never prunes an active run", () => {
    plantRun(runsDir, "active-old", 1000, -30 * 24 * 60 * 60 * 1000);
    const r = prune({
      runsDir,
      activeRunIds: new Set(["active-old"]),
      retentionMs: 14 * 24 * 60 * 60 * 1000,
    });
    expect(r.prunedRunIds).not.toContain("active-old");
    expect(r.pinnedActive).toBe(1);
  });

  it("pins recently-failed runs within incidentPinTtlMs", () => {
    plantRun(runsDir, "failed-recent", 1000, -3 * 24 * 60 * 60 * 1000); // 3d old
    const r = prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: () => ({ status: "failed", endTs: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() }),
      retentionMs: 24 * 60 * 60 * 1000,
      incidentPinTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(r.pinnedIncident).toBe(1);
    expect(r.prunedRunIds).not.toContain("failed-recent");
  });

  it("honors operator pins from .pinned.json", () => {
    plantRun(runsDir, "pinned-old", 1000, -30 * 24 * 60 * 60 * 1000);
    pinRun(runsDir, "pinned-old");
    const r = prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: () => ({ status: "succeeded", endTs: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
      retentionMs: 14 * 24 * 60 * 60 * 1000,
    });
    expect(r.pinnedOperator).toBe(1);
    expect(r.prunedRunIds).not.toContain("pinned-old");
  });

  it("writes a tombstone for each pruned run", () => {
    plantRun(runsDir, "to-prune", 1000, -30 * 24 * 60 * 60 * 1000);
    prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: () => ({ status: "succeeded", endTs: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
      retentionMs: 14 * 24 * 60 * 60 * 1000,
    });
    const tomb = join(runsDir, "_activity", ".tombstones", "to-prune.json");
    expect(existsSync(tomb)).toBe(true);
    const parsed = JSON.parse(readFileSync(tomb, "utf8"));
    expect(parsed.runId).toBe("to-prune");
    expect(parsed.reason).toBe("retention-or-quota");
  });

  it("quota-driven prune drops oldest first when over budget", () => {
    // Three runs, each 2 MB. Quota 4 MB. Oldest two should fit;
    // newest takes us over.
    plantRun(runsDir, "young", 2 * 1024 * 1024, 0);
    plantRun(runsDir, "mid", 2 * 1024 * 1024, -2 * 24 * 60 * 60 * 1000);
    plantRun(runsDir, "old", 2 * 1024 * 1024, -5 * 24 * 60 * 60 * 1000);
    const r = prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: (id) => ({
        status: "succeeded",
        endTs: new Date(Date.now() - (id === "young" ? 0 : id === "mid" ? 2 : 5) * 24 * 60 * 60 * 1000).toISOString(),
      }),
      retentionMs: 365 * 24 * 60 * 60 * 1000, // no TTL prune
      globalQuotaBytes: 4 * 1024 * 1024,
    });
    expect(r.prunedRunIds).toContain("old");
  });

  it("unpinRun removes the runId from the pinned set", () => {
    plantRun(runsDir, "p", 1000, 0);
    pinRun(runsDir, "p");
    unpinRun(runsDir, "p");
    const path = join(runsDir, "_activity", ".pinned.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.runIds).not.toContain("p");
  });
});
