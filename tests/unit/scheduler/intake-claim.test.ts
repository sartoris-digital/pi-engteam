import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { readQueue, runEnqueue } from "../../../src/commands/enqueue.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { makeFakeAnalyst } from "../../helpers/fake-analyst.js";
import { GitHubAdapter } from "../../../src/trackers/github.js";
import { LocalAdapter } from "../../../src/trackers/local.js";
import { makeStubGh, type StubGhScript } from "../../helpers/stub-gh.js";
import { applyIntake } from "../../../src/scheduler/intake-claim.js";
import { claimTicket } from "../../../src/scheduler/claim.js";
import type { QueueFile } from "../../../src/scheduler/queue.js";
import type { Brief } from "../../../src/intake/brief-schema.js";
import type { WorkspaceProvider } from "../../../src/workspace/types.js";

const BODY = `${"The widgets rattle when the tray is empty. ".repeat(4)}Need a fix.`;

const ISSUE = {
  number: 7,
  title: "Widgets rattle",
  body: BODY,
  labels: ["factory:ready"],
  author: "ada",
  updatedAt: "2026-09-01T00:00:00.000Z",
  url: "https://github.com/acme/widgets/issues/7",
  state: "open",
};

function brief(over: Partial<Brief> = {}): Brief {
  return {
    kind: "bug",
    flags: [],
    size: "M",
    reproSteps: "present",
    acceptanceCriteria: [{ id: "AC1", text: "no rattle", source: "quoted", quote: "no rattle" }],
    likelyPaths: ["src/widgets.ts"],
    questions: [],
    goal: "stop the rattle",
    samples: { n: 1, kinds: ["bug"], acAgreement: 1 },
    prior: { from: "none" },
    confidence: "LOW",
    tier: "low",
    lane: "bug",
    ...over,
  };
}

describe("intake on claim", () => {
  it("calls AnalystPort twice for a GitHub ticket without --kind", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-ic-"));
    try {
      const script: StubGhScript = { issues: { "acme/widgets#7": { ...ISSUE } }, calls: [] };
      const adapter = new GitHubAdapter({ exec: makeStubGh(script), repo: "acme/widgets" });
      const ticket = await adapter.fetch({ tracker: "github", id: "acme/widgets#7" });
      const queue: QueueFile = { schemaVersion: 1, entries: [] };
      const claimed = await claimTicket({ adapter, ticket, queue, authorized: true, runsDir: runs });
      const analyst = makeFakeAnalyst({ A: brief(), B: brief() });
      const entry = await applyIntake({
        ticket,
        entry: claimed.entry,
        adapter,
        analyst,
        writeRoots: ["src/**", "tests/**"],
        repoResolvable: true,
      });
      expect(analyst.calls).toHaveLength(2);
      expect(entry.state).toBe("ready");
      expect(entry.kind).toBe("bug");
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });

  it("does not call AnalystPort on enqueue --task --kind chore and leaves a drainable entry", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-ic-enq-"));
    try {
      const analyst = makeFakeAnalyst();
      const deps = {
        home: join(runs, ".."),
        runsDir: runs,
        projectRootDefault: "/pkg",
        engine: {} as FactoryDeps["engine"],
        executor: {} as FactoryDeps["executor"],
        provider: {} as FactoryDeps["provider"],
        tracker: new LocalAdapter(runs),
        agents: [],
        lanes: { chore: { class: "build", match: { kind: "chore" }, priority: 100, budget: { fixRounds: 1, maxWallSeconds: 1, maxCostUsd: 1 }, stages: [] } },
        piBinary: "pi",
        repos: ["/repo"],
        analyst,
      } as FactoryDeps;
      const { entry } = await runEnqueue(
        parseFactoryArgs(`enqueue --task "add a greeting helper" --repo /repo --kind chore`),
        deps,
      );
      expect(analyst.calls).toHaveLength(0);
      expect(entry.state === "ready" || entry.state === "queued").toBe(true);
      expect((await readQueue(runs)).entries[0]?.state === "ready" || (await readQueue(runs)).entries[0]?.state === "queued").toBe(true);
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });

  it("posts one abstention comment on LOW confidence and never creates a workspace", async () => {
    const runs = await mkdtemp(join(tmpdir(), "pi-sdlc-ic-low-"));
    try {
      const script: StubGhScript = { issues: { "acme/widgets#7": { ...ISSUE } }, comments: {}, calls: [] };
      const adapter = new GitHubAdapter({ exec: makeStubGh(script), repo: "acme/widgets" });
      const ticket = await adapter.fetch({ tracker: "github", id: "acme/widgets#7" });
      const queue: QueueFile = { schemaVersion: 1, entries: [] };
      const claimed = await claimTicket({ adapter, ticket, queue, authorized: true, runsDir: runs });
      const analyst = makeFakeAnalyst({
        A: brief({ kind: "bug" }),
        B: brief({ kind: "feature", lane: "feature" }),
        tiebreak: brief({ kind: "chore", lane: "chore" }),
      });
      let created = 0;
      const provider: WorkspaceProvider = {
        create: async () => {
          created += 1;
          throw new Error("should not create");
        },
        remove: async () => undefined,
        list: async () => [],
      };
      const entry = await applyIntake({
        ticket,
        entry: claimed.entry,
        adapter,
        analyst,
        provider,
        writeRoots: ["src/**"],
        repoResolvable: true,
      });
      expect(entry.state).toBe("needs-triage");
      const comments = (script.calls ?? []).filter((c) => c[0] === "issue" && c[1] === "comment");
      expect(comments).toHaveLength(1);
      expect(created).toBe(0);
      expect(script.issues?.["acme/widgets#7"]?.labels).toContain("factory:needs-triage");
    } finally {
      await rm(runs, { recursive: true, force: true });
    }
  });
});
