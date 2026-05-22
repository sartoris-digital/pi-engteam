import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ARTIFACT_REGISTRY,
  rollbackReadiness,
  migrateDown,
  LEGACY_SCHEMA_VERSION,
} from "../../../src/team/schema-versioning.js";

describe("schema-versioning", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "schema-versioning-"));
  });

  // --- ARTIFACT_REGISTRY ---

  it("ARTIFACT_REGISTRY has no duplicate paths", () => {
    const paths = ARTIFACT_REGISTRY.map(a => a.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  // --- rollbackReadiness ---

  it("returns safe=true when only byte-compatible artifacts exist", () => {
    // Create only byte-compatible artifacts
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ runId: "r1", status: "succeeded" }));
    writeFileSync(join(runDir, "events.jsonl"), "");

    const result = rollbackReadiness(runDir, LEGACY_SCHEMA_VERSION);
    expect(result.safe).toBe(true);
    expect(result.incompatibleArtifacts).toHaveLength(0);
  });

  it("returns safe=false and lists _verdicts/ when side-car present", () => {
    // Create a side-car directory
    mkdirSync(join(runDir, "_verdicts"), { recursive: true });
    writeFileSync(join(runDir, "_verdicts", "some-verdict.json"), "{}");

    const result = rollbackReadiness(runDir, LEGACY_SCHEMA_VERSION);
    expect(result.safe).toBe(false);
    expect(result.incompatibleArtifacts).toContain("_verdicts/");
  });

  it("lists all present side-car artifacts as incompatible", () => {
    mkdirSync(join(runDir, "_verdicts"), { recursive: true });
    mkdirSync(join(runDir, "_activity"), { recursive: true });
    writeFileSync(join(runDir, "state.v2.json"), "{}");
    writeFileSync(join(runDir, "feature-decisions.json"), "{}");

    const result = rollbackReadiness(runDir, LEGACY_SCHEMA_VERSION);
    expect(result.safe).toBe(false);
    expect(result.incompatibleArtifacts).toContain("_verdicts/");
    expect(result.incompatibleArtifacts).toContain("_activity/");
    expect(result.incompatibleArtifacts).toContain("state.v2.json");
    expect(result.incompatibleArtifacts).toContain("feature-decisions.json");
  });

  it("returns the runId equal to the basename of runDir", () => {
    const result = rollbackReadiness(runDir, LEGACY_SCHEMA_VERSION);
    expect(result.runId).toBe(runDir.split("/").at(-1));
  });

  it("returns safe=true for an unknown targetVersion", () => {
    mkdirSync(join(runDir, "_verdicts"), { recursive: true });
    const result = rollbackReadiness(runDir, "1.0.x");
    expect(result.safe).toBe(true);
  });

  // --- migrateDown ---

  it("removes side-car dirs and files", () => {
    mkdirSync(join(runDir, "_verdicts"), { recursive: true });
    writeFileSync(join(runDir, "_verdicts", "v.json"), "{}");
    writeFileSync(join(runDir, "state.v2.json"), "{}");
    writeFileSync(join(runDir, "state.json"), "{}");

    const result = migrateDown(runDir);

    expect(result.removed).toContain("_verdicts/");
    expect(result.removed).toContain("state.v2.json");
    expect(result.errors).toHaveLength(0);

    expect(existsSync(join(runDir, "_verdicts"))).toBe(false);
    expect(existsSync(join(runDir, "state.v2.json"))).toBe(false);
    // byte-compatible file must survive
    expect(existsSync(join(runDir, "state.json"))).toBe(true);
  });

  it("preserves byte-compatible artifacts", () => {
    writeFileSync(join(runDir, "state.json"), "{}");
    writeFileSync(join(runDir, "events.jsonl"), "");

    const result = migrateDown(runDir);

    expect(result.preserved).toContain("state.json");
    expect(result.preserved).toContain("events.jsonl");
    expect(existsSync(join(runDir, "state.json"))).toBe(true);
    expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);
  });

  it("migrateDown({ dryRun: true }) lists but does not remove", () => {
    mkdirSync(join(runDir, "_verdicts"), { recursive: true });
    writeFileSync(join(runDir, "_verdicts", "v.json"), "{}");
    writeFileSync(join(runDir, "state.v2.json"), "{}");

    const result = migrateDown(runDir, { dryRun: true });

    expect(result.removed).toContain("_verdicts/");
    expect(result.removed).toContain("state.v2.json");
    // Files must still exist — dry run must not remove anything
    expect(existsSync(join(runDir, "_verdicts"))).toBe(true);
    expect(existsSync(join(runDir, "state.v2.json"))).toBe(true);
  });

  it("migrateDown returns empty removed when no side-cars present", () => {
    writeFileSync(join(runDir, "state.json"), "{}");

    const result = migrateDown(runDir);

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
