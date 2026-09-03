import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { writeQueue } from "../../../src/commands/enqueue.js";
import { runStatus } from "../../../src/commands/status.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";

describe("runStatus", () => {
  let runs: string;
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), "pi-sdlc-st-"));
    await mkdir(join(runs, "_factory"), { recursive: true });
    await writeQueue(runs, {
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
          lane: "chore",
          enqueuedAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
  });
  afterEach(async () => {
    await rm(runs, { recursive: true, force: true });
  });

  it("prints the queue and supports --json", async () => {
    const deps = { runsDir: runs, repos: ["/repo"], lanes: {}, home: join(runs, "..") } as unknown as FactoryDeps;
    const text = await runStatus(parseFactoryArgs("status"), deps);
    expect(text).toContain("local-1");
    expect(text).toContain("queued");
    const json = await runStatus(parseFactoryArgs("status --json"), deps);
    expect(JSON.parse(json).entries[0].ref).toBe("local-1");
  });

  it("groups needs-rebase and human-owned and shows waitingOn", async () => {
    await writeQueue(runs, {
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
          lane: "chore",
          enqueuedAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
        {
          key: "local:/repo:local-2",
          tracker: "local",
          repo: "/repo",
          ref: "local-2",
          priority: "p2",
          state: "needs-rebase",
          waitingOn: "rebase",
          kind: "chore",
          lane: "chore",
          runId: "run-2",
          rebaseCount: 1,
          enqueuedAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
        {
          key: "local:/repo:local-3",
          tracker: "local",
          repo: "/repo",
          ref: "local-3",
          priority: "p2",
          state: "human-owned",
          kind: "bug",
          lane: "bug",
          runId: "run-3",
          enqueuedAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    const deps = { runsDir: runs, repos: ["/repo"], lanes: {}, home: join(runs, "..") } as unknown as FactoryDeps;
    const text = await runStatus(parseFactoryArgs("status"), deps);
    expect(text).toMatch(/needs-rebase:[\s\S]*local-2/);
    expect(text).toMatch(/human-owned:[\s\S]*local-3/);
    const one = await runStatus(parseFactoryArgs("status local-2"), deps);
    expect(one).toContain("waitingOn: rebase");
    expect(one).toContain("state: needs-rebase");
  });
});
