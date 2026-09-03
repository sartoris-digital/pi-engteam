import { describe, it, expect } from "vitest";
import { assertNarrowing, NarrowingError, narrowedKeysFor } from "../../../src/config/narrowing.js";
import type { RepoDefaults } from "../../../src/config/schema.js";

const upper: RepoDefaults = {
  sandbox: "required",
  steering: "always",
  planApproval: "elevated",
  maxDiffLines: 400,
  maxChangedFiles: 15,
  riskPaths: ["auth/**"],
  securityPaths: ["**/crypto/**"],
  exclusivePaths: ["infra/**"],
  generatedDocPatterns: ["**/PLAN.md"],
  writeRoots: {
    feature: ["src/**", "docs/**"],
    enhancement: ["src/**"],
    bug: ["src/**"],
    chore: ["src/**", "package.json"],
  },
};

describe("assertNarrowing", () => {
  it("names the key and the layer when a local overlay loosens steering", () => {
    let caught: unknown;
    try {
      assertNarrowing({ steering: "elevated" }, upper, "local");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NarrowingError);
    const err = caught as NarrowingError;
    expect(err.key).toBe("steering");
    expect(err.layer).toBe("local");
    expect(err.code).toBe("narrowing");
    expect(err.keyPath).toBe("steering");
    expect(err.message).toBe('config: layer "local" may not loosen "steering" (always → elevated)');
  });

  it("lets every layer keep or tighten steering and planApproval", () => {
    expect(() => assertNarrowing({ steering: "always", planApproval: "always" }, upper, "committed")).not.toThrow();
    expect(() => assertNarrowing({ steering: "always" }, upper, "overrides")).not.toThrow();
    expect(() => assertNarrowing({ planApproval: "never" }, upper, "committed")).toThrow(NarrowingError);
    expect(() => assertNarrowing({ planApproval: "never" }, upper, "local")).toThrow(
      'config: layer "local" may not loosen "planApproval" (elevated → never)',
    );
  });

  it("steering: never is only reachable when the layer above already says never", () => {
    expect(() => assertNarrowing({ steering: "never" }, { steering: "always" }, "committed")).toThrow(/"steering"/);
    expect(() => assertNarrowing({ steering: "never" }, { steering: "never" }, "committed")).not.toThrow();
    expect(() => assertNarrowing({ steering: "never" }, { steering: "always" }, "global")).not.toThrow();
  });

  it("layer 3 may widen roots, caps and lists; layers 4-5 may only tighten them", () => {
    const wider: RepoDefaults = {
      writeRoots: { chore: ["src/**", "package.json", "pnpm-lock.yaml"] },
      maxDiffLines: 800,
      riskPaths: [],
    };
    expect(() => assertNarrowing(wider, upper, "committed")).not.toThrow();
    expect(() => assertNarrowing({ maxDiffLines: 800 }, upper, "overrides")).toThrow(
      'config: layer "overrides" may not loosen "maxDiffLines" (400 → 800)',
    );
    expect(() => assertNarrowing({ maxChangedFiles: 16 }, upper, "local")).toThrow(/"maxChangedFiles"/);
    expect(() => assertNarrowing({ maxDiffLines: 200, maxChangedFiles: 5 }, upper, "local")).not.toThrow();
  });

  it("write roots may only shrink per kind at layers 4-5", () => {
    expect(() => assertNarrowing({ writeRoots: { chore: ["src/**"] } }, upper, "local")).not.toThrow();
    expect(() =>
      assertNarrowing({ writeRoots: { chore: ["src/**", "package.json", "infra/**"] } }, upper, "local"),
    ).toThrow('config: layer "local" may not loosen "writeRoots.chore" (adds "infra/**")');
  });

  it("risk, security, exclusive and generated-doc lists may only grow", () => {
    expect(() => assertNarrowing({ riskPaths: ["auth/**", "billing/**"] }, upper, "overrides")).not.toThrow();
    expect(() => assertNarrowing({ riskPaths: ["billing/**"] }, upper, "overrides")).toThrow(
      'config: layer "overrides" may not loosen "riskPaths" (drops "auth/**")',
    );
    expect(() => assertNarrowing({ securityPaths: [] }, upper, "local")).toThrow(/"securityPaths"/);
    expect(() => assertNarrowing({ exclusivePaths: [] }, upper, "local")).toThrow(/"exclusivePaths"/);
  });

  it("generatedDocPatterns can never shrink, not even in the operator's global defaults", () => {
    expect(() => assertNarrowing({ generatedDocPatterns: [] }, upper, "global")).toThrow(
      'config: layer "global" may not loosen "generatedDocPatterns" (drops "**/PLAN.md")',
    );
    expect(() => assertNarrowing({ generatedDocPatterns: ["**/PLAN.md", "**/*.ai.md"] }, upper, "global")).not.toThrow();
    expect(() => assertNarrowing({ generatedDocPatterns: [] }, upper, "committed")).toThrow(/"generatedDocPatterns"/);
  });

  it("sandbox may only move towards required from the committed layer on", () => {
    expect(() => assertNarrowing({ sandbox: "best-effort" }, upper, "local")).toThrow(
      'config: layer "local" may not loosen "sandbox" (required → best-effort)',
    );
    expect(() => assertNarrowing({ sandbox: "off" }, upper, "committed")).toThrow(/"sandbox"/);
    expect(() => assertNarrowing({ sandbox: "required" }, { sandbox: "best-effort" }, "local")).not.toThrow();
    expect(() => assertNarrowing({ sandbox: "off" }, upper, "global")).not.toThrow();
  });

  it("refuses to null-delete a safety key", () => {
    expect(() => assertNarrowing({ maxDiffLines: null }, upper, "local")).toThrow(
      'config: layer "local" may not loosen "maxDiffLines" (safety keys cannot be deleted with null)',
    );
    expect(() => assertNarrowing({ writeRoots: { bug: null } }, upper, "overrides")).toThrow(/"writeRoots\.bug"/);
    expect(() => assertNarrowing({ steering: null }, upper, "committed")).toThrow(/"steering"/);
  });

  it("ignores operational keys, unset upper values and the builtin layer entirely", () => {
    expect(() => assertNarrowing({ checksConcurrency: 8, stageTimeoutSeconds: 1 }, upper, "local")).not.toThrow();
    expect(() => assertNarrowing({ steering: "never", sandbox: "off" }, upper, "builtin")).not.toThrow();
    expect(() => assertNarrowing({ maxDiffLines: 9000 }, {}, "local")).not.toThrow();
    expect(narrowedKeysFor("committed")).toEqual(["steering", "planApproval", "sandbox", "generatedDocPatterns"]);
    expect(narrowedKeysFor("builtin")).toEqual([]);
    expect(narrowedKeysFor("local")).toHaveLength(10);
  });
});
