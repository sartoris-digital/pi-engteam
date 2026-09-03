import { describe, it, expect } from "vitest";
import { Check } from "typebox/value";
import {
  FactoryConfigSchema,
  KINDS,
  LAYER_ORDER,
  RepoDefaultsSchema,
  RepoFileSchema,
  TrackerEntrySchema,
} from "../../../src/config/schema.js";

describe("config schemas", () => {
  it("accepts a minimal global file", () => {
    expect(Check(FactoryConfigSchema, { schemaVersion: 1 })).toBe(true);
    expect(Check(FactoryConfigSchema, { schemaVersion: 2 })).toBe(false);
    expect(Check(FactoryConfigSchema, {})).toBe(false);
  });

  it("accepts every tracker kind the adapters use and nothing else", () => {
    for (const kind of ["github", "azure-devops", "jira"]) {
      expect(Check(TrackerEntrySchema, { id: "t", kind })).toBe(true);
    }
    expect(Check(TrackerEntrySchema, { id: "t", kind: "gitlab" })).toBe(false);
    expect(Check(TrackerEntrySchema, { id: "t", kind: "azure_devops" })).toBe(false);
    expect(Check(TrackerEntrySchema, { kind: "github" })).toBe(false);
  });

  it("rejects unknown keys on every object", () => {
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, operatr: {} })).toBe(false);
    expect(Check(RepoDefaultsSchema, { branching: { prTarget: "main" } })).toBe(false);
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, repos: [{ path: "/a", overides: {} }] })).toBe(false);
  });

  it("accepts null on overlay leaves (delete marker) but not on blocks", () => {
    expect(Check(RepoDefaultsSchema, { setupCommand: null, maxDiffLines: null, writeRoots: { bug: null } })).toBe(true);
    expect(Check(RepoDefaultsSchema, { branching: null })).toBe(false);
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, operator: { fusion: null } })).toBe(false);
  });

  it("repo file = schemaVersion + repo-scope keys at the top level", () => {
    expect(
      Check(RepoFileSchema, {
        schemaVersion: 1,
        steering: "elevated",
        checks: [{ name: "unit", argv: ["pnpm", "test"], reporter: "junit" }],
      }),
    ).toBe(true);
    expect(Check(RepoFileSchema, { schemaVersion: 1, defaults: { steering: "always" } })).toBe(false);
    expect(Check(RepoFileSchema, { schemaVersion: 1, steering: "sometimes" })).toBe(false);
  });

  it("validates typed leaves", () => {
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, operator: { maxLanes: 0 } })).toBe(false);
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, operator: { maxLanes: 3, workers: "auto" } })).toBe(true);
    expect(Check(RepoDefaultsSchema, { sandbox: "best-effort", planApproval: "never" })).toBe(true);
    expect(Check(RepoDefaultsSchema, { sandbox: "disabled" })).toBe(false);
    expect(Check(RepoDefaultsSchema, { checks: [{ name: "unit", argv: [], reporter: "junit" }] })).toBe(false);
  });

  it("enumerates layers in merge order and the four kinds", () => {
    expect(LAYER_ORDER).toEqual(["builtin", "global", "committed", "overrides", "local"]);
    expect(KINDS).toEqual(["feature", "enhancement", "bug", "chore"]);
  });

  it("accepts operator.codify.eligibility landed and published", () => {
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, operator: { codify: { eligibility: "landed" } } })).toBe(true);
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, operator: { codify: { eligibility: "published" } } })).toBe(true);
    expect(Check(FactoryConfigSchema, { schemaVersion: 1, operator: { codify: { eligibility: "draft" } } })).toBe(false);
  });
});
