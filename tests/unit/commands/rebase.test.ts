import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { writeQueue, readQueue } from "../../../src/commands/enqueue.js";
import { runRebase } from "../../../src/commands/rebase.js";
import { fakeRepoCfg } from "../../helpers/fake-repo-cfg.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import type { Workspace } from "../../../src/workspace/types.js";

describe("runRebase", () => {
  let runs: string;
  beforeEach(async () => {
    runs = await mkdtemp(join(tmpdir(), "pi-sdlc-rebase-cmd-"));
    await mkdir(join(runs, "_factory"), { recursive: true });
    await writeQueue(runs, {
      schemaVersion: 1,
      entries: [
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
          rebaseCount: 0,
          hostCommits: ["aaa"],
          workspace: { provider: "git", path: "/tmp/ws", branch: "factory/local-2-slug", lane: "chore" },
          enqueuedAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
  });
  afterEach(async () => {
    await rm(runs, { recursive: true, force: true });
  });

  it("calls runRebaseCycle even when autoRebase is false", async () => {
    const deps = { runsDir: runs, repos: ["/repo"], lanes: {}, home: join(runs, "..") } as unknown as FactoryDeps;
    let called = 0;
    const ws = {
      provider: "git",
      path: "/tmp/ws",
      branch: "factory/local-2-slug",
      baseSha: "0".repeat(40),
      repoRoot: "/repo",
      gitCommonDir: "/repo/.git",
      configSha: "c".repeat(64),
      remote: "origin",
    } as Workspace;
    const out = await runRebase(parseFactoryArgs("rebase local-2"), deps, {
      autoRebase: false,
      cfg: fakeRepoCfg({ repoRoot: "/repo" }),
      ws,
      cycle: async (input) => {
        called += 1;
        expect(input.entry.ref).toBe("local-2");
        return { ok: true, branch: "factory/local-2-slug-r1" };
      },
    });
    expect(called).toBe(1);
    expect(out.workspace?.branch).toBe("factory/local-2-slug-r1");
    expect(out.state).toBe("published");
    expect((await readQueue(runs)).entries[0]?.waitingOn).toBeUndefined();
  });
});
