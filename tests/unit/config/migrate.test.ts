import { describe, it, expect } from "vitest";
import { migrateConfig, migrateRepoFile } from "../../../src/config/migrate.js";
import { ConfigError } from "../../../src/config/errors.js";

function fail(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("migrateConfig (schemaVersion 1)", () => {
  it("passes a valid v1 global file through untouched", () => {
    const raw = {
      schemaVersion: 1,
      operator: { maxLanes: 4, trackers: [{ id: "gh", kind: "github", label: "factory:ready" }] },
      defaults: { steering: "elevated", writeRoots: { chore: ["src/**"] } },
      repos: [{ path: "/w/app", remote: "origin", overrides: { maxDiffLines: 200 }, lanes: { x: 1 } }],
    };
    expect(migrateConfig(raw)).toEqual(raw);
  });

  it("requires schemaVersion and refuses versions this build does not know", () => {
    const missing = fail(() => migrateConfig({}));
    expect(missing.code).toBe("version");
    expect(missing.message).toBe('factory.json: missing "schemaVersion" (expected 1)');
    const future = fail(() => migrateConfig({ schemaVersion: 2 }, "/home/op/.pi/sdlc-factory/factory.json"));
    expect(future.code).toBe("version");
    expect(future.message).toBe(
      "/home/op/.pi/sdlc-factory/factory.json: unsupported schemaVersion 2 (this build reads 1)",
    );
    expect(future.file).toBe("/home/op/.pi/sdlc-factory/factory.json");
  });

  it("rejects unknown keys and names the full key path", () => {
    expect(fail(() => migrateConfig({ schemaVersion: 1, operatr: {} })).message).toBe(
      'factory.json: unknown key "operatr"',
    );
    const nested = fail(() => migrateConfig({ schemaVersion: 1, defaults: { branching: { prTarget: "main" } } }));
    expect(nested.code).toBe("unknown-key");
    expect(nested.keyPath).toBe("defaults.branching.prTarget");
    expect(nested.message).toBe('factory.json: unknown key "defaults.branching.prTarget"');
    expect(
      fail(() => migrateConfig({ schemaVersion: 1, repos: [{ path: "/a" }, { path: "/b", overides: {} }] })).message,
    ).toBe('factory.json: unknown key "repos[1].overides"');
    expect(
      fail(() =>
        migrateConfig({ schemaVersion: 1, operator: { trackers: [{ id: "t", kind: "jira", allowedAuthor: [] }] } }),
      ).keyPath,
    ).toBe("operator.trackers[0].allowedAuthor");
  });

  it("accepts only github | azure-devops | jira as trackers[].kind", () => {
    for (const kind of ["github", "azure-devops", "jira"]) {
      expect(() => migrateConfig({ schemaVersion: 1, operator: { trackers: [{ id: "t", kind }] } })).not.toThrow();
    }
    const bad = fail(() => migrateConfig({ schemaVersion: 1, operator: { trackers: [{ id: "t", kind: "gitlab" }] } }));
    expect(bad.code).toBe("schema");
    expect(bad.message).toMatch(/^factory\.json: invalid value at "operator\.trackers/);
  });

  it("reports other schema violations with their path", () => {
    const bad = fail(() => migrateConfig({ schemaVersion: 1, operator: { maxLanes: "three" } }));
    expect(bad.code).toBe("schema");
    expect(bad.message).toMatch(/^factory\.json: invalid value at "operator\.maxLanes/);
  });

  it("rejects non-object input", () => {
    expect(fail(() => migrateConfig([])).code).toBe("parse");
    expect(fail(() => migrateConfig("x")).code).toBe("parse");
  });
});

describe("migrateRepoFile", () => {
  it("accepts repo-scope keys at the top level next to schemaVersion", () => {
    const raw = {
      schemaVersion: 1,
      steering: "always",
      checks: [{ name: "unit", argv: ["pnpm", "test"], reporter: "junit" }],
      setupCommand: null,
    };
    expect(migrateRepoFile(raw)).toEqual(raw);
  });

  it("does not accept the global file's blocks", () => {
    expect(fail(() => migrateRepoFile({ schemaVersion: 1, defaults: {} }, "/w/app/.pi/factory.json")).message).toBe(
      '/w/app/.pi/factory.json: unknown key "defaults"',
    );
    expect(fail(() => migrateRepoFile({ steering: "always" })).message).toBe(
      '.pi/factory.json: missing "schemaVersion" (expected 1)',
    );
  });
});
