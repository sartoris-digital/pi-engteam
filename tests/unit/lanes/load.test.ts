import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaneLoadError, loadLaneLayers } from "../../../src/lanes/load.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lanes-load-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function write(name: string, text: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, text);
  return p;
}

describe("loadLaneLayers", () => {
  it("parses a complete built-in-shaped file", async () => {
    const p = await write(
      "lanes.yaml",
      "schemaVersion: 1\nlanes:\n  chore:\n    match: { kind: chore }\n    priority: 100\n    budget: { fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 8 }\n    stages:\n      - { name: plan, agent: planner }\n",
    );
    const layers = await loadLaneLayers([p]);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.path).toBe(p);
    expect(layers[0]?.file.schemaVersion).toBe(1);
    expect(layers[0]?.file.lanes.chore?.match).toEqual({ kind: "chore" });
    expect(layers[0]?.file.lanes.chore?.stages[0]).toMatchObject({ name: "plan", agent: "planner" });
  });

  it("skips missing paths and keeps existing files in input order", async () => {
    const a = await write("a.yaml", "schemaVersion: 1\nlanes:\n  a:\n    priority: 1\n");
    const c = await write("c.yaml", "schemaVersion: 1\nlanes:\n  c:\n    priority: 3\n");
    const layers = await loadLaneLayers([a, join(dir, "missing.yaml"), c]);
    expect(layers.map((l) => l.path)).toEqual([a, c]);
    expect(await loadLaneLayers([])).toEqual([]);
    expect(await loadLaneLayers([join(dir, "nope.yaml")])).toEqual([]);
  });

  it("rejects schemaVersion other than 1", async () => {
    const p = await write("v2.yaml", "schemaVersion: 2\nlanes: {}\n");
    await expect(loadLaneLayers([p])).rejects.toThrow(LaneLoadError);
  });

  it("wraps invalid YAML in LaneLoadError naming the path", async () => {
    const p = await write("bad.yaml", "lanes: [\n  - :\n");
    try {
      await loadLaneLayers([p]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LaneLoadError);
      expect((err as LaneLoadError).path).toBe(p);
      expect((err as Error).message).toMatch(/YAML|parse|bad/i);
    }
  });

  it("accepts a patch layer (incomplete lane) and rejects unknown keys", async () => {
    const patch = await write("patch.yaml", "schemaVersion: 1\nlanes:\n  bug:\n    stages:\n      - { name: judge, remove: true }\n");
    const layers = await loadLaneLayers([patch]);
    expect(layers[0]?.file.lanes.bug?.stages).toEqual([{ name: "judge", remove: true }]);
    const unk = await write("unk.yaml", "schemaVersion: 1\nlanes:\n  bug:\n    flavour: spicy\n");
    await expect(loadLaneLayers([unk])).rejects.toThrow(LaneLoadError);
  });
});
