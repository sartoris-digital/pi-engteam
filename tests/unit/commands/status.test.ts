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
});
