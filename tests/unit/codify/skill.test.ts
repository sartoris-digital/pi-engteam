import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderSkill, writeSkill, type SkillManifest } from "../../../src/codify/skill.js";

const manifest: SkillManifest = {
  name: "bump-package-version",
  version: 1,
  class: "stage-tool",
  purpose: "Bump a package version from title inputs without rewriting the manifest by hand.",
  whenNot: ["the ticket is not a version bump", "lockfile-only companion edits are out of scope"],
  inputs: [
    { name: "pkg", type: "identifier", provenance: "title:", description: "Package name to bump" },
    { name: "version", type: "semver", provenance: "title:", description: "Target semver" },
    { name: "date", type: "shortText", provenance: "host:today", description: "Changelog date" },
  ],
};

describe("renderSkill", () => {
  it("includes purpose, whenNot, inputs, and frontmatter pi-sdlc-factory-codified", () => {
    const md = renderSkill(manifest);
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("pi-sdlc-factory-codified: true");
    expect(md).toContain(manifest.purpose);
    expect(md).toContain("the ticket is not a version bump");
    expect(md).toContain("`pkg` (identifier)");
    expect(md).toContain("Package name to bump");
    expect(md).toContain("`version` (semver)");
    expect(md).toContain("name: bump-package-version");
  });

  it("throws when purpose exceeds 240 characters", () => {
    expect(() => renderSkill({ ...manifest, purpose: "x".repeat(241) })).toThrow(/240/);
  });
});

describe("writeSkill", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("overwrites an agent-written SKILL.md", async () => {
    dir = await mkdtemp(join(tmpdir(), "codify-skill-"));
    const path = join(dir, "SKILL.md");
    await writeFile(path, "# agent wrote this\nDo not keep me.\n", "utf8");
    const written = await writeSkill(dir, manifest);
    expect(written).toBe(path);
    const body = await readFile(path, "utf8");
    expect(body).not.toContain("agent wrote this");
    expect(body).toBe(renderSkill(manifest));
    expect(body).toContain("pi-sdlc-factory-codified: true");
  });
});
