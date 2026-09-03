import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ESCALATION_CODES } from "../../../src/engine/types.js";
import {
  QUEUE_STATES,
  queuePath,
  queueStateFor,
  readQueue,
  writeQueue,
  type QueueEntry,
} from "../../../src/scheduler/queue.js";

async function withRuns<T>(fn: (runs: string) => Promise<T>): Promise<T> {
  const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-queue-"));
  try {
    return await fn(runs);
  } finally {
    await rm(runs, { recursive: true, force: true });
  }
}

function fullEntry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    key: "github:acme/widgets:42",
    tracker: "github",
    repo: "acme/widgets",
    ref: "42",
    url: "https://github.com/acme/widgets/issues/42",
    priority: "p1",
    state: "running",
    waitingOn: "steer",
    runId: "run-1",
    workspace: {
      provider: "git",
      path: "/tmp/ws",
      workspaceId: "ws-1",
      branch: "factory/github-42-slug",
      lane: "bug",
    },
    kind: "bug",
    tier: "elevated",
    confidence: "HIGH",
    configSha: "cfg",
    pushUrl: "git@github.com:acme/widgets.git",
    remoteUrl: "git@github.com:acme/widgets.git",
    hostCommits: ["aaa"],
    judgedSha: "bbb",
    baseSha: "ccc",
    patchIds: ["p1"],
    prUrl: "https://github.com/acme/widgets/pull/9",
    prNumber: 9,
    landedAs: "clean",
    landedSha: "ddd",
    landedBy: "git",
    lastReconciledSha: "eee",
    claimedAt: "2026-09-03T00:00:00.000Z",
    attempts: 1,
    rounds: { implement: 2 },
    escalations: [{ code: "needs-info", at: "2026-09-03T00:00:00.000Z", detail: "ac" }],
    writebacks: { "run-1:claim": "2026-09-03T00:00:00.000Z" },
    lastError: undefined,
    lane: "bug",
    enqueuedAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...over,
  };
}

describe("QUEUE_STATES", () => {
  it("is the spec §3.4 set", () => {
    expect([...QUEUE_STATES]).toEqual([
      "queued",
      "classifying",
      "needs-triage",
      "needs-info",
      "needs-decision",
      "ready",
      "waiting_lane",
      "running",
      "awaiting-steer",
      "awaiting-operator",
      "blocked",
      "published",
      "landed",
      "needs-rebase",
      "human-owned",
      "closed",
      "abandoned",
    ]);
  });
});

describe("queueStateFor", () => {
  it("maps engine statuses onto spec queue states", () => {
    expect(queueStateFor("running")).toBe("running");
    expect(queueStateFor("pending")).toBe("running");
    expect(queueStateFor("waiting_user")).toBe("awaiting-steer");
    expect(queueStateFor("waiting_user", { reason: "steer" })).toBe("awaiting-steer");
    expect(queueStateFor("waiting_user", { reason: "approval-needed" })).toBe("blocked");
    expect(queueStateFor("waiting_user", { reason: "handoff" })).toBe("awaiting-operator");
    expect(queueStateFor("paused")).toBe("running");
    expect(queueStateFor("succeeded")).toBe("published");
    expect(queueStateFor("failed")).toBe("blocked");
    expect(queueStateFor("cancelled")).toBe("closed");
  });
});

describe("readQueue / writeQueue", () => {
  it("round-trips a full spec entry with 0600/0700 modes", async () => {
    await withRuns(async (runs) => {
      const entry = fullEntry();
      await writeQueue(runs, { schemaVersion: 1, entries: [entry] });
      const path = queuePath(runs);
      expect((await stat(path)).mode & 0o077).toBe(0);
      expect((await stat(dirname(path))).mode & 0o077).toBe(0);
      const loaded = await readQueue(runs);
      expect(loaded.schemaVersion).toBe(1);
      expect(loaded.entries).toEqual([entry]);
    });
  });

  it("still reads a v0 minimal queued entry", async () => {
    await withRuns(async (runs) => {
      const path = queuePath(runs);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              key: "local:/repo:local-1",
              tracker: "local",
              repo: "/repo",
              ref: "local-1",
              priority: "p2",
              state: "queued",
              kind: "chore",
              enqueuedAt: "2026-09-02T00:00:00.000Z",
              updatedAt: "2026-09-02T00:00:00.000Z",
            },
          ],
        })}\n`,
      );
      const loaded = await readQueue(runs);
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0]?.state).toBe("queued");
      expect(loaded.entries[0]?.kind).toBe("chore");
    });
  });

  it("skips unknown states on disk instead of throwing", async () => {
    await withRuns(async (runs) => {
      const path = queuePath(runs);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              key: "local:/repo:ok",
              tracker: "local",
              repo: "/repo",
              ref: "ok",
              priority: "p2",
              state: "queued",
              enqueuedAt: "2026-09-02T00:00:00.000Z",
              updatedAt: "2026-09-02T00:00:00.000Z",
            },
            {
              key: "local:/repo:bad",
              tracker: "local",
              repo: "/repo",
              ref: "bad",
              priority: "p2",
              state: "waiting_user",
              enqueuedAt: "2026-09-02T00:00:00.000Z",
              updatedAt: "2026-09-02T00:00:00.000Z",
            },
          ],
        })}\n`,
      );
      const loaded = await readQueue(runs);
      expect(loaded.entries.map((e) => e.ref)).toEqual(["ok"]);
    });
  });

  it("refuses to write an unknown state", async () => {
    await withRuns(async (runs) => {
      await expect(
        writeQueue(runs, {
          schemaVersion: 1,
          entries: [
            {
              key: "k",
              tracker: "local",
              repo: "/r",
              ref: "r",
              priority: "p2",
              state: "waiting_user" as QueueEntry["state"],
              enqueuedAt: "t",
              updatedAt: "t",
            },
          ],
        }),
      ).rejects.toThrow(/unknown queue state/);
    });
  });
});

describe("escalation codes", () => {
  it("keeps v0 codes and adds the v1 scheduler codes", () => {
    for (const code of [
      "needs-decision",
      "env-setup-failed",
      "workspace-lost",
      "steer-timeout",
      "approval-needed",
    ]) {
      expect(ESCALATION_CODES).toContain(code);
    }
    for (const code of [
      "needs-triage",
      "needs-info",
      "duplicate-suspected",
      "base-red",
      "cannot-reproduce",
      "gate-defect",
      "dependency-denied",
      "security-fail",
      "rebase-conflict",
      "rule-violation",
      "needs-rebase",
      "human-owned",
    ]) {
      expect(ESCALATION_CODES).toContain(code);
    }
  });
});
