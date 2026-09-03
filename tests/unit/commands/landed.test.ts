import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { readQueue, writeQueue, type QueueEntry } from "../../../src/commands/enqueue.js";
import { runLanded } from "../../../src/commands/landed.js";
import { runClosed } from "../../../src/commands/closed.js";
import { runReconcile } from "../../../src/commands/reconcile.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { publish } from "../../../src/git/publish.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import { rawGit } from "../../helpers/raw-git.js";

function published(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    key: "github:acme/widgets:42",
    tracker: "github",
    repo: "/repo",
    ref: "acme/widgets#42",
    priority: "p2",
    state: "published",
    kind: "bug",
    lane: "bug",
    runId: "run-1",
    enqueuedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

describe("runLanded / runClosed / runReconcile", () => {
  let runs: string;
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), "pi-sdlc-landed-"));
    await mkdir(join(runs, "_factory"), { recursive: true });
  });
  afterEach(async () => {
    await rm(runs, { recursive: true, force: true });
  });

  it("marks landed by the operator without calling gh", async () => {
    await writeQueue(runs, { schemaVersion: 1, entries: [published()] });
    const deps = { runsDir: runs, provider: { remove: async () => { throw new Error("gh"); } } } as unknown as FactoryDeps;
    const entry = await runLanded(parseFactoryArgs("landed acme/widgets#42 --sha abcdef"), deps);
    expect(entry.state).toBe("landed");
    expect(entry.landedBy).toBe("operator");
    expect(entry.landedAs).toBe("clean");
    expect(entry.landedSha).toBe("abcdef");
    const modified = await runLanded(parseFactoryArgs("landed acme/widgets#42 --modified"), deps);
    expect(modified.landedAs).toBe("human-modified");
    expect(modified.landedBy).toBe("operator");
  });

  it("marks closed and does not remove the worktree", async () => {
    let removed = 0;
    await writeQueue(runs, { schemaVersion: 1, entries: [published()] });
    const deps = {
      runsDir: runs,
      provider: { remove: async () => { removed += 1; } },
    } as unknown as FactoryDeps;
    const entry = await runClosed(parseFactoryArgs("closed acme/widgets#42"), deps);
    expect(entry.state).toBe("closed");
    expect(removed).toBe(0);
  });

  it("reconciles a fixture merge without operator flags", async () => {
    const judged = await makeJudgedWorkspace();
    try {
      expect(await publish(judged.state, judged.cfg, judged.ws, { deps: { findGeneratedDocs: async () => [] } })).toMatchObject({
        pushed: true,
      });
      await rawGit(judged.repo, "fetch", "-q", "origin");
      await rawGit(judged.repo, "merge", "--no-ff", "-m", "merge factory", `origin/${judged.ws.branch}`);
      await rawGit(judged.repo, "push", "-q", "origin", "main");
      await writeQueue(runs, {
        schemaVersion: 1,
        entries: [
          published({
            repo: judged.repo,
            judgedSha: judged.sha,
            hostCommits: [judged.sha],
            baseSha: judged.ws.baseSha,
            workspace: { provider: "git", path: judged.ws.path, branch: judged.ws.branch, lane: "bug" },
          }),
        ],
      });
      const deps = { runsDir: runs, home: runs } as unknown as FactoryDeps;
      const updated = await runReconcile(parseFactoryArgs("reconcile"), deps);
      expect(updated).toHaveLength(1);
      expect(updated[0]?.state).toBe("landed");
      expect(updated[0]?.landedBy).toBe("git");
      expect(updated[0]?.landedAs).toBe("clean");
      const queue = await readQueue(runs);
      expect(queue.entries[0]?.state).toBe("landed");
    } finally {
      await judged.cleanup();
    }
  });
});
