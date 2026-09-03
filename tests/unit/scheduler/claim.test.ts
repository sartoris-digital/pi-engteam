import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubAdapter } from "../../../src/trackers/github.js";
import { makeStubGh, type StubGhScript } from "../../helpers/stub-gh.js";
import { claimTicket } from "../../../src/scheduler/claim.js";
import { readLedger } from "../../../src/scheduler/ledger.js";
import type { QueueFile } from "../../../src/scheduler/queue.js";

const ISSUE = {
  number: 42,
  title: "Widgets rattle",
  body: "a".repeat(80),
  labels: ["factory:ready"],
  author: "ada",
  updatedAt: "2026-09-01T00:00:00.000Z",
  url: "https://github.com/acme/widgets/issues/42",
  state: "open",
};

function emptyQueue(): QueueFile {
  return { schemaVersion: 1, entries: [] };
}

describe("claimTicket", () => {
  it("does not addLabel on unauthorized triggers and writes a ledger line", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-claim-"));
    try {
      const script: StubGhScript = { issues: { "acme/widgets#42": { ...ISSUE, labels: ["factory:ready"] } }, calls: [] };
      const adapter = new GitHubAdapter({ exec: makeStubGh(script), repo: "acme/widgets" });
      const ticket = await adapter.fetch({ tracker: "github", id: "acme/widgets#42" });
      const queue = emptyQueue();
      const result = await claimTicket({ adapter, ticket, queue, authorized: false, runsDir: runs });
      expect(result.skipped).toBe("unauthorized");
      const edits = (script.calls ?? []).filter((c) => c[0] === "issue" && c[1] === "edit");
      expect(edits).toHaveLength(0);
      const comments = (script.calls ?? []).filter((c) => c[0] === "issue" && c[1] === "comment");
      expect(comments).toHaveLength(0);
      const ledger = await readLedger(runs);
      expect(ledger.some((e) => e.type === "unauthorized-trigger" || e.code === "unauthorized-trigger")).toBe(true);
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });

  it("skips a second ready on the same issue", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-claim2-"));
    try {
      const script: StubGhScript = { issues: { "acme/widgets#42": { ...ISSUE, labels: ["factory:ready"] } }, calls: [] };
      const adapter = new GitHubAdapter({ exec: makeStubGh(script), repo: "acme/widgets" });
      const ticket = await adapter.fetch({ tracker: "github", id: "acme/widgets#42" });
      const queue = emptyQueue();
      const first = await claimTicket({ adapter, ticket, queue, authorized: true, runsDir: runs });
      expect(first.skipped).toBeUndefined();
      expect(first.entry.key).toBe("github:acme/widgets:42");
      expect(script.issues?.["acme/widgets#42"]?.labels).toContain("factory:in-progress");
      expect(script.issues?.["acme/widgets#42"]?.labels).not.toContain("factory:ready");
      const acks = (script.calls ?? []).filter((c) => c.some((a) => String(a).includes("/reactions")));
      expect(acks.length).toBeGreaterThan(0);
      const second = await claimTicket({ adapter, ticket, queue, authorized: true, runsDir: runs });
      expect(second.skipped).toBe("dedupe-open");
      expect(queue.entries).toHaveLength(1);
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });
});
