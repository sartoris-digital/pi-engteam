import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rawGit } from "../../helpers/raw-git.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import { checkpointCommit } from "../../../src/git/checkpoint.js";
import { publish } from "../../../src/git/publish.js";
import { landReconcile } from "../../../src/git/reconcile.js";
import type { QueueEntry } from "../../../src/commands/enqueue.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const noDocs = { deps: { findGeneratedDocs: async () => [] } };

async function judged() {
  const j = await makeJudgedWorkspace();
  cleanups.push(j.cleanup);
  return j;
}

function published(over: Partial<QueueEntry> & Pick<QueueEntry, "repo" | "judgedSha" | "hostCommits" | "baseSha">): QueueEntry {
  const { repo, judgedSha, hostCommits, baseSha, ...rest } = over;
  return {
    key: "github:acme/widgets:42",
    tracker: "github",
    repo,
    ref: "acme/widgets#42",
    priority: "p2",
    state: "published",
    kind: "bug",
    lane: "bug",
    runId: "run-0001",
    enqueuedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    prNumber: 9,
    changedFiles: ["feature.txt"],
    judgedSha,
    hostCommits,
    baseSha,
    ...rest,
  };
}

describe("landReconcile", () => {
  it("marks clean when a merge commit preserves the judged sha", async () => {
    const { repo, ws, sha, cfg, state } = await judged();
    expect(await publish(state, cfg, ws, noDocs)).toMatchObject({ pushed: true });
    await rawGit(repo, "fetch", "-q", "origin");
    await rawGit(repo, "merge", "--no-ff", "-m", "merge factory", `origin/${ws.branch}`);
    await rawGit(repo, "push", "-q", "origin", "main");

    const out = await landReconcile(
      published({
        repo,
        judgedSha: sha,
        hostCommits: [sha],
        baseSha: ws.baseSha,
        workspace: { provider: "git", path: ws.path, branch: ws.branch, lane: "bug" },
      }),
      { cwd: repo, base: "main", abandonDays: 7 },
    );
    expect(out.state).toBe("landed");
    expect(out.landedAs).toBe("clean");
    expect(out.landedBy).toBe("git");
    expect(out.landedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("marks clean on a squash merge with an identical patch-id", async () => {
    const { repo, ws, sha, cfg, state } = await judged();
    expect(await publish(state, cfg, ws, noDocs)).toMatchObject({ pushed: true });
    await rawGit(repo, "fetch", "-q", "origin");
    await rawGit(repo, "merge", "--squash", `origin/${ws.branch}`);
    await rawGit(repo, "commit", "-q", "-m", "squash factory");
    await rawGit(repo, "push", "-q", "origin", "main");

    const out = await landReconcile(
      published({
        repo,
        judgedSha: sha,
        hostCommits: [sha],
        baseSha: ws.baseSha,
        workspace: { provider: "git", path: ws.path, branch: ws.branch, lane: "bug" },
      }),
      { cwd: repo, base: "main", abandonDays: 7 },
    );
    expect(out.state).toBe("landed");
    expect(out.landedAs).toBe("clean");
    expect(out.landedBy).toBe("git");
  });

  it("marks human-modified when a squash adds extra hunks and cites the ticket", async () => {
    const { repo, ws, sha, cfg, state } = await judged();
    expect(await publish(state, cfg, ws, noDocs)).toMatchObject({ pushed: true });
    await rawGit(repo, "fetch", "-q", "origin");
    await rawGit(repo, "merge", "--squash", `origin/${ws.branch}`);
    await writeFile(path.join(repo, "feature.txt"), "feature\nextra hunk\n");
    await rawGit(repo, "add", "feature.txt");
    await rawGit(repo, "commit", "-q", "-m", "Fixes #42 with extra hunks");
    await rawGit(repo, "push", "-q", "origin", "main");

    const out = await landReconcile(
      published({
        repo,
        judgedSha: sha,
        hostCommits: [sha],
        baseSha: ws.baseSha,
        workspace: { provider: "git", path: ws.path, branch: ws.branch, lane: "bug" },
      }),
      { cwd: repo, base: "main", abandonDays: 7 },
    );
    expect(out.state).toBe("landed");
    expect(out.landedAs).toBe("human-modified");
    expect(out.landedBy).toBe("git");
  });

  it("marks partial when only one of two host commits landed", async () => {
    const { repo, ws, sha, cfg, state } = await judged();
    await writeFile(path.join(ws.path, "other.txt"), "other\n");
    const sha2 = await checkpointCommit(ws, "feat: other", { runId: "run-0001" });
    if (sha2 === null) throw new Error("second checkpoint produced no commit");
    const two = { ...state, hostCommits: [sha, sha2], judgedSha: sha2 };
    expect(await publish(two, cfg, ws, noDocs)).toMatchObject({ pushed: true });
    await rawGit(repo, "fetch", "-q", "origin");
    await rawGit(repo, "cherry-pick", sha);
    await rawGit(repo, "push", "-q", "origin", "main");

    const out = await landReconcile(
      published({
        repo,
        judgedSha: sha2,
        hostCommits: [sha, sha2],
        baseSha: ws.baseSha,
        workspace: { provider: "git", path: ws.path, branch: ws.branch, lane: "bug" },
      }),
      { cwd: repo, base: "main", abandonDays: 7 },
    );
    expect(out.state).toBe("landed");
    expect(out.landedAs).toBe("partial");
  });

  it("closes a vanished branch older than abandonDays", async () => {
    const { repo, ws, sha, cfg, state } = await judged();
    expect(await publish(state, cfg, ws, noDocs)).toMatchObject({ pushed: true });
    await rawGit(repo, "push", "-q", "origin", "--delete", ws.branch);
    const now = new Date("2026-09-10T00:00:00.000Z");
    const out = await landReconcile(
      published({
        repo,
        judgedSha: sha,
        hostCommits: [sha],
        baseSha: ws.baseSha,
        updatedAt: "2026-09-02T00:00:00.000Z",
        workspace: { provider: "git", path: ws.path, branch: ws.branch, lane: "bug" },
      }),
      { cwd: repo, base: "main", abandonDays: 7, now: () => now },
    );
    expect(out.state).toBe("closed");
    expect(out.landedAs).toBeUndefined();
  });

  it("does not import prHint", async () => {
    const src = await readFile(fileURLToPath(new URL("../../../src/git/reconcile.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/prHint/);
  });
});
