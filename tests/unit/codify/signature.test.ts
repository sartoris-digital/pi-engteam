import { describe, expect, it } from "vitest";
import { commandShape, diffShape, pathShape, stageSignature } from "../../../src/codify/signature.js";
import { versionBumpExecution } from "../../helpers/codify-cluster.js";

describe("pathShape", () => {
  it("encodes digits as # and slug/monorepo package roots as *", () => {
    expect(pathShape("packages/foo-bar/src/v2/file-12.ts")).toBe("packages/*/src/v#/file-#.ts");
  });
});

describe("commandShape", () => {
  it("replaces digit runs and path segments with the same encoding", () => {
    expect(commandShape(["npm", "version", "1.2.3"])).toBe("npm version #.#.#");
    expect(commandShape(["git", "add", "packages/foo-bar/src/v2/file-12.ts"])).toBe(
      "git add packages/*/src/v#/file-#.ts",
    );
  });
});

describe("diffShape", () => {
  it("is stable across sourced literal values so version bumps cluster", () => {
    const files = [
      { path: "package.json", op: "M" as const, hunkLines: 2 },
      { path: "package-lock.json", op: "M" as const, hunkLines: 8 },
    ];
    const a = diffShape({ files, literals: ["1.2.3"], sourced: ["1.2.3"] });
    const b = diffShape({ files, literals: ["2.0.0"], sourced: ["2.0.0"] });
    expect(a).toBe(b);
    expect(a).toContain("M:");
    expect(a).toContain("$src");
  });
});

describe("stageSignature", () => {
  it("is sha256 hex of the canonical stage/mode/kind/lane/shapes tuple", () => {
    const a = stageSignature(versionBumpExecution({ runId: "r1" }));
    const b = stageSignature(versionBumpExecution({ runId: "r2", title: "Bump widgets to 9.9.9" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    const otherLane = stageSignature(versionBumpExecution({ lane: "enhancement", kind: "enhancement" }));
    expect(otherLane).not.toBe(a);
    const otherStage = stageSignature(versionBumpExecution({ stage: "fix" }));
    expect(otherStage).not.toBe(a);
  });
});
