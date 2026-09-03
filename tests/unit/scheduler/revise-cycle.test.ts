import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueEntry } from "../../../src/scheduler/queue.js";
import {
  drainReviseOnce,
  watchPublished,
  type ReviewEvent,
  type ReviewSource,
  type ReviseMemory,
  type ReviseOpts,
} from "../../../src/scheduler/revise-cycle.js";

function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    key: "github:acme/widgets:42",
    tracker: "github",
    repo: "acme/widgets",
    ref: "acme/widgets#42",
    priority: "p2",
    state: "published",
    kind: "bug",
    lane: "bug",
    runId: "run-rev",
    prUrl: "https://github.com/acme/widgets/pull/9",
    hostCommits: ["aaa"],
    judgedSha: "bbb",
    rebaseCount: 0,
    reviseRounds: 0,
    workspace: { provider: "git", path: "/tmp/ws", branch: "factory/github-42-slug", lane: "bug" },
    enqueuedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

function source(events: ReviewEvent[]): ReviewSource {
  return { list: async () => events };
}

function comment(over: Partial<ReviewEvent> & Pick<ReviewEvent, "id" | "author" | "body">): ReviewEvent {
  return {
    at: "2026-09-03T00:00:00.000Z",
    kind: "comment",
    own: false,
    ...over,
  };
}

async function withRunDir<T>(fn: (runDir: string) => Promise<T>): Promise<T> {
  const runDir = await mkdtemp(join(tmpdir(), "pi-sdlc-revise-"));
  try {
    return await fn(runDir);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

describe("watchPublished / drainReviseOnce", () => {
  it("ignores own comments and factory bot authors", async () => {
    await withRunDir(async (runDir) => {
      const calls: string[] = [];
      const e = entry();
      const memory: ReviseMemory = { seenIds: new Set() };
      const opts: ReviseOpts = {
        runDir,
        nonce: "n".repeat(32),
        memory,
        resume: async () => {
          calls.push("resume");
          return { judgedSha: "c".repeat(40) };
        },
        republish: async () => {
          calls.push("republish");
        },
      };
      const events: ReviewEvent[] = [
        comment({ id: "own-1", author: "factory", body: "status", own: true }),
        comment({ id: "bot-1", author: "factory-bot", body: "ok" }),
        comment({ id: "bot-2", author: "github-actions[bot]", body: "ci" }),
        comment({ id: "bot-3", author: "azure-pipelines", body: "ci" }),
      ];
      const a = await watchPublished(e, source(events), opts);
      const b = await drainReviseOnce(e, source(events), opts);
      expect(a.action).toBe("ignored");
      expect(b.action).toBe("ignored");
      expect(calls).toEqual([]);
      expect(e.reviseRounds ?? 0).toBe(0);
    });
  });

  it("fences a human comment into revise-1.md and resumes implement once", async () => {
    await withRunDir(async (runDir) => {
      const calls: string[] = [];
      const e = entry();
      const memory: ReviseMemory = { seenIds: new Set() };
      const out = await drainReviseOnce(
        e,
        source([comment({ id: "c1", author: "ada", body: "please rename the helper" })]),
        {
          runDir,
          nonce: "nonce-1",
          memory,
          resume: async (args) => {
            calls.push(`resume:${args.fromStep}:${(args.resetRounds ?? []).join(",")}`);
            return { judgedSha: "d".repeat(40) };
          },
          republish: async (args) => {
            calls.push(`republish:${args.judgedSha}`);
          },
        },
      );
      expect(out.action).toBe("revised");
      expect(out.rounds).toBe(1);
      expect(e.reviseRounds).toBe(1);
      expect(calls).toEqual(["resume:implement:implement", `republish:${"d".repeat(40)}`]);
      const names = await readdir(join(runDir, "human-input"));
      expect(names).toContain("revise-1.md");
      const body = await readFile(join(runDir, "human-input", "revise-1.md"), "utf8");
      expect(body).toContain("please rename the helper");
      expect(body).toContain("UNTRUSTED");
    });
  });

  it("treats a CI failure as a revise trigger", async () => {
    await withRunDir(async (runDir) => {
      let resumes = 0;
      const e = entry();
      const out = await drainReviseOnce(
        e,
        source([{ id: "ci-1", at: "2026-09-03T00:00:00.000Z", author: "ci", body: "checks failed", kind: "ci-failure", own: false }]),
        {
          runDir,
          nonce: "nonce-ci",
          memory: { seenIds: new Set() },
          resume: async () => {
            resumes += 1;
            return { judgedSha: "e".repeat(40) };
          },
        },
      );
      expect(out.action).toBe("revised");
      expect(resumes).toBe(1);
    });
  });

  it("does not start a third round after reviseMaxRounds", async () => {
    await withRunDir(async (runDir) => {
      const e = entry();
      const memory: ReviseMemory = { seenIds: new Set() };
      const resumes: string[] = [];
      const opts: ReviseOpts = {
        runDir,
        nonce: "nonce-max",
        memory,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
        reviseMaxRounds: 2,
        reviseBackoffSeconds: [0, 0],
        resume: async () => {
          resumes.push("resume");
          return { judgedSha: "f".repeat(40) };
        },
      };
      await drainReviseOnce(e, source([comment({ id: "c1", author: "ada", body: "one" })]), opts);
      await drainReviseOnce(e, source([
        comment({ id: "c1", author: "ada", body: "one" }),
        comment({ id: "c2", author: "ada", body: "two" }),
      ]), opts);
      const third = await drainReviseOnce(e, source([
        comment({ id: "c1", author: "ada", body: "one" }),
        comment({ id: "c2", author: "ada", body: "two" }),
        comment({ id: "c3", author: "ada", body: "three" }),
      ]), opts);
      expect(resumes).toHaveLength(2);
      expect(third.action).toBe("max-rounds");
      expect(e.reviseRounds).toBe(2);
    });
  });

  it("waits reviseBackoffSeconds on a new event and does not stack duplicate ids", async () => {
    await withRunDir(async (runDir) => {
      const e = entry();
      const memory: ReviseMemory = { seenIds: new Set() };
      let nowMs = Date.parse("2026-09-03T00:00:00.000Z");
      const resumes: string[] = [];
      const opts: ReviseOpts = {
        runDir,
        nonce: "nonce-bo",
        memory,
        now: () => new Date(nowMs),
        reviseBackoffSeconds: [120, 240],
        resume: async () => {
          resumes.push(`r${resumes.length + 1}`);
          return { judgedSha: "a".repeat(40) };
        },
      };
      const first = await drainReviseOnce(e, source([comment({ id: "c1", author: "ada", body: "one" })]), opts);
      expect(first.action).toBe("revised");
      const dup = await drainReviseOnce(e, source([comment({ id: "c1", author: "ada", body: "one" })]), opts);
      expect(dup.action).toBe("ignored");
      const early = await drainReviseOnce(
        e,
        source([
          comment({ id: "c1", author: "ada", body: "one" }),
          comment({ id: "c2", author: "ada", body: "two" }),
        ]),
        opts,
      );
      expect(early.action).toBe("backoff");
      expect(resumes).toEqual(["r1"]);
      nowMs += 120_000;
      const second = await drainReviseOnce(
        e,
        source([
          comment({ id: "c1", author: "ada", body: "one" }),
          comment({ id: "c2", author: "ada", body: "two" }),
        ]),
        opts,
      );
      expect(second.action).toBe("revised");
      expect(resumes).toEqual(["r1", "r2"]);
      expect(e.reviseRounds).toBe(2);
    });
  });

  it("stops with human-owned and does not resume when the branch has foreign commits", async () => {
    await withRunDir(async (runDir) => {
      let resumes = 0;
      const e = entry();
      const out = await drainReviseOnce(
        e,
        source([comment({ id: "c1", author: "ada", body: "please fix" })]),
        {
          runDir,
          nonce: "nonce-ho",
          memory: { seenIds: new Set() },
          hasForeignCommits: async () => true,
          resume: async () => {
            resumes += 1;
          },
        },
      );
      expect(out.action).toBe("human-owned");
      expect(e.state).toBe("human-owned");
      expect(resumes).toBe(0);
    });
  });

  it("does not republish without a new judgedSha", async () => {
    await withRunDir(async (runDir) => {
      const calls: string[] = [];
      await drainReviseOnce(
        entry(),
        source([comment({ id: "c1", author: "ada", body: "nits" })]),
        {
          runDir,
          nonce: "nonce-j",
          memory: { seenIds: new Set() },
          resume: async () => {
            calls.push("resume");
          },
          republish: async () => {
            calls.push("republish");
          },
        },
      );
      expect(calls).toEqual(["resume"]);
    });
  });
});
