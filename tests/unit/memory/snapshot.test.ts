import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { writeSnapshot } from "../../../src/memory/snapshot.js";
import type { CompletedRun, MemoryConfig } from "../../../src/types.js";

const CONFIG: MemoryConfig = {
  obsidianDailyNotesSubdir: "Daily",
  maxConversationTurns: 20,
  flushModel: "claude-haiku-4-5-20251001",
};

const RUN: CompletedRun = {
  runId: "abc123",
  workflow: "spec-plan-build-review",
  goal: "Add dark mode",
  verdict: "PASS",
  artifacts: ["plan.md"],
  changedFiles: ["src/ui/Theme.tsx"],
  completedAt: "2026-04-15T14:32:00Z",
  wisdom: { learnings: [], decisions: [], issues_found: [], gotchas: [] },
};

describe("writeSnapshot", () => {
  it("writes JSON file to the temp directory and returns the path", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "memory-log-"));
    const sentinel = join(logDir, ".last-flush");
    const path = await writeSnapshot("sess-1", [RUN], CONFIG, "test narrative", logDir, sentinel);

    expect(path).toContain("pi-flush-sess-1.json");

    const snapshot = JSON.parse(await readFile(path, "utf8"));
    expect(snapshot.sessionId).toBe("sess-1");
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0].runId).toBe("abc123");
    expect(snapshot.narrative).toBe("test narrative");
    expect(snapshot.logDir).toBe(logDir);
    expect(snapshot.sentinelPath).toBe(sentinel);
  });

  it("handles an empty run cache", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "memory-log-"));
    const sentinel = join(logDir, ".last-flush");
    const path = await writeSnapshot("sess-empty", [], CONFIG, "test narrative", logDir, sentinel);

    const snapshot = JSON.parse(await readFile(path, "utf8"));
    expect(snapshot.runs).toEqual([]);
  });

  it("includes obsidianVaultPath when configured", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "memory-log-"));
    const path = await writeSnapshot(
      "sess-vault",
      [],
      { ...CONFIG, obsidianVaultPath: "/vault" },
      "test narrative",
      logDir,
      join(logDir, ".last-flush"),
    );

    const snapshot = JSON.parse(await readFile(path, "utf8"));
    expect(snapshot.obsidianVaultPath).toBe("/vault");
  });

  it("omits obsidianVaultPath when not configured", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "memory-log-"));
    const path = await writeSnapshot(
      "sess-no-vault",
      [],
      CONFIG,
      "test narrative",
      logDir,
      join(logDir, ".last-flush"),
    );

    const snapshot = JSON.parse(await readFile(path, "utf8"));
    expect(snapshot.obsidianVaultPath).toBeUndefined();
    expect(snapshot.obsidianDailyNotesSubdir).toBe("Daily");
  });
});
