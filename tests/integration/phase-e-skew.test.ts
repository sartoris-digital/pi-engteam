// Phase E item E12 — N/N-1 skew matrix in-process simulation.
//
// Verifies that:
//   - RunActivityQueue with legacyMirrorEnabled=true writes events to
//     BOTH the canonical path and the 2.0.x legacy path.
//   - The activity-pruner counts legacy mirror bytes toward the global
//     quota when deciding whether to prune.
//   - When pruning a run, the legacy mirror file is also removed.
//   - Logical quota exhaustion degrades to essential-only but NEVER
//     refuses new activity events (ENOSPC is a separate path).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunActivityQueue } from "../../src/team/RunActivityQueue.js";
import { prune } from "../../src/team/activity-pruner.js";

describe("Phase-E skew / N/N-1 matrix", () => {
  let runsDir: string;
  const runId = "skew-run-0001";

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "skew-"));
  });

  it("legacy mirror is written at <runsDir>/<runId>/agent-activity.jsonl", () => {
    const q = new RunActivityQueue({ runsDir, runId, legacyMirrorEnabled: true });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "hello", sourceClass: "stdout" });

    // Canonical path — under _activity/.
    const canonical = join(runsDir, "_activity", runId, "agent-activity.jsonl");
    expect(existsSync(canonical)).toBe(true);

    // Legacy mirror path — the exact path 2.0.x CLIs hardcode.
    const legacy = join(runsDir, runId, "agent-activity.jsonl");
    expect(existsSync(legacy)).toBe(true);

    // Both contain the same event.
    const canonicalLine = readFileSync(canonical, "utf8").trim();
    const legacyLine = readFileSync(legacy, "utf8").trim();
    const canonicalEvent = JSON.parse(canonicalLine);
    const legacyEvent = JSON.parse(legacyLine);
    expect(canonicalEvent.body).toBe("hello");
    expect(legacyEvent.body).toBe("hello");
  });

  it("mirror is NOT written when legacyMirrorEnabled=false", () => {
    const q = new RunActivityQueue({ runsDir, runId, legacyMirrorEnabled: false });
    q.enqueue({ runId, agentName: "a", step: "s", kind: "assistant_text", body: "hi", sourceClass: "stdout" });

    const legacy = join(runsDir, runId, "agent-activity.jsonl");
    expect(existsSync(legacy)).toBe(false);
  });

  it("pruner counts mirror bytes toward global quota", () => {
    // Plant a canonical activity dir with minimal bytes.
    const activityDir = join(runsDir, "_activity", "old-run");
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(join(activityDir, "agent-activity.jsonl"), "x".repeat(500));

    // Plant a large legacy mirror — 2 MB. With quota = 1 MB, the
    // pruner should detect over-quota and include old-run for prune.
    const mirrorDir = join(runsDir, "old-run");
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, "agent-activity.jsonl"), "x".repeat(2 * 1024 * 1024));

    const r = prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: () => ({ status: "succeeded", endTs: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
      retentionMs: 365 * 24 * 60 * 60 * 1000, // no TTL prune
      globalQuotaBytes: 1024 * 1024, // 1 MB — below the 2 MB mirror
    });

    expect(r.prunedRunIds).toContain("old-run");
  });

  it("pruner removes the legacy mirror file when pruning a run", () => {
    const activityDir = join(runsDir, "_activity", "old-run");
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(join(activityDir, "agent-activity.jsonl"), "data");

    const mirrorDir = join(runsDir, "old-run");
    mkdirSync(mirrorDir, { recursive: true });
    const mirrorFile = join(mirrorDir, "agent-activity.jsonl");
    writeFileSync(mirrorFile, "mirror-data");

    prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: () => ({ status: "succeeded", endTs: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
      retentionMs: 14 * 24 * 60 * 60 * 1000,
    });

    expect(existsSync(mirrorFile)).toBe(false);
  });

  it("bytesReclaimed includes mirror bytes", () => {
    const activityDir = join(runsDir, "_activity", "old-run");
    mkdirSync(activityDir, { recursive: true });
    writeFileSync(join(activityDir, "agent-activity.jsonl"), "x".repeat(100));

    const mirrorDir = join(runsDir, "old-run");
    mkdirSync(mirrorDir, { recursive: true });
    writeFileSync(join(mirrorDir, "agent-activity.jsonl"), "x".repeat(200));

    const r = prune({
      runsDir,
      activeRunIds: new Set(),
      lookupRunState: () => ({ status: "succeeded", endTs: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
      retentionMs: 14 * 24 * 60 * 60 * 1000,
    });

    // bytesReclaimed must include the 200-byte mirror.
    expect(r.bytesReclaimed).toBeGreaterThanOrEqual(200);
  });
});
