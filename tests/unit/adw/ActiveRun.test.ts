import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;

async function withCwd(dir: string, fn: () => Promise<void>) {
  const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("ActiveRun", () => {
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("readActiveRun returns null when file does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { readActiveRun } = await import("../../../src/adw/ActiveRun.js");
    await withCwd(tmpDir, async () => {
      const result = await readActiveRun();
      expect(result).toBeNull();
    });
  });

  it("writeActiveRun then readActiveRun returns the written state", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { writeActiveRun, readActiveRun } = await import("../../../src/adw/ActiveRun.js");
    const state = { runId: "run-abc", phase: "approving" as const, stepName: "design", runsDir: "/tmp/runs" };
    await withCwd(tmpDir, async () => {
      await writeActiveRun(state);
      const result = await readActiveRun();
      expect(result).toEqual(state);
    });
  });

  it("clearActiveRun removes the file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { writeActiveRun, readActiveRun, clearActiveRun } = await import("../../../src/adw/ActiveRun.js");
    const state = { runId: "run-abc", phase: "answering" as const, stepName: "discover", runsDir: "/tmp/runs" };
    await withCwd(tmpDir, async () => {
      await writeActiveRun(state);
      await clearActiveRun();
      const result = await readActiveRun();
      expect(result).toBeNull();
    });
  });

  it("clearActiveRun does not throw when file is absent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-run-test-"));
    const { clearActiveRun } = await import("../../../src/adw/ActiveRun.js");
    await withCwd(tmpDir, async () => {
      await expect(clearActiveRun()).resolves.toBeUndefined();
    });
  });
});
