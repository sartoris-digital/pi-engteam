import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseLearnArgs, discoverGapFiles } from "../../../src/commands/learn.js";

describe("parseLearnArgs", () => {
  it("returns empty object for no args", () => {
    expect(parseLearnArgs("")).toEqual({});
    expect(parseLearnArgs("   ")).toEqual({});
  });

  it("captures the first whitespace-separated token as runId", () => {
    expect(parseLearnArgs("run-abc123")).toEqual({ runId: "run-abc123" });
  });

  it("ignores trailing tokens", () => {
    expect(parseLearnArgs("run-abc  extra  noise")).toEqual({ runId: "run-abc" });
  });
});

describe("discoverGapFiles", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "learn-cmd-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true }).catch(() => {});
  });

  it("returns nothing when no run dirs exist", async () => {
    const out = await discoverGapFiles(runsDir);
    expect(out).toEqual([]);
  });

  it("with no runId, finds gaps.jsonl across every run dir", async () => {
    for (const r of ["run-1", "run-2", "run-3"]) {
      await mkdir(join(runsDir, r, "learning"), { recursive: true });
    }
    await writeFile(join(runsDir, "run-1", "learning", "gaps.jsonl"), "");
    await writeFile(join(runsDir, "run-3", "learning", "gaps.jsonl"), "");
    const out = await discoverGapFiles(runsDir);
    expect(out.sort()).toEqual([
      join(runsDir, "run-1", "learning", "gaps.jsonl"),
      join(runsDir, "run-3", "learning", "gaps.jsonl"),
    ].sort());
  });

  it("with a runId, returns only that run's gaps file (or empty if missing)", async () => {
    await mkdir(join(runsDir, "run-1", "learning"), { recursive: true });
    await writeFile(join(runsDir, "run-1", "learning", "gaps.jsonl"), "");
    expect(await discoverGapFiles(runsDir, "run-1")).toEqual([
      join(runsDir, "run-1", "learning", "gaps.jsonl"),
    ]);
    expect(await discoverGapFiles(runsDir, "run-missing")).toEqual([]);
  });

  it("ignores run dirs that do not contain a learning/gaps.jsonl", async () => {
    await mkdir(join(runsDir, "run-empty"), { recursive: true });
    expect(await discoverGapFiles(runsDir)).toEqual([]);
  });
});
