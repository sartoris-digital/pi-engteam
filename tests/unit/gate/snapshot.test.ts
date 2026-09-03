import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { snapshotTree, diffSnapshots, diffOutsideRoots, listWorkingTree, sha256File } from "../../../src/gate/snapshot.js";
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

beforeEach(async () => {
  fx = await makeFixtureRepo();
  ws = wsFor(fx.repo);
  await mkdir(join(fx.repo, "lib"), { recursive: true });
  await writeFile(join(fx.repo, "lib/alpha.ts"), "export const alpha = 1;\n", "utf8");
  await git(fx.repo, "add", "lib/alpha.ts");
  await git(fx.repo, "commit", "-m", "test: add lib/alpha.ts");
  await appendFile(join(fx.repo, ".gitignore"), "ignored.log\n", "utf8");
  await writeFile(join(fx.repo, "ignored.log"), "noise\n", "utf8");
  await writeFile(join(fx.repo, "scratch-notes.txt"), "untracked\n", "utf8");
});

afterEach(async () => {
  await fx.cleanup();
});

describe("sha256File", () => {
  it("hashes file content", async () => {
    const p = join(fx.repo, "lib/alpha.ts");
    const first = await sha256File(p);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(p, "export const alpha = 2;\n", "utf8");
    expect(await sha256File(p)).not.toBe(first);
  });
});

describe("listWorkingTree / snapshotTree", () => {
  it("lists tracked and untracked files, honours .gitignore and skips .git", async () => {
    const files = await listWorkingTree(ws);
    expect(files).toContain("lib/alpha.ts");
    expect(files).toContain("scratch-notes.txt");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain("ignored.log");
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
    expect([...files].sort()).toEqual(files);

    const snap = await snapshotTree(ws);
    expect(Object.keys(snap.files)).toEqual(files);
    expect(snap.files["lib/alpha.ts"]).toBe(await sha256File(join(fx.repo, "lib/alpha.ts")));
    expect(Number.isNaN(Date.parse(snap.at))).toBe(false);
  });

  it("omits a tracked file that was deleted from the working tree", async () => {
    await rm(join(fx.repo, "lib/alpha.ts"));
    const snap = await snapshotTree(ws);
    expect(snap.files["lib/alpha.ts"]).toBeUndefined();
  });
});

describe("diffSnapshots / diffOutsideRoots", () => {
  it("reports added, removed and changed paths, and those outside the roots", async () => {
    const before = await snapshotTree(ws);

    await writeFile(join(fx.repo, "lib/alpha.ts"), "export const alpha = 2;\n", "utf8"); // unstaged edit
    await writeFile(join(fx.repo, "lib/beta.ts"), "export const beta = 1;\n", "utf8"); // new in roots
    await rm(join(fx.repo, "scratch-notes.txt")); // removed outside roots
    await mkdir(join(fx.repo, "notes"), { recursive: true });
    await writeFile(join(fx.repo, "notes/x.md"), "# x\n", "utf8"); // new outside roots

    const after = await snapshotTree(ws);
    const diff = diffSnapshots(before, after);
    expect(diff.added).toEqual(["lib/beta.ts", "notes/x.md"]);
    expect(diff.removed).toEqual(["scratch-notes.txt"]);
    expect(diff.changed).toEqual(["lib/alpha.ts"]);

    expect(diffOutsideRoots(before, after, ["lib/**"])).toEqual(["notes/x.md", "scratch-notes.txt"]);
    expect(diffOutsideRoots(before, after, ["lib/**", "notes/**", "scratch-notes.txt"])).toEqual([]);
    expect(diffOutsideRoots(before, after, [])).toEqual(["lib/alpha.ts", "lib/beta.ts", "notes/x.md", "scratch-notes.txt"]);
  });

  it("is empty when nothing changed", async () => {
    const before = await snapshotTree(ws);
    const after = await snapshotTree(ws);
    expect(diffSnapshots(before, after)).toEqual({ added: [], removed: [], changed: [] });
    expect(diffOutsideRoots(before, after, ["lib/**"])).toEqual([]);
  });
});
