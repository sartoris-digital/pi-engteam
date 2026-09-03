import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaneInvariantError } from "../../../src/lanes/index.js";
import { BUILTIN_LANES_PATH, LaneLoadError, loadEffectiveLanes } from "../../../src/lanes/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lanes-repo-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function repoFile(name: string, text: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, text);
  return p;
}

async function violation(paths: string[]): Promise<LaneInvariantError> {
  try {
    await loadEffectiveLanes(paths);
  } catch (err) {
    if (err instanceof LaneInvariantError) return err;
    throw err;
  }
  throw new Error("expected LaneInvariantError");
}

describe("loadEffectiveLanes with a repo layer", () => {
  it("returns the built-ins when no override layer exists", async () => {
    const lanes = await loadEffectiveLanes([BUILTIN_LANES_PATH, join(dir, "missing.yaml")]);
    expect(Object.keys(lanes).sort()).toEqual(["bug", "chore", "enhancement", "feature", "grill"]);
  });

  it("rejects a repo lane file that removes the judge", async () => {
    const p = await repoFile("factory-lanes.yaml", "schemaVersion: 1\nlanes:\n  bug:\n    stages:\n      - { name: judge, remove: true }\n");
    const err = await violation([BUILTIN_LANES_PATH, p]);
    expect(err.errors).toContainEqual(expect.objectContaining({ lane: "bug", stage: "judge", rule: "locked-removed" }));
    expect(err.errors.map((e) => e.rule)).toContain("judge-missing");
    expect(err.message).toContain("[bug/judge] locked-removed");
  });

  it("rejects a repo lane file that removes steer, loosens the budget or drops a gate", async () => {
    const p = await repoFile(
      "factory-lanes.yaml",
      [
        "schemaVersion: 1",
        "lanes:",
        "  chore:",
        "    budget: { fixRounds: 5 }",
        "    stages:",
        "      - { name: steer, remove: true }",
        "      - { name: review, gates: [citations] }",
        "",
      ].join("\n"),
    );
    const rules = (await violation([BUILTIN_LANES_PATH, p])).errors.map((e) => e.rule);
    expect(rules).toContain("locked-removed");
    expect(rules).toContain("budget-loosened");
    expect(rules).toContain("gates-removed");
  });

  it("rejects a repo lane that collides with a built-in at equal priority", async () => {
    const p = await repoFile(
      "factory-lanes.yaml",
      "schemaVersion: 1\nlanes:\n  bug2:\n    extends: bug\n    match: { kind: bug }\n    priority: 100\n",
    );
    const rules = (await violation([BUILTIN_LANES_PATH, p])).errors.map((e) => e.rule);
    expect(rules).toEqual(["match-overlap"]);
  });

  it("accepts the spec §4.8 hotfix lane and a local layer that only tightens", async () => {
    const repo = await repoFile(
      "factory-lanes.yaml",
      [
        "schemaVersion: 1",
        "lanes:",
        "  hotfix:",
        "    extends: bug",
        "    match: { kind: bug, labels: [hotfix] }",
        "    priority: 10",
        "    budget: { fixRounds: 2, maxWallSeconds: 2700 }",
        "    stages:",
        "      - { name: diagnose, remove: true }",
        "      - { name: security, when: \"true\" }",
        "      - { name: implement, model: B }",
        "    publish: { draft: false, target: release/current, titleTemplate: \"hotfix: {title} ({ref})\" }",
        "",
      ].join("\n"),
    );
    const local = await repoFile(
      "factory-lanes.local.yaml",
      "schemaVersion: 1\nlanes:\n  bug:\n    budget: { maxCostUsd: 15 }\n    stages:\n      - { name: review, gates: [citations, verdict-consistent, scope-report, checklist] }\n",
    );
    const lanes = await loadEffectiveLanes([BUILTIN_LANES_PATH, repo, local]);
    expect(lanes.hotfix?.stages.map((s) => s.name)).toEqual(["plan", "gate", "steer", "implement", "test", "review", "security", "judge", "publish"]);
    expect(lanes.hotfix?.budget).toEqual({ fixRounds: 2, maxWallSeconds: 2700, maxCostUsd: 20 });
    expect(lanes.bug?.budget.maxCostUsd).toBe(15);
    expect(lanes.bug?.stages.find((s) => s.name === "review")?.gates).toContain("checklist");
  });

  it("requires the built-in file first", async () => {
    await expect(loadEffectiveLanes([join(dir, "nope.yaml")])).rejects.toThrow(LaneLoadError);
    await expect(loadEffectiveLanes([])).rejects.toThrow(LaneLoadError);
  });
});
