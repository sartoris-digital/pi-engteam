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

  it("includes Wisdom section for runs with non-empty wisdom arrays", () => {
    const runWithWisdom = {
      ...RUN,
      wisdom: {
        learnings: ["express-rate-limit uses in-memory store by default"],
        decisions: ["Chose sliding window over fixed window"],
        issues_found: [] as string[],
        gotchas: ["RateLimitInfo headers only set when standardHeaders: true"],
      },
    };

    const entry = buildSessionEntry("sess-wisdom", "2026-04-15T14:32:00Z", [runWithWisdom], "Done.");

    expect(entry).toContain("### Wisdom");
    expect(entry).toContain("**Learnings**");
    expect(entry).toContain("express-rate-limit uses in-memory store by default");
    expect(entry).toContain("**Decisions**");
    expect(entry).toContain("Chose sliding window over fixed window");
    expect(entry).toContain("**Gotchas**");
    expect(entry).toContain("RateLimitInfo headers only set when standardHeaders: true");
    // empty array → category omitted
    expect(entry).not.toContain("**Issues Found**");
  });

  it("omits Wisdom section entirely when all wisdom arrays are empty", () => {
    const runNoWisdom = {
      ...RUN,
      wisdom: { learnings: [] as string[], decisions: [] as string[], issues_found: [] as string[], gotchas: [] as string[] },
    };
    const entry = buildSessionEntry("sess-no-wisdom", "2026-04-15T14:32:00Z", [runNoWisdom], "Done.");
    expect(entry).not.toContain("### Wisdom");
  });

  it("omits Wisdom section when wisdom field is absent on all runs", () => {
    const entry = buildSessionEntry("sess-no-field", "2026-04-15T14:32:00Z", [RUN], "Done.");
    expect(entry).not.toContain("### Wisdom");
  });

  it("Wisdom section appears between Changed Files and Summary", () => {
    const runWithWisdom = {
      ...RUN,
      wisdom: {
        learnings: ["something learned"],
        decisions: [] as string[],
        issues_found: [] as string[],
        gotchas: [] as string[],
      },
    };
    const entry = buildSessionEntry("sess-order", "2026-04-15T14:32:00Z", [runWithWisdom], "Summary text.");
    const wisdomPos = entry.indexOf("### Wisdom");
    const summaryPos = entry.indexOf("### Summary");
    const changedFilesPos = entry.indexOf("### Changed Files");
    expect(changedFilesPos).toBeLessThan(wisdomPos);
    expect(wisdomPos).toBeLessThan(summaryPos);
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
