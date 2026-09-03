import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHandoff, type Handoff } from "../../../src/git/handoff.js";

const sample = (): Handoff => ({
  ref: "github:acme/widgets#123",
  runId: "run-0001",
  lane: "bug",
  branch: "factory/github-123-fix-slug",
  baseSha: "a".repeat(40),
  judgedSha: "b".repeat(40),
  hostCommits: ["b".repeat(40)],
  patchIds: [],
  changedFiles: ["src/foo.ts"],
  writeGlobs: ["src/**"],
  prUrl: "https://github.com/acme/widgets/pull/9",
  publishedAt: "2026-09-02T10:00:00.000Z",
});

describe("writeHandoff", () => {
  it("writes handoff.json with the spec §6.5 keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "handoff-"));
    try {
      const h = sample();
      const path = await writeHandoff(dir, h);
      expect(path).toBe(join(dir, "handoff.json"));
      const raw = JSON.parse(await readFile(path, "utf8")) as Handoff;
      expect(raw).toEqual(h);
      expect(Object.keys(raw).sort()).toEqual(
        [
          "baseSha",
          "branch",
          "changedFiles",
          "hostCommits",
          "judgedSha",
          "lane",
          "patchIds",
          "prUrl",
          "publishedAt",
          "ref",
          "runId",
          "writeGlobs",
        ].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
