import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFactoryArgs } from "../../../src/commands/router.js";
import { runGrant, type GrantContext } from "../../../src/commands/grant.js";
import { writeQueue } from "../../../src/commands/enqueue.js";
import type { FactoryDeps } from "../../../src/controller/lane-runner.js";
import { fakeRunState } from "../../helpers/fake-run-state.js";
import { ensureRunDir } from "../../../src/home.js";
import { pendingApprovalPath } from "../../../src/worker/request-approval.js";
import { tokenPath } from "../../../src/safety/tokens.js";

function ui(over: Partial<GrantContext> = {}): GrantContext {
  return {
    hasUI: true,
    ui: {
      confirm: async () => true,
    },
    ...over,
  };
}

describe("runGrant", () => {
  let home: string;
  let runs: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pi-sdlc-grant-"));
    runs = join(home, "runs");
    await mkdir(join(runs, "_factory"), { recursive: true });
    process.env.PI_SDLC_HOME = home;
    await ensureRunDir("r1", home);
    await writeFile(join(runs, "r1", ".secret"), "e".repeat(64), { mode: 0o600 });
  });
  afterEach(async () => {
    delete process.env.PI_SDLC_HOME;
    await rm(home, { recursive: true, force: true });
  });

  function deps(resume: (id: string) => Promise<unknown> = async () => fakeRunState({ runId: "r1" })): FactoryDeps {
    return {
      home,
      runsDir: runs,
      projectRootDefault: "/pkg",
      engine: {
        resumeRun: resume,
        getRun: async () => fakeRunState({ runId: "r1", status: "failed", nonce: "nonce-grant" }),
      },
      executor: {},
      provider: {},
      tracker: {},
      agents: [],
      lanes: {},
      piBinary: "pi",
      repos: ["/repo"],
    } as unknown as FactoryDeps;
  }

  it("throws when no pending approval file exists", async () => {
    await expect(runGrant(parseFactoryArgs("grant r1"), deps(), ui())).rejects.toThrow(/no pending/);
  });

  it("throws when interactive UI is missing", async () => {
    await writeFile(
      pendingApprovalPath(join(runs, "r1"), "req-1"),
      `${JSON.stringify({
        requestId: "req-1",
        runId: "r1",
        stage: "implement",
        agent: "implementer",
        op: "bash",
        command: "git stash",
        justification: "need stash",
        requestedAt: "2026-09-02T00:00:00.000Z",
      })}\n`,
    );
    await expect(
      runGrant(parseFactoryArgs("grant r1"), deps(), { hasUI: false, ui: { confirm: async () => true } }),
    ).rejects.toThrow(/interactive UI required/);
  });

  it("mints a granted token and resumes when UI confirms", async () => {
    const seen: string[] = [];
    await writeFile(
      pendingApprovalPath(join(runs, "r1"), "req-1"),
      `${JSON.stringify({
        requestId: "req-1",
        runId: "r1",
        stage: "implement",
        agent: "implementer",
        op: "bash",
        command: "git stash",
        justification: "need stash",
        requestedAt: "2026-09-02T00:00:00.000Z",
      })}\n`,
    );
    await writeQueue(runs, {
      schemaVersion: 1,
      entries: [
        {
          key: "local:/repo:local-1",
          tracker: "local",
          repo: "/repo",
          ref: "local-1",
          priority: "p2",
          state: "blocked",
          waitingOn: "approval",
          kind: "chore",
          lane: "chore",
          runId: "r1",
          enqueuedAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    const titles: string[] = [];
    const state = await runGrant(
      parseFactoryArgs("grant r1"),
      deps(async (id) => {
        seen.push(id);
        return fakeRunState({ runId: "r1", status: "running" });
      }),
      {
        hasUI: true,
        ui: {
          confirm: async (title) => {
            titles.push(title);
            return true;
          },
        },
      },
    );
    expect(state.runId).toBe("r1");
    expect(seen).toEqual(["r1"]);
    expect(titles.some((t) => t.includes("git stash") && t.includes("req-1"))).toBe(true);
    const granted = await readdir(join(runs, "r1", "approvals", "granted"));
    expect(granted.some((n) => n.endsWith(".json"))).toBe(true);
    expect(tokenPath(join(runs, "r1"), granted[0]!.replace(/\.json$/, ""))).toContain("approvals/granted");
  });
});
