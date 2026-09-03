import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { rawGit } from "../../helpers/raw-git.js";
import { GitWorktreeProvider, WorkspaceRemoveRefusedError } from "../../../src/workspace/git-provider.js";
import type { Workspace } from "../../../src/workspace/types.js";
import { DEFAULT_V3_POLICY } from "../../../src/v3/dispatch.js";
import {
  consensus,
  createSiblings,
  removeSiblings,
  runBestOfN,
  type AstParser,
} from "../../../src/v3/best-of-n.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function fakeWs(over: Partial<Workspace> = {}): Workspace {
  return {
    provider: "git",
    path: "/tmp/ws-primary",
    branch: "factory/local-1",
    baseSha: "a".repeat(40),
    repoRoot: "/tmp/repo",
    gitCommonDir: "/tmp/repo/.git",
    configSha: "c".repeat(64),
    ...over,
  };
}

/** Fixture parser: strip comments + collapse whitespace for JS/TS; ignore positions. */
const FIXTURE_PARSER: AstParser = {
  fingerprint(source, filePath) {
    if (!/\.(?:ts|tsx|js|jsx)$/.test(filePath)) return null;
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
  },
};

async function siblingSetup() {
  const f = await makeFixtureRepo();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "factory-home-")));
  cleanups.push(f.cleanup, () => rm(home, { recursive: true, force: true }));
  const provider = new GitWorktreeProvider({ home, lockTimeoutMs: 10_000 });
  const primary = await provider.create({
    repoRoot: f.repo,
    branch: "factory/local-1-add-readme",
    base: "main",
    slug: "local-1-add-readme",
    lockReason: "factory:local-1",
  });
  return { ...f, home, provider, primary };
}

describe("createSiblings", () => {
  it("creates n worktrees under worktrees/ at baseSha and leaves primary.path untouched", async () => {
    const { home, provider, primary } = await siblingSetup();
    const primaryPath = primary.path;
    const siblings = await createSiblings(primary, 2, "bon", { provider });
    expect(siblings).toHaveLength(2);
    expect(siblings[0]?.path).not.toBe(siblings[1]?.path);
    expect(siblings[0]?.path).not.toBe(primary.path);
    expect(siblings[0]?.path.startsWith(path.join(home, "worktrees"))).toBe(true);
    expect(siblings[1]?.path.startsWith(path.join(home, "worktrees"))).toBe(true);
    expect(await rawGit(siblings[0]!.path, "rev-parse", "HEAD")).toBe(primary.baseSha);
    expect(await rawGit(siblings[1]!.path, "rev-parse", "HEAD")).toBe(primary.baseSha);
    expect(siblings[0]?.gitCommonDir).toBe(primary.gitCommonDir);
    expect(siblings[0]?.branch).toBe(`${primary.branch}-bon-0`);
    expect(siblings[1]?.branch).toBe(`${primary.branch}-bon-1`);
    expect(primary.path).toBe(primaryPath);
    expect(await rawGit(primary.path, "rev-parse", "HEAD")).toBe(primary.baseSha);
  });

  it("refuses to remove a dirty sibling and does not touch the primary tree", async () => {
    const { provider, primary } = await siblingSetup();
    const siblings = await createSiblings(primary, 1, "bon", { provider });
    await writeFile(path.join(siblings[0]!.path, "dirty.txt"), "nope\n");
    await expect(removeSiblings(siblings, { provider })).rejects.toBeInstanceOf(WorkspaceRemoveRefusedError);
    expect(await rawGit(siblings[0]!.path, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(await rawGit(primary.path, "status", "--porcelain")).toBe("");
  });
});

describe("consensus", () => {
  it("treats trivia-only JS/TS diffs as ast-equal via the injected parser", () => {
    const a = 'export const x = 1;\n';
    const b = "export const x = 1; // trailing\n\n";
    const result = consensus(
      [
        { id: "A", files: { "src/a.ts": a } },
        { id: "B", files: { "src/a.ts": b } },
      ],
      { parser: FIXTURE_PARSER },
    );
    expect(result.method).toBe("ast-equal");
    expect(result.discarded).toEqual([]);
    expect(result.files["src/a.ts"]).toBe(a);
    expect(result.winner).toBe("A");
  });

  it("falls back to candidate 0 on a real logic difference and names the loser", () => {
    const result = consensus(
      [
        { id: "A", files: { "src/a.ts": "export const x = 1;\n" } },
        { id: "B", files: { "src/a.ts": "export const x = 2;\n" } },
      ],
      { parser: FIXTURE_PARSER },
    );
    expect(result.method).toBe("fallback-first");
    expect(result.discarded).toEqual(["B"]);
    expect(result.files["src/a.ts"]).toBe("export const x = 1;\n");
    expect(result.winner).toBe("A");
  });

  it("uses 2-of-3 majority and discards the minority", () => {
    const result = consensus(
      [
        { id: "A", files: { "src/a.ts": "export const x = 1;\n" } },
        { id: "B", files: { "src/a.ts": "export const x = 9;\n" } },
        { id: "C", files: { "src/a.ts": "export const x = 1;\n" } },
      ],
      { parser: FIXTURE_PARSER },
    );
    expect(result.method).toBe("majority");
    expect(result.discarded).toEqual(["B"]);
    expect(result.files["src/a.ts"]).toBe("export const x = 1;\n");
    expect(result.winner).toBe("A");
  });

  it("normalizes non-TS files by whitespace and otherwise takes first", () => {
    const equal = consensus([
      { id: "A", files: { "README.md": "hello   world\n" } },
      { id: "B", files: { "README.md": "hello world" } },
    ]);
    expect(equal.method).toBe("ast-equal");
    expect(equal.discarded).toEqual([]);

    const diff = consensus([
      { id: "A", files: { "README.md": "alpha" } },
      { id: "B", files: { "README.md": "beta" } },
    ]);
    expect(diff.method).toBe("fallback-first");
    expect(diff.discarded).toEqual(["B"]);
    expect(diff.files["README.md"]).toBe("alpha");
  });

  it("throws on empty candidates", () => {
    expect(() => consensus([])).toThrow(/candidate/i);
  });

  it("calls the injected parser for JS/TS paths", () => {
    const seen: string[] = [];
    const parser: AstParser = {
      fingerprint(source, filePath) {
        seen.push(filePath);
        return "same";
      },
    };
    const result = consensus(
      [
        { id: "A", files: { "src/x.ts": "alpha" } },
        { id: "B", files: { "src/x.ts": "beta" } },
      ],
      { parser },
    );
    expect(seen).toEqual(["src/x.ts", "src/x.ts"]);
    expect(result.method).toBe("ast-equal");
  });
});

describe("runBestOfN", () => {
  it("calls runImplement once on the primary and does not create siblings when the flag is off", async () => {
    const primary = fakeWs();
    const calls: string[] = [];
    const siblingCalls: number[] = [];
    const result = await runBestOfN({
      cfg: { v3: DEFAULT_V3_POLICY },
      primary,
      n: 2,
      runImplement: async (ws) => {
        calls.push(ws.path);
        return { files: { "src/a.ts": "from-primary" }, verdict: "PASS" };
      },
      createSiblings: async (_ws, n) => {
        siblingCalls.push(n);
        return [];
      },
    });
    expect(calls).toEqual([primary.path]);
    expect(siblingCalls).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result.copied).toBe(false);
    expect(result.evidence).toBeUndefined();
  });

  it("fans out to n siblings, consensuses PASS trees, and copies the winner onto primary", async () => {
    const primary = fakeWs();
    const calls: string[] = [];
    const siblingCalls: Array<{ n: number; suffix: string }> = [];
    const applied: Record<string, string>[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const result = await runBestOfN({
      cfg: { v3: { bestOfN: { enabled: true, n: 2 } } },
      primary,
      runImplement: async (ws) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 15));
        inflight -= 1;
        calls.push(ws.path);
        const body = ws.path.endsWith("bon-0") ? "export const x = 1;\n" : "export const x = 1; // trivia\n";
        return { files: { "src/a.ts": body }, verdict: "PASS" };
      },
      createSiblings: async (_ws, n, suffix) => {
        siblingCalls.push({ n, suffix });
        return [
          fakeWs({ path: "/tmp/sib-bon-0", branch: "factory/local-1-bon-0" }),
          fakeWs({ path: "/tmp/sib-bon-1", branch: "factory/local-1-bon-1" }),
        ].slice(0, n);
      },
      applyFiles: async (ws, files) => {
        expect(ws.path).toBe(primary.path);
        applied.push({ ...files });
      },
      parser: FIXTURE_PARSER,
    });
    expect(siblingCalls).toEqual([{ n: 2, suffix: "bon" }]);
    expect(calls).toHaveLength(2);
    expect(calls.every((p) => p !== primary.path)).toBe(true);
    expect(maxInflight).toBe(2);
    expect(result.verdict).toBe("PASS");
    expect(result.copied).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.["src/a.ts"]).toBe("export const x = 1;\n");
    expect(result.evidence?.bestOfN).toMatchObject({ n: 2, winner: "bon-0", method: "ast-equal" });
  });

  it("does not copy a FAIL tree; if all FAIL, primary is FAIL without copying", async () => {
    const primary = fakeWs();
    const applied: number[] = [];
    const mixed = await runBestOfN({
      cfg: { v3: { bestOfN: { enabled: true, n: 2 } } },
      primary,
      runImplement: async (ws) => {
        if (ws.path.endsWith("bon-0")) return { files: { "src/a.ts": "bad" }, verdict: "FAIL" };
        return { files: { "src/a.ts": "export const ok = 1;\n" }, verdict: "PASS" };
      },
      createSiblings: async (_ws, n) => [
        fakeWs({ path: "/tmp/sib-bon-0" }),
        fakeWs({ path: "/tmp/sib-bon-1" }),
      ].slice(0, n),
      applyFiles: async () => {
        applied.push(1);
      },
      parser: FIXTURE_PARSER,
    });
    expect(mixed.verdict).toBe("PASS");
    expect(mixed.copied).toBe(true);
    expect(mixed.files["src/a.ts"]).toBe("export const ok = 1;\n");
    expect(mixed.evidence?.bestOfN.winner).toBe("bon-1");

    const allFail = await runBestOfN({
      cfg: { v3: { bestOfN: { enabled: true, n: 2 } } },
      primary,
      runImplement: async () => ({ files: { "src/a.ts": "bad" }, verdict: "FAIL" }),
      createSiblings: async (_ws, n) => [
        fakeWs({ path: "/tmp/sib-bon-0" }),
        fakeWs({ path: "/tmp/sib-bon-1" }),
      ].slice(0, n),
      applyFiles: async () => {
        applied.push(1);
      },
    });
    expect(allFail.verdict).toBe("FAIL");
    expect(allFail.copied).toBe(false);
    expect(allFail.evidence?.bestOfN.winner).toBeNull();
    expect(applied).toHaveLength(1);
  });
});
