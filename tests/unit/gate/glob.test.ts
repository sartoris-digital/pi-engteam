import { describe, it, expect } from "vitest";
import { globToRegExp, matchGlob, matchesAny, normalizeRelPath } from "../../../src/gate/glob.js";

describe("normalizeRelPath", () => {
  it("strips ./ and leading slashes and converts backslashes", () => {
    expect(normalizeRelPath("./docs/PLAN.md")).toBe("docs/PLAN.md");
    expect(normalizeRelPath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeRelPath("src\\win\\a.ts")).toBe("src/win/a.ts");
  });
});

describe("matchGlob", () => {
  it("** at the start matches zero or more leading segments", () => {
    expect(matchGlob("PLAN.md", "**/PLAN.md")).toBe(true);
    expect(matchGlob("docs/PLAN.md", "**/PLAN.md")).toBe(true);
    expect(matchGlob("a/b/c/PLAN.md", "**/PLAN.md")).toBe(true);
    expect(matchGlob("docs/PLAN.mdx", "**/PLAN.md")).toBe(false);
  });

  it("dir/** matches everything under the dir but not siblings or the dir itself", () => {
    expect(matchGlob("src/a/b.ts", "src/**")).toBe(true);
    expect(matchGlob("src/a.ts", "src/**")).toBe(true);
    expect(matchGlob("src", "src/**")).toBe(false);
    expect(matchGlob("srcx/a.ts", "src/**")).toBe(false);
  });

  it("a/**/b matches zero or more middle segments", () => {
    expect(matchGlob("a/b", "a/**/b")).toBe(true);
    expect(matchGlob("a/x/b", "a/**/b")).toBe(true);
    expect(matchGlob("a/x/y/b", "a/**/b")).toBe(true);
    expect(matchGlob("a/xb", "a/**/b")).toBe(false);
  });

  it("* never crosses a segment boundary", () => {
    expect(matchGlob("src/b.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(matchGlob("notes.ai.md", "**/*.ai.md")).toBe(true);
    expect(matchGlob("x/y/notes.ai.md", "**/*.ai.md")).toBe(true);
  });

  it("? matches exactly one non-slash character", () => {
    expect(matchGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchGlob("a12.ts", "a?.ts")).toBe(false);
    expect(matchGlob("a/.ts", "a?.ts")).toBe(false);
  });

  it("{a,b} alternation works and alternatives are globs", () => {
    expect(matchGlob("vitest.config.ts", "vitest.{config,workspace}.*")).toBe(true);
    expect(matchGlob("vitest.workspace.mjs", "vitest.{config,workspace}.*")).toBe(true);
    expect(matchGlob("jest.config.ts", "vitest.{config,workspace}.*")).toBe(false);
    expect(matchGlob("tests/unit/a.test.ts", "tests/**/*.{test,spec}.ts")).toBe(true);
  });

  it("regex metacharacters in globs are literal", () => {
    expect(matchGlob("a+b.ts", "a+b.ts")).toBe(true);
    expect(matchGlob("aab.ts", "a+b.ts")).toBe(false);
    expect(matchGlob("file.ts", "file.ts")).toBe(true);
    expect(matchGlob("filexts", "file.ts")).toBe(false);
  });

  it("spec patterns for dotfiles and local overlays", () => {
    expect(matchGlob(".pi/factory.local.json", ".pi/*.local.*")).toBe(true);
    expect(matchGlob(".pi/factory.json", ".pi/*.local.*")).toBe(false);
    expect(matchGlob(".pi/factory-rules.local.yaml", ".pi/factory-rules*.yaml")).toBe(true);
    expect(matchGlob(".omc/specs/x.md", ".omc/**")).toBe(true);
  });
});

describe("matchesAny / globToRegExp", () => {
  it("normalizes the path before matching", () => {
    expect(matchesAny("./.omc/specs/x.md", [".omc/**"])).toBe(true);
    expect(matchesAny("src/a.ts", [".omc/**", "docs/**"])).toBe(false);
    expect(matchesAny("src/a.ts", [])).toBe(false);
  });

  it("returns an anchored RegExp", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.source.startsWith("^")).toBe(true);
    expect(re.source.endsWith("$")).toBe(true);
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("xsrc/a.ts")).toBe(false);
  });
});
