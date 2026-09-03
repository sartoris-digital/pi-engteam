import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawGit } from "../../helpers/raw-git.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import { publish, type PublishOptions } from "../../../src/git/publish.js";
import { githubPrClient, type GhExec, type PrClient } from "../../../src/git/pr.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function judged() {
  const j = await makeJudgedWorkspace();
  cleanups.push(j.cleanup);
  return j;
}

const noDocs: PublishOptions = { deps: { findGeneratedDocs: async () => [] } };

function stubPr(): PrClient & { calls: Array<Parameters<PrClient["create"]>[0]> } {
  const calls: Array<Parameters<PrClient["create"]>[0]> = [];
  return {
    calls,
    create: async (opts) => {
      calls.push(opts);
      return { number: 9, url: "https://github.com/acme/widgets/pull/9" };
    },
  };
}

describe("publish with optional PrClient", () => {
  it("stays push-only when PrClient is omitted and does not call gh", async () => {
    const { bare, ws, sha, cfg, state } = await judged();
    const res = await publish(state, cfg, ws, noDocs);
    expect(res).toEqual({ pushed: true, sha, branch: ws.branch, remote: "origin", pushTarget: ws.remoteUrl });
    expect("pr" in res).toBe(false);
    expect("handoffPath" in res).toBe(false);
    expect(await rawGit(bare, "rev-parse", `refs/heads/${ws.branch}`)).toBe(sha);
  });

  it("creates the PR after a successful push and writes handoff.json", async () => {
    const { ws, sha, cfg, state } = await judged();
    const runDir = await mkdtemp(join(tmpdir(), "pub-pr-"));
    cleanups.push(() => rm(runDir, { recursive: true, force: true }));
    const pr = stubPr();
    const res = await publish(state, cfg, ws, {
      ...noDocs,
      pr,
      runDir,
      prRepo: "acme/widgets",
      prBody: "host body\n",
    });
    expect(res.pushed).toBe(true);
    if (!res.pushed) throw new Error("expected push");
    expect(pr.calls).toHaveLength(1);
    expect(pr.calls[0]).toMatchObject({
      repo: "acme/widgets",
      base: "main",
      head: ws.branch,
      body: "host body\n",
    });
    expect(res.pr).toEqual({ number: 9, url: "https://github.com/acme/widgets/pull/9" });
    expect(res.handoffPath).toBe(join(runDir, "handoff.json"));
    const bodyFile = await readFile(join(runDir, "pr-body.md"), "utf8");
    expect(bodyFile).toBe("host body\n");
    const handoff = JSON.parse(await readFile(res.handoffPath!, "utf8")) as {
      judgedSha: string;
      hostCommits: string[];
      branch: string;
      patchIds: string[];
      prUrl: string;
    };
    expect(handoff.judgedSha).toBe(sha);
    expect(handoff.hostCommits).toEqual([sha]);
    expect(handoff.branch).toBe(ws.branch);
    expect(handoff.patchIds).toEqual([]);
    expect(handoff.prUrl).toBe("https://github.com/acme/widgets/pull/9");
  });

  it("does not call PrClient when preflight refuses", async () => {
    const { ws, cfg, state } = await judged();
    const pr = stubPr();
    const res = await publish({ ...state, judgedSha: "0".repeat(40) }, cfg, ws, { ...noDocs, pr, prRepo: "acme/widgets" });
    expect(res).toMatchObject({ pushed: false, code: "publish-refused" });
    expect(pr.calls).toHaveLength(0);
  });

  it("drafts the PR when the run tier is elevated", async () => {
    const { ws, cfg, state } = await judged();
    const pr = stubPr();
    await publish({ ...state, tier: "elevated" }, cfg, ws, { ...noDocs, pr, prRepo: "acme/widgets", prBody: "x" });
    expect(pr.calls[0]?.draft).toBe(true);
  });
});

describe("githubPrClient", () => {
  it("invokes gh pr create with --repo and --body-file", async () => {
    const calls: string[][] = [];
    const exec: GhExec = async (args) => {
      calls.push(args);
      return { stdout: "https://github.com/acme/widgets/pull/11\n", stderr: "", code: 0 };
    };
    const client = githubPrClient(exec);
    const created = await client.create({
      repo: "acme/widgets",
      base: "main",
      head: "factory/github-11-x",
      title: "bug: x",
      body: "hello\n",
      draft: true,
    });
    expect(created).toEqual({ number: 11, url: "https://github.com/acme/widgets/pull/11" });
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv).toContain("--repo");
    expect(argv[argv.indexOf("--repo") + 1]).toBe("acme/widgets");
    expect(argv).toContain("--body-file");
    expect(argv).toContain("--draft");
    expect(argv).toContain("--base");
    expect(argv).toContain("--head");
    expect(argv).toContain("--title");
  });
});
