import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { finalize, changedFilesSince, diffLineCount } from "../../../src/gate/finalize.js";
import { generatedMarkerLine } from "../../../src/gate/generated-docs.js";
import type { Workspace } from "../../../src/workspace/types.js";

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "user.name=factory-test", "-c", "user.email=factory-test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

function wsFor(path: string): Workspace {
  return { provider: "git", path, branch: "main", baseSha: "", repoRoot: path, gitCommonDir: join(path, ".git"), configSha: "" };
}

let fx: Awaited<ReturnType<typeof makeFixtureRepo>>;
let ws: Workspace;
let base = "";

beforeEach(async () => {
  fx = await makeFixtureRepo();
  ws = wsFor(fx.repo);
  await mkdir(join(fx.repo, "lib"), { recursive: true });
  await mkdir(join(fx.repo, "spec-tests"), { recursive: true });
  await writeFile(join(fx.repo, "lib/alpha.ts"), "export const alpha = 1;\n", "utf8");
  await writeFile(join(fx.repo, "spec-tests/alpha.test.ts"), `it("AC1", () => {});\n`, "utf8");
  await git(fx.repo, "add", "lib/alpha.ts", "spec-tests/alpha.test.ts");
  await git(fx.repo, "commit", "-m", "test: baseline");
  base = await git(fx.repo, "rev-parse", "HEAD");

  await writeFile(join(fx.repo, "lib/alpha.ts"), "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n", "utf8"); // +2
  await writeFile(join(fx.repo, "lib/beta.ts"), "l1\nl2\nl3\n", "utf8"); // untracked, 3 lines
  await mkdir(join(fx.repo, "docs"), { recursive: true });
  await writeFile(join(fx.repo, "docs/PLAN.md"), `${generatedMarkerLine("run-1")}\n`, "utf8"); // untracked, 1 line
});

afterEach(async () => {
  await fx.cleanup();
});

describe("changedFilesSince / diffLineCount", () => {
  it("lists modified tracked files and untracked files since the base commit", async () => {
    expect(await changedFilesSince(ws, base)).toEqual(["docs/PLAN.md", "lib/alpha.ts", "lib/beta.ts"]);
  });

  it("counts added+deleted lines for tracked changes plus untracked file lines", async () => {
    expect(await diffLineCount(ws, base)).toBe(6);
  });

  it("includes a deleted tracked file in the change list", async () => {
    await rm(join(fx.repo, "spec-tests/alpha.test.ts"));
    expect(await changedFilesSince(ws, base)).toContain("spec-tests/alpha.test.ts");
    expect(await diffLineCount(ws, base)).toBe(7);
  });
});

describe("finalize", () => {
  const limits = { maxDiffLines: 100, maxChangedFiles: 10 };

  it("reports scope and generated-doc violations", async () => {
    const r = await finalize({ ws, baseSha: base, writeRoots: ["lib/**"], ...limits });
    expect(r.ok).toBe(false);
    expect(r.scope.changedFiles).toEqual(["docs/PLAN.md", "lib/alpha.ts", "lib/beta.ts"]);
    expect(r.scope.inScope).toEqual(["lib/alpha.ts", "lib/beta.ts"]);
    expect(r.scope.outOfScope).toEqual(["docs/PLAN.md"]);
    expect(r.scope.generatedDocs).toEqual(["docs/PLAN.md"]);
    expect(r.scope.diffLines).toBe(6);
    expect(r.violations.map((v) => v.code)).toEqual(["scope-violation", "generated-doc"]);
    expect(r.violations[0]?.paths).toEqual(["docs/PLAN.md"]);
    expect(r.detail).toContain("scope-violation");
  });

  it("is ok once the generated doc is removed and everything is inside the roots", async () => {
    await rm(join(fx.repo, "docs/PLAN.md"));
    const r = await finalize({ ws, baseSha: base, writeRoots: ["lib/**"], ...limits });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.scope.diffLines).toBe(5);
    expect(r.detail).toBe("2 changed file(s), 5 diff line(s), all inside write roots");
  });

  it("flags too-large on either limit with the numbers in the detail", async () => {
    await rm(join(fx.repo, "docs/PLAN.md"));
    const lines = await finalize({ ws, baseSha: base, writeRoots: ["lib/**"], maxDiffLines: 3, maxChangedFiles: 10 });
    expect(lines.ok).toBe(false);
    expect(lines.violations).toEqual([{ code: "too-large", paths: [], detail: "5 diff lines > 3" }]);

    const files = await finalize({ ws, baseSha: base, writeRoots: ["lib/**"], maxDiffLines: 100, maxChangedFiles: 1 });
    expect(files.violations).toEqual([{ code: "too-large", paths: [], detail: "2 changed files > 1" }]);
  });

  it("honours custom generated-doc patterns", async () => {
    const r = await finalize({ ws, baseSha: base, writeRoots: ["**"], generatedDocPatterns: ["lib/beta.ts"], ...limits });
    expect(r.scope.generatedDocs).toEqual(["docs/PLAN.md", "lib/beta.ts"]);
  });
});
