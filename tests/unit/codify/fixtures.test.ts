import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoFixtureEdits,
  materialiseFixtures,
} from "../../../src/codify/fixtures.js";
import { repoMirrorDir, sealedDir, stagingDir, toolDir } from "../../../src/codify/layout.js";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { withTmpHome } from "../../helpers/tmp-home.js";

describe("layout", () => {
  it("is the only path builder for codified files", () => {
    expect(stagingDir("/h", "id-1")).toBe(join("/h", "codified", ".staging", "id-1"));
    expect(sealedDir("/h", "bump-package-version")).toBe(join("/h", "codified", "_sealed", "bump-package-version"));
    expect(toolDir("/h", "bump-package-version")).toBe(join("/h", "codified", "tools", "bump-package-version"));
    expect(repoMirrorDir("/repo", "bump-package-version")).toBe(join("/repo", ".pi", "codified", "bump-package-version"));
  });
});

describe("assertNoFixtureEdits", () => {
  it("fails when expected.* changes and allows a non-expected negative case", () => {
    const before = new Map<string, string>([
      ["expected.patch", "PATCH-A\n"],
      ["before/package.json", "{}\n"],
    ]);
    const afterOk = new Map<string, string>([
      ["expected.patch", "PATCH-A\n"],
      ["before/package.json", "{}\n"],
      ["negative.json", "{\"ok\":false}\n"],
    ]);
    expect(assertNoFixtureEdits(before, afterOk)).toEqual({ ok: true, edited: [] });

    const afterBad = new Map<string, string>([
      ["expected.patch", "PATCH-TAMPERED\n"],
      ["before/package.json", "{}\n"],
      ["negative.json", "{\"ok\":false}\n"],
    ]);
    const bad = assertNoFixtureEdits(before, afterBad);
    expect(bad.ok).toBe(false);
    expect(bad.edited).toContain("expected.patch");
  });
});

describe("materialiseFixtures", () => {
  it("splits K members into ceil(K/2) dev and the rest sealed, strips deny globs, and writes expected.patch", async () => {
    await withTmpHome(async (home) => {
      const fx = await makeFixtureRepo();
      try {
        await writeFile(join(fx.repo, ".env"), "SECRET=do-not-copy\n", "utf8");
        await fx.git(["add", ".env"]);
        await fx.git(["commit", "-q", "-m", "add env"]);
        const sha = (await fx.git(["rev-parse", "HEAD"])).stdout.trim();

        const result = await materialiseFixtures({
          home,
          name: "bump-package-version",
          stagingId: "stage-1",
          members: [
            {
              repo: fx.repo,
              parentSha: sha,
              expectedPatch: "PATCH-A\n",
              input: { pkg: "fixture-app", version: "1.1.0" },
            },
            {
              repo: fx.repo,
              parentSha: sha,
              expectedPatch: "PATCH-B\n",
              input: { pkg: "fixture-app", version: "1.2.0" },
            },
          ],
          readGlobs: ["package.json", "src/**", ".env"],
          denyGlobs: [".env"],
        });

        expect(result.dev).toHaveLength(1);
        expect(result.sealed).toHaveLength(1);

        const devRoot = result.dev[0]!;
        const sealedRoot = result.sealed[0]!;
        expect(devRoot.startsWith(join(stagingDir(home, "stage-1"), "fixtures", "dev"))).toBe(true);
        expect(sealedRoot.startsWith(sealedDir(home, "bump-package-version"))).toBe(true);
        expect(sealedRoot.includes(".staging")).toBe(false);
        expect((await stat(sealedDir(home, "bump-package-version"))).mode & 0o077).toBe(0);

        expect(await readFile(join(devRoot, "expected.patch"), "utf8")).toBe("PATCH-A\n");
        expect(await readFile(join(sealedRoot, "expected.patch"), "utf8")).toBe("PATCH-B\n");
        expect(JSON.parse(await readFile(join(devRoot, "input.json"), "utf8"))).toEqual({
          pkg: "fixture-app",
          version: "1.1.0",
        });

        await expect(stat(join(devRoot, "before", "package.json"))).resolves.toMatchObject({ isFile: expect.any(Function) });
        await expect(stat(join(devRoot, "before", ".env"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(join(sealedRoot, "before", ".env"))).rejects.toMatchObject({ code: "ENOENT" });

        const before = new Map<string, string>([["expected.patch", await readFile(join(devRoot, "expected.patch"), "utf8")]]);
        await writeFile(join(devRoot, "negative.json"), "{\"ok\":false}\n", "utf8");
        const afterAllowed = new Map(before);
        afterAllowed.set("negative.json", "{\"ok\":false}\n");
        expect(assertNoFixtureEdits(before, afterAllowed).ok).toBe(true);
      } finally {
        await fx.cleanup();
      }
    });
  });
});
