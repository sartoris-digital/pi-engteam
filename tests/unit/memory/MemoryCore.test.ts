import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockExtensionAPI } from "../../helpers/mockPi.js";

vi.mock("../../../src/memory/spawnFlush.js", () => ({
  spawnFlush: vi.fn(),
  ensureScriptsInstalled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/memory/snapshot.js", () => ({
  writeSnapshot: vi.fn().mockResolvedValue("/tmp/pi-flush-test.json"),
}));

const mockGenerateNarrative = vi.fn().mockResolvedValue("test narrative");

const CONFIG = {
  obsidianDailyNotesSubdir: "Daily",
  maxConversationTurns: 20,
  flushModel: "claude-haiku-4-5-20251001",
} as const;

describe("MemoryCore", () => {
  let runsDir = "";
  let brainDir = "";

  beforeEach(async () => {
    runsDir = await import("fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "memory-core-")));
    brainDir = await import("fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "memory-brain-")));
    vi.clearAllMocks();
  });

  it("captures PASS verdicts into a deduped run cache", async () => {
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
      generateNarrative: mockGenerateNarrative,
    });

    const runId = "run-abc";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(
      join(runsDir, runId, "state.json"),
      JSON.stringify({
        runId,
        workflow: "spec-plan-build-review",
        goal: "Add dark mode",
        artifacts: { plan: "plan.md", theme: "src/ui/Theme.tsx" },
      }),
      "utf8",
    );

    core.onVerdict(runId, { step: "build", verdict: "PASS", artifacts: ["build.md"] });
    core.onVerdict(runId, { step: "review", verdict: "PASS", artifacts: ["review.md"] });

    // LOW-3: use vi.waitFor instead of a fixed sleep — deterministic, not flaky
    await vi.waitFor(() => {
      const cache = core.getRunCache();
      expect(cache).toHaveLength(1);
    });

    const cache = core.getRunCache();
    expect(cache[0].workflow).toBe("spec-plan-build-review");
    expect(cache[0].goal).toBe("Add dark mode");
    expect(cache[0].verdict).toBe("PASS");
    expect(cache[0].artifacts).toEqual(expect.arrayContaining(["build.md", "review.md", "plan.md"]));
    expect(cache[0].changedFiles).toEqual(expect.arrayContaining(["src/ui/Theme.tsx"]));
  });

  it("ignores NEEDS_MORE verdicts", async () => {
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
    });

    core.onVerdict("run-1", { step: "plan", verdict: "NEEDS_MORE" });
    // Give any accidental async work time to settle
    await vi.waitFor(() => expect(core.getRunCache()).toHaveLength(0));
  });

  it("captures ABORTED runs via onRunAborted", async () => {
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
    });

    const runId = "run-abort";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(
      join(runsDir, runId, "state.json"),
      JSON.stringify({ runId, workflow: "debug", goal: "Fix crash", artifacts: {} }),
      "utf8",
    );

    core.onRunAborted(runId);
    await vi.waitFor(() => {
      const cache = core.getRunCache();
      expect(cache).toHaveLength(1);
    });

    const cache = core.getRunCache();
    expect(cache[0].verdict).toBe("ABORTED");
    expect(cache[0].workflow).toBe("debug");
  });

  it("registers session hooks and flushes using the session transcript path", async () => {
    const { writeSnapshot } = await import("../../../src/memory/snapshot.js");
    const { spawnFlush, ensureScriptsInstalled } = await import("../../../src/memory/spawnFlush.js");
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");

    const logDir = join(brainDir, "logs");
    const lastFlushPath = join(brainDir, ".last-flush");

    const core = new MemoryCore(CONFIG, runsDir, {
      logDir,
      lastFlushPath,
      generateNarrative: mockGenerateNarrative,
    });
    const pi = new MockExtensionAPI();

    await core.register(pi.asPi());
    expect(ensureScriptsInstalled).toHaveBeenCalled();

    await pi.trigger("session_start", {}, {
      sessionManager: { getSessionFile: () => "/tmp/pi-session.jsonl" },
    });

    await pi.trigger("session_before_compact", {}, {});

    expect(writeSnapshot).toHaveBeenCalledWith(
      expect.any(String),
      [],
      CONFIG,
      "test narrative",  // narrative is now generated in-process, not transcriptPath
      logDir,
      lastFlushPath,  // HIGH-6: sentinelPath is now explicit 6th arg
    );
    expect(spawnFlush).toHaveBeenCalledWith("/tmp/pi-flush-test.json");

    await core.destroy();  // CRITICAL-3: destroy is now async
  });

  it("does not load extension hooks when ensureScriptsInstalled fails", async () => {
    const { ensureScriptsInstalled } = await import("../../../src/memory/spawnFlush.js");
    vi.mocked(ensureScriptsInstalled).mockRejectedValueOnce(new Error("scripts missing"));

    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
    });
    const pi = new MockExtensionAPI();

    // CRITICAL-1: register must not throw even if script install fails
    await expect(core.register(pi.asPi())).resolves.toBeUndefined();
  });

  it("accumulates wisdom fields from multiple verdicts across steps for the same run", async () => {
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
      generateNarrative: mockGenerateNarrative,
    });

    const runId = "run-wisdom";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(
      join(runsDir, runId, "state.json"),
      JSON.stringify({
        runId,
        workflow: "plan-build-review",
        goal: "Add rate limiting",
        artifacts: {},
      }),
      "utf8",
    );

    core.onVerdict(runId, {
      step: "build",
      verdict: "PASS",
      learnings: ["express-rate-limit uses in-memory store by default"],
      gotchas: ["RateLimitInfo headers only set when standardHeaders: true"],
    });
    core.onVerdict(runId, {
      step: "review",
      verdict: "PASS",
      decisions: ["Chose sliding window over fixed window"],
      learnings: ["Use Redis store for multi-instance deployments"],
    });

    await vi.waitFor(() => {
      const cache = core.getRunCache();
      expect(cache[0]?.wisdom?.learnings).toHaveLength(2);
    });

    const run = core.getRunCache()[0];
    expect(run.wisdom.learnings).toContain("express-rate-limit uses in-memory store by default");
    expect(run.wisdom.learnings).toContain("Use Redis store for multi-instance deployments");
    expect(run.wisdom.decisions).toContain("Chose sliding window over fixed window");
    expect(run.wisdom.gotchas).toContain("RateLimitInfo headers only set when standardHeaders: true");
    expect(run.wisdom.issues_found).toEqual([]);
  });

  it("initializes empty wisdom for aborted runs", async () => {
    const { MemoryCore } = await import("../../../src/memory/MemoryCore.js");
    const core = new MemoryCore(CONFIG, runsDir, {
      logDir: join(brainDir, "logs"),
      lastFlushPath: join(brainDir, ".last-flush"),
      generateNarrative: mockGenerateNarrative,
    });

    const runId = "run-aborted-wisdom";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(
      join(runsDir, runId, "state.json"),
      JSON.stringify({ runId, workflow: "investigate", goal: "Fix login bug", artifacts: {} }),
      "utf8",
    );

    core.onRunAborted(runId);

    await vi.waitFor(() => {
      expect(core.getRunCache()).toHaveLength(1);
    });

    const run = core.getRunCache()[0];
    expect(run.verdict).toBe("ABORTED");
    expect(run.wisdom).toEqual({ learnings: [], decisions: [], issues_found: [], gotchas: [] });
  });
});
