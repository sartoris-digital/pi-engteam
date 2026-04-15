import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const { appendOrReplaceSession, buildSessionEntry } = await import(
  "../../../src/assets/second-brain/scripts/lib/logWriter.mjs"
);

const RUN = {
  runId: "abc123def",
  workflow: "spec-plan-build-review",
  goal: "Add dark mode",
  verdict: "PASS",
  changedFiles: ["src/ui/Theme.tsx"],
};

describe("buildSessionEntry", () => {
  it("produces the expected markdown structure", () => {
    const entry = buildSessionEntry("sess-1", "2026-04-15T14:32:00Z", [RUN], "Session went well.");

    expect(entry).toContain("## Session sess-1");
    expect(entry).toContain("### Runs");
    expect(entry).toContain("### Changed Files");
    expect(entry).toContain("### Summary");
    expect(entry).toContain("Session went well.");
    expect(entry).toContain("src/ui/Theme.tsx");
    expect(entry).toContain("14:32");
    expect(entry.trimEnd()).toMatch(/---$/);
  });

  it("shows a placeholder when there are no runs", () => {
    const entry = buildSessionEntry("sess-empty", "2026-04-15T10:00:00Z", [], "Nothing done.");

    expect(entry).toContain("_No runs completed_");
    expect(entry).toContain("_No files changed_");
  });

  it("deduplicates changed files across runs", () => {
    const runs = [
      { ...RUN, changedFiles: ["src/a.ts", "src/b.ts"] },
      { ...RUN, runId: "xyz987", changedFiles: ["src/b.ts", "src/c.ts"] },
    ];

    const entry = buildSessionEntry("sess-dup", "2026-04-15T10:00:00Z", runs, "Done.");

    expect(entry.match(/src\/b\.ts/g)).toHaveLength(1);
  });
});

describe("appendOrReplaceSession", () => {
  let logDir = "";

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "memory-logwriter-"));
  });

  it("creates the log file with a header when it does not exist", async () => {
    const logPath = join(logDir, "2026-04-15.md");
    await appendOrReplaceSession(logPath, "s1", buildSessionEntry("s1", "2026-04-15T10:00:00Z", [], "First."));

    const content = await readFile(logPath, "utf8");
    expect(content).toContain("# Daily Log: 2026-04-15");
    expect(content).toContain("## Session s1");
  });

  it("appends a second session entry", async () => {
    const logPath = join(logDir, "2026-04-15.md");
    await appendOrReplaceSession(logPath, "s1", buildSessionEntry("s1", "2026-04-15T10:00:00Z", [], "First."));
    await appendOrReplaceSession(logPath, "s2", buildSessionEntry("s2", "2026-04-15T11:00:00Z", [], "Second."));

    const content = await readFile(logPath, "utf8");
    expect(content).toContain("## Session s1");
    expect(content).toContain("## Session s2");
  });

  it("replaces an existing session block instead of duplicating it", async () => {
    const logPath = join(logDir, "2026-04-15.md");
    await appendOrReplaceSession(
      logPath,
      "s1",
      buildSessionEntry("s1", "2026-04-15T10:00:00Z", [], "First version."),
    );
    await appendOrReplaceSession(
      logPath,
      "s1",
      buildSessionEntry("s1", "2026-04-15T10:05:00Z", [], "Updated version."),
    );

    const content = await readFile(logPath, "utf8");
    expect(content).toContain("Updated version.");
    expect(content).not.toContain("First version.");
    expect(content.match(/## Session s1/g)).toHaveLength(1);
  });

  it("creates parent directories when they are missing", async () => {
    const logPath = join(logDir, "nested", "2026-04-15.md");
    await appendOrReplaceSession(logPath, "s1", buildSessionEntry("s1", "2026-04-15T10:00:00Z", [], "Test."));

    const content = await readFile(logPath, "utf8");
    expect(content).toContain("## Session s1");
  });
});
