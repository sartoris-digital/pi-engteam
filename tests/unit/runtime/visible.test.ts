import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictFilePath } from "../../../src/runtime/env.js";
import { writeStepPrompt } from "../../../src/runtime/prompt.js";
import { VisibleExecutor } from "../../../src/runtime/visible.js";
import type { HerdrCli } from "../../../src/workspace/herdr.js";
import { makeWorkerRequest } from "../../helpers/worker-request.js";

class FakeHerdrCli implements HerdrCli {
  prompts: string[] = [];
  closed: string[] = [];
  constructor(private readonly writeVerdict: () => Promise<void>) {}
  async status() {
    return { running: true, raw: "ok" };
  }
  async worktreeCreate() {
    return { workspaceId: "ws-1", path: "/tmp/ws" };
  }
  async worktreeRemove() {}
  async worktreeList() {
    return [{ workspaceId: "ws-1", path: "/tmp/ws" }];
  }
  async paneSplit() {
    return { paneId: "pane-1" };
  }
  async agentStart() {}
  async agentPrompt(opts: { name: string; text: string; timeoutMs: number }) {
    this.prompts.push(opts.text);
    await this.writeVerdict();
  }
  async agentSendKeys() {}
  async paneClose(paneId: string) {
    this.closed.push(paneId);
  }
  async paneProcessInfo() {
    return { pid: 1 };
  }
}

describe("VisibleExecutor", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("completes from the verdict file written after a fake pane prompt", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-sdlc-vis-"));
    const runsDir = join(root, "runs");
    const runDir = join(runsDir, "run-v1");
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    const promptPath = await writeStepPrompt(runDir, "implement", "Create hello.txt.");
    const verdictFile = verdictFilePath(runDir, "implement", 1);
    const cli = new FakeHerdrCli(async () => {
      await mkdir(join(runDir, "_verdicts"), { recursive: true });
      await writeFile(
        verdictFile,
        JSON.stringify({ step: "implement", verdict: "PASS", commit_message: "feat: hello" }),
      );
    });
    cli.worktreeList = async () => [{ workspaceId: "ws-1", path: ws }];
    const exec = new VisibleExecutor({ cli, pollMs: 10 });
    const result = await exec.run(
      makeWorkerRequest({
        runId: "run-v1",
        runDir,
        runsDir,
        promptPath,
        cwd: ws,
        projectRoot: root,
        timeoutMs: 5_000,
      }),
    );
    expect(result.verdict?.verdict).toBe("PASS");
    expect(result.timedOut).toBe(false);
    expect(cli.closed).toEqual(["pane-1"]);
  });
});
