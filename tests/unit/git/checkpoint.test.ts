import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFixtureRepo } from "../../helpers/fixture-repo.js";
import { rawGit } from "../../helpers/raw-git.js";
import { GitWorktreeProvider } from "../../../src/workspace/git-provider.js";
import { ConfigTamperedError } from "../../../src/workspace/drift.js";
import {
  checkpointCommit, sanitizeCommitMessage, excludePathspecs, trailerArgs, statusExcluding, checkpointExcludes, CHECKPOINT_EXCLUDES,
} from "../../../src/git/checkpoint.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function workspace() {
  const f = await makeFixtureRepo();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "factory-home-")));
  cleanups.push(f.cleanup, () => rm(home, { recursive: true, force: true }));
  const provider = new GitWorktreeProvider({ home, lockTimeoutMs: 10_000 });
  const ws = await provider.create({ repoRoot: f.repo, branch: "factory/local-1-x", base: "main", slug: "local-1-x", lockReason: "factory:local-1" });
  return { ...f, ws };
}

const trailers = { runId: "run-0001", coAuthoredBy: "Claude Fable 5.1 <noreply@anthropic.com>" };

describe("checkpoint helpers", () => {
  it("sanitizeCommitMessage strips CR/control chars, caps length and never yields an option-like message", () => {
    expect(sanitizeCommitMessage("  feat: x\r\n\u0007body  ")).toBe("feat: x\nbody");
    expect(sanitizeCommitMessage("")).toBe("checkpoint");
    expect(sanitizeCommitMessage("   ")).toBe("checkpoint");
    expect(sanitizeCommitMessage("--amend")).toBe("checkpoint --amend");
    expect(sanitizeCommitMessage("a".repeat(5000))).toHaveLength(4000);
  });

  it("excludePathspecs, checkpointExcludes and trailerArgs render git arguments", () => {
    expect(excludePathspecs([".pi/*.local.*", "docs/plans/**"])).toEqual([".", ":(exclude,glob).pi/*.local.*", ":(exclude,glob)docs/plans/**"]);
    expect(CHECKPOINT_EXCLUDES).toEqual([".pi/*.local.*"]);
    expect(checkpointExcludes()).toEqual([".pi/*.local.*"]);
    expect(checkpointExcludes({ excludePatterns: ["extra/**"] })).toEqual([".pi/*.local.*", "extra/**"]);
    expect(trailerArgs(trailers)).toEqual(["--trailer", "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>", "--trailer", "Factory-Run: run-0001"]);
    expect(trailerArgs({ runId: "r" })).toEqual(["--trailer", "Factory-Run: r"]);
  });
});

describe("checkpointCommit", () => {
  it("returns null when there is nothing to commit", async () => {
    const { ws } = await workspace();
    const head = await rawGit(ws.path, "rev-parse", "HEAD");
    expect(await checkpointCommit(ws, "implement: checkpoint", trailers)).toBeNull();
    expect(await rawGit(ws.path, "rev-parse", "HEAD")).toBe(head);
  });

  it("commits new and modified files with Co-Authored-By and Factory-Run trailers and returns the sha", async () => {
    const { ws } = await workspace();
    await writeFile(path.join(ws.path, "src.txt"), "hello\n");
    const sha = await checkpointCommit(ws, "feat: add src", trailers);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await rawGit(ws.path, "rev-parse", "HEAD")).toBe(sha);
    const body = await rawGit(ws.path, "log", "-1", "--format=%B");
    expect(body.startsWith("feat: add src")).toBe(true);
    expect(body).toContain("Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>");
    expect(body).toContain("Factory-Run: run-0001");
    expect(await rawGit(ws.path, "status", "--porcelain")).toBe("");
  });

  it("leaves generated docs and .pi/*.local.* out of the commit and out of statusExcluding", async () => {
    const { ws } = await workspace();
    await mkdir(path.join(ws.path, ".pi"), { recursive: true });
    await mkdir(path.join(ws.path, "docs", "plans"), { recursive: true });
    await writeFile(path.join(ws.path, ".pi", "factory.local.json"), "{}\n");
    await writeFile(path.join(ws.path, "docs", "plans", "2026-09-02-plan.md"), "<!-- pi-sdlc-factory generated · run run-0001 · do not commit -->\n# plan\n");
    await writeFile(path.join(ws.path, "src.txt"), "hello\n");
    const sha = await checkpointCommit(ws, "feat: add src", trailers, { excludePatterns: ["docs/plans/**"] });
    expect(sha).not.toBeNull();
    const files = (await rawGit(ws.path, "show", "--name-only", "--format=", "HEAD")).split("\n");
    expect(files).toEqual(["src.txt"]);
    expect(await statusExcluding(ws, [".pi/*.local.*", "docs/plans/**"])).toEqual([]);
    expect(await rawGit(ws.path, "status", "--porcelain")).not.toBe("");
  });

  it("returns null when only excluded files changed", async () => {
    const { ws } = await workspace();
    await mkdir(path.join(ws.path, ".pi"), { recursive: true });
    await writeFile(path.join(ws.path, ".pi", "factory.local.json"), "{}\n");
    expect(await checkpointCommit(ws, "noop", trailers)).toBeNull();
  });

  it("uses the sanitised message", async () => {
    const { ws } = await workspace();
    await writeFile(path.join(ws.path, "src.txt"), "hello\n");
    await checkpointCommit(ws, "", trailers);
    expect(await rawGit(ws.path, "log", "-1", "--format=%s")).toBe("checkpoint");
  });

  it("refuses to commit when the workspace config drifted", async () => {
    const { ws } = await workspace();
    await writeFile(path.join(ws.path, "src.txt"), "hello\n");
    await rawGit(ws.path, "config", "pi.tamper", "1");
    await expect(checkpointCommit(ws, "feat: x", trailers)).rejects.toBeInstanceOf(ConfigTamperedError);
    expect(await rawGit(ws.path, "diff", "--cached", "--name-only")).toBe("");
  });
});
