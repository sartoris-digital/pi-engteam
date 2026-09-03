import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueEntry } from "../../../src/commands/enqueue.js";
import type { TicketRef, TrackerAdapter } from "../../../src/trackers/adapter.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import { upsertStickyComment } from "../../../src/git/sticky.js";

const ref: TicketRef = { tracker: "github", id: "acme/widgets#42" };

function entry(): QueueEntry {
  return {
    key: "github:acme/widgets:42",
    tracker: "github",
    repo: "acme/widgets",
    ref: "acme/widgets#42",
    priority: "p2",
    state: "running",
    kind: "bug",
    runId: "run-1",
    enqueuedAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

class FakeGh {
  readonly id = "github";
  readonly capabilities = new Set(["editComment"] as const);
  commentCalls: Array<{ body: string; key: string }> = [];
  editCalls: Array<{ id: string; body: string }> = [];
  async comment(_r: TicketRef, body: string, opts: { idempotencyKey: string }): Promise<string | null> {
    this.commentCalls.push({ body, key: opts.idempotencyKey });
    return "c1";
  }
  async editComment(_r: TicketRef, id: string, body: string): Promise<void> {
    this.editCalls.push({ id, body });
  }
  asAdapter(): TrackerAdapter {
    return this as unknown as TrackerAdapter;
  }
}

describe("upsertStickyComment", () => {
  it("posts once and skips a second upsert of the same milestone", async () => {
    const fake = new FakeGh();
    const adapter = fake.asAdapter();
    const e = entry();
    const first = await upsertStickyComment({
      adapter,
      ref,
      runId: "run-1",
      body: "claim",
      milestone: "claim",
      entry: e,
    });
    const second = await upsertStickyComment({
      adapter,
      ref,
      runId: "run-1",
      body: "claim again",
      milestone: "claim",
      entry: e,
    });
    expect(first).toBe("c1");
    expect(second).toBe("c1");
    expect(fake.commentCalls).toHaveLength(1);
    expect(fake.commentCalls[0]?.key).toBe("sticky:run-1");
    expect(fake.editCalls).toHaveLength(0);
    expect(e.writebacks?.["run-1:sticky"]).toBe("c1");
    expect(e.writebacks?.["run-1:claim"]).toBeDefined();
  });

  it("edits in place for a later milestone when the adapter can edit comments", async () => {
    const fake = new FakeGh();
    const adapter = fake.asAdapter();
    const e = entry();
    await upsertStickyComment({ adapter, ref, runId: "run-1", body: "claim", milestone: "claim", entry: e });
    const edited = await upsertStickyComment({
      adapter,
      ref,
      runId: "run-1",
      body: "plan done",
      milestone: "plan",
      entry: e,
    });
    expect(edited).toBe("c1");
    expect(fake.commentCalls).toHaveLength(1);
    expect(fake.editCalls).toEqual([{ id: "c1", body: "plan done" }]);
    expect(e.writebacks?.["run-1:plan"]).toBeDefined();
  });

  it("returns null on LocalAdapter and stamps writebacks so retries skip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sticky-local-"));
    try {
      const adapter = new LocalAdapter(dir);
      const e = entry();
      e.tracker = "local";
      const localRef: TicketRef = { tracker: "local", id: "local-01ARZ3NDEKTSV4RRFFQ69G5FAV" };
      const first = await upsertStickyComment({
        adapter,
        ref: localRef,
        runId: "run-1",
        body: "status",
        milestone: "claim",
        entry: e,
      });
      const second = await upsertStickyComment({
        adapter,
        ref: localRef,
        runId: "run-1",
        body: "status 2",
        milestone: "claim",
        entry: e,
      });
      expect(first).toBeNull();
      expect(second).toBeNull();
      expect(e.writebacks?.["run-1:sticky"]).toBeDefined();
      expect(e.writebacks?.["run-1:claim"]).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
