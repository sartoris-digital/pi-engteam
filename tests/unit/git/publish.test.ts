import { describe, it, expect, afterEach } from "vitest";
import { rawGit } from "../../helpers/raw-git.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import { publish, type PublishOptions } from "../../../src/git/publish.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function judged() {
  const j = await makeJudgedWorkspace();
  cleanups.push(j.cleanup);
  return j;
}

const noDocs: PublishOptions = { deps: { findGeneratedDocs: async () => [] } };
const detailOf = (r: unknown) => (r as { detail: string }).detail;

describe("publish", () => {
  it("pushes the judged head to refs/heads/<branch> on the claim-time remote url", async () => {
    const { bare, ws, sha, cfg, state } = await judged();
    const res = await publish(state, cfg, ws, noDocs);
    expect(res).toEqual({ pushed: true, sha, branch: ws.branch, remote: "origin", pushTarget: ws.remoteUrl });
    expect(await rawGit(bare, "rev-parse", `refs/heads/${ws.branch}`)).toBe(sha);
  });

  it("does not push when preflight refuses and surfaces the preflight code", async () => {
    const { bare, ws, cfg, state } = await judged();
    const res = await publish({ ...state, judgedSha: "0".repeat(40) }, cfg, ws, noDocs);
    expect(res).toMatchObject({ pushed: false, code: "publish-refused" });
    expect(detailOf(res)).toMatch(/judgedSha/);
    await expect(rawGit(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${ws.branch}`)).rejects.toThrow();
  });

  it("reports push-rejected instead of forcing when the remote branch diverged", async () => {
    const { repo, bare, ws, cfg, state } = await judged();
    await rawGit(repo, "commit", "-q", "--allow-empty", "-m", "someone else's work");
    await rawGit(repo, "push", "-q", "origin", `HEAD:refs/heads/${ws.branch}`);
    const foreignTip = await rawGit(bare, "rev-parse", `refs/heads/${ws.branch}`);
    const res = await publish(state, cfg, ws, noDocs);
    expect(res).toMatchObject({ pushed: false, code: "push-rejected" });
    expect(detailOf(res)).toMatch(/rejected|non-fast-forward/);
    expect(await rawGit(bare, "rev-parse", `refs/heads/${ws.branch}`)).toBe(foreignTip);
  });

  it("is idempotent: a second publish of the same head succeeds without changing the remote", async () => {
    const { bare, ws, sha, cfg, state } = await judged();
    expect(await publish(state, cfg, ws, noDocs)).toMatchObject({ pushed: true, sha });
    expect(await publish(state, cfg, ws, noDocs)).toMatchObject({ pushed: true, sha });
    expect(await rawGit(bare, "rev-parse", `refs/heads/${ws.branch}`)).toBe(sha);
  });
});
