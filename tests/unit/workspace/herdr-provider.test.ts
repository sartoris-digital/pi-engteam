import { describe, expect, it } from "vitest";
import type { HerdrCli } from "../../../src/workspace/herdr.js";
import { herdrRunning } from "../../../src/workspace/herdr.js";
import { HerdrWorktreeProvider } from "../../../src/workspace/herdr-provider.js";

class FakeHerdrCli implements HerdrCli {
  running = true;
  created: Array<{ workspaceId: string; path: string; opts: { cwd: string; branch: string; base: string; label: string } }> = [];
  removed: Array<{ workspaceId: string; force?: boolean }> = [];
  nextId = "from-cli-not-predicted";

  async status() {
    return { running: this.running, raw: this.running ? "ok" : "down" };
  }
  async worktreeCreate(opts: { cwd: string; branch: string; base: string; label: string }) {
    const workspaceId = this.nextId;
    const path = `${opts.cwd}/.herdr/${workspaceId}`;
    this.created.push({ workspaceId, path, opts });
    return { workspaceId, path };
  }
  async worktreeRemove(opts: { workspaceId: string; force?: boolean }) {
    this.removed.push(opts);
  }
  async worktreeList() {
    return this.created.map((c) => ({ workspaceId: c.workspaceId, path: c.path }));
  }
  async paneSplit() {
    return { paneId: "pane-1" };
  }
  async agentStart() {}
  async agentPrompt() {}
  async agentSendKeys() {}
  async paneClose() {}
  async paneProcessInfo() {
    return { pid: null };
  }
}

describe("HerdrWorktreeProvider", () => {
  it("uses the workspace id returned by the CLI and never predicts ids", async () => {
    const cli = new FakeHerdrCli();
    const provider = new HerdrWorktreeProvider({ cli, home: "/tmp/home" });
    const ws = await provider.create({
      repoRoot: "/tmp/repo",
      branch: "factory/github-1-x",
      base: "main",
      slug: "github-1-x",
      lockReason: "factory:github-1",
    });
    expect(ws.provider).toBe("herdr");
    expect(ws.workspaceId).toBe("from-cli-not-predicted");
    expect(ws.path).toBe("/tmp/repo/.herdr/from-cli-not-predicted");
    expect(cli.created).toHaveLength(1);
  });

  it("remove calls worktreeRemove with the recorded id", async () => {
    const cli = new FakeHerdrCli();
    const provider = new HerdrWorktreeProvider({ cli, home: "/tmp/home" });
    const ws = await provider.create({
      repoRoot: "/tmp/repo",
      branch: "factory/github-1-x",
      base: "main",
      slug: "github-1-x",
      lockReason: "factory:github-1",
    });
    await provider.remove(ws, { force: true });
    expect(cli.removed).toEqual([{ workspaceId: "from-cli-not-predicted", force: true }]);
  });
});

describe.skipIf(process.env.HERDR_LIVE !== "1")("HerdrWorktreeProvider live", () => {
  it("sees a running herdr server", async () => {
    expect(await herdrRunning()).toBe(true);
  });
});
