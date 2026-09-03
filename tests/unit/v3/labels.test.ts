import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendLabel, countByKind, labelsPath, readLabels } from "../../../src/v3/labels.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

describe("labels.jsonl store", () => {
  it("appends human labels and countByKind increments per kind", async () => {
    await withTmpHome(async (home) => {
      await appendLabel({ ref: "github:acme/widgets#1", kind: "bug", confirmedBy: "ada", source: "human" }, home);
      await appendLabel({
        ref: "github:acme/widgets#2",
        kind: "chore",
        confirmedBy: "ada",
        source: "human",
      }, home);
      const counts = await countByKind(labelsPath(home));
      expect(counts).toEqual({ feature: 0, enhancement: 0, bug: 1, chore: 1 });
      const rows = await readLabels(home);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.source === "human")).toBe(true);
    });
  });

  it("ignores source: model lines in countByKind", async () => {
    await withTmpHome(async (home) => {
      const path = labelsPath(home);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(
        path,
        [
          JSON.stringify({ ts: "2026-09-03T00:00:00.000Z", ref: "r1", kind: "bug", confirmedBy: "ada", source: "human" }),
          JSON.stringify({ ts: "2026-09-03T00:00:01.000Z", ref: "r2", kind: "bug", confirmedBy: "setfit", source: "model" }),
          JSON.stringify({ ts: "2026-09-03T00:00:02.000Z", ref: "r3", kind: "feature", confirmedBy: "ada", source: "human" }),
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      const counts = await countByKind(path);
      expect(counts.bug).toBe(1);
      expect(counts.feature).toBe(1);
      expect(counts.enhancement).toBe(0);
      expect(counts.chore).toBe(0);
    });
  });

  it("concurrent appends do not tear JSONL", async () => {
    await withTmpHome(async (home) => {
      const writes = Array.from({ length: 20 }, (_, i) =>
        appendLabel(
          {
            ts: `2026-09-03T00:00:${String(i).padStart(2, "0")}.000Z`,
            ref: `local-${i}`,
            kind: i % 2 === 0 ? "bug" : "chore",
            confirmedBy: "ada",
            source: "human",
          },
          home,
        ),
      );
      await Promise.all(writes);
      const raw = await readFile(labelsPath(home), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(20);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect(raw.endsWith("\n")).toBe(true);
      const counts = await countByKind(labelsPath(home));
      expect(counts.bug + counts.chore).toBe(20);
    });
  });

  it("countByKind is fail-closed on a missing file", async () => {
    await withTmpHome(async (home) => {
      const counts = await countByKind(join(home, "missing.jsonl"));
      expect(counts).toEqual({ feature: 0, enhancement: 0, bug: 0, chore: 0 });
    });
  });
});
