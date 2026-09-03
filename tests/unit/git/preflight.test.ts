import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { rawGit } from "../../helpers/raw-git.js";
import { makeJudgedWorkspace } from "../../helpers/judged-workspace.js";
import { publishPreflight, type PreflightDeps } from "../../../src/git/preflight.js";
import type { Workspace } from "../../../src/workspace/types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function judged() {
  const j = await makeJudgedWorkspace();
  cleanups.push(j.cleanup);
  return j;
}

const noDocs: PreflightDeps = { findGeneratedDocs: async () => [] };
const detailOf = (r: unknown) => (r as { detail: string }).detail;

describe("publishPreflight", () => {
  it("passes for a judged head made only of host commits on a clean tree", async () => {
    const { ws, sha, cfg, state } = await judged();
    expect(await publishPreflight(state, cfg, ws, noDocs)).toEqual({ ok: true, headSha: sha, baseSha: ws.baseSha, branch: ws.branch, remote: "origin" });
  });

  it("refuses when HEAD is not the judged sha", async () => {
    const { ws, cfg, state } = await judged();
    const res = await publishPreflight({ ...state, judgedSha: "0".repeat(40) }, cfg, ws, noDocs);
    expect(res).toMatchObject({ ok: false, code: "publish-refused" });
    expect(detailOf(res)).toMatch(/judgedSha/);
  });

  it("refuses when no judgedSha was recorded", async () => {
    const { ws, cfg, state } = await judged();
    const { judgedSha: _dropped, ...noJudge } = state;
    const res = await publishPreflight(noJudge, cfg, ws, noDocs);
    expect(res).toMatchObject({ ok: false, code: "publish-refused" });
    expect(detailOf(res)).toMatch(/judge PASS/);
  });

  it("refuses a foreign commit that is not in hostCommits", async () => {
    const { ws, cfg, state } = await judged();
    await rawGit(ws.path, "commit", "-q", "--allow-empty", "-m", "human edit");
    const head = await rawGit(ws.path, "rev-parse", "HEAD");
    const res = await publishPreflight({ ...state, judgedSha: head }, cfg, ws, noDocs);
    expect(res).toMatchObject({ ok: false, code: "publish-refused" });
    expect(detailOf(res)).toContain(`foreign: ${head.slice(0, 12)}`);
  });

  it("refuses when a recorded host commit is missing from the branch", async () => {
    const { ws, cfg, state } = await judged();
    const res = await publishPreflight({ ...state, hostCommits: [...state.hostCommits, "f".repeat(40)] }, cfg, ws, noDocs);
    expect(res).toMatchObject({ ok: false, code: "publish-refused" });
    expect(detailOf(res)).toContain(`missing: ${"f".repeat(12)}`);
  });

  it("reports config-tampered when the workspace fingerprint drifted (e.g. remote url changed)", async () => {
    const { ws, cfg, state } = await judged();
    await rawGit(ws.path, "remote", "set-url", "origin", `${ws.remoteUrl}-evil`);
    expect(await publishPreflight(state, cfg, ws, noDocs)).toMatchObject({ ok: false, code: "config-tampered" });
  });

  it("reports config-tampered when the live remote url differs from the claim-time value", async () => {
    const { ws, cfg, state } = await judged();
    const res = await publishPreflight(state, cfg, { ...ws, remoteUrl: "/somewhere/else.git" }, noDocs);
    expect(res).toMatchObject({ ok: false, code: "config-tampered" });
    expect(detailOf(res)).toMatch(/url changed/);
  });

  it("refuses a dirty working tree", async () => {
    const { ws, cfg, state } = await judged();
    await writeFile(path.join(ws.path, "feature.txt"), "edited\n");
    const res = await publishPreflight(state, cfg, ws, noDocs);
    expect(res).toMatchObject({ ok: false, code: "publish-refused" });
    expect(detailOf(res)).toMatch(/not clean/);
  });

  it("ignores untracked generated docs when judging cleanliness", async () => {
    const { ws, cfg, state } = await judged();
    await writeFile(path.join(ws.path, "notes.factory.md"), "<!-- pi-sdlc-factory generated · run run-0001 · do not commit -->\n");
    expect(await publishPreflight(state, cfg, ws, noDocs)).toMatchObject({ ok: true });
  });

  it("refuses generated docs in the diff and passes the workspace plus changed files to the scanner", async () => {
    const { ws, cfg, state } = await judged();
    const seen: Array<[Workspace, string[]]> = [];
    const deps: PreflightDeps = { findGeneratedDocs: async (w, files) => { seen.push([w, files]); return ["docs/plans/x.md"]; } };
    const res = await publishPreflight(state, cfg, ws, deps);
    expect(res).toMatchObject({ ok: false, code: "publish-refused" });
    expect(detailOf(res)).toContain("docs/plans/x.md");
    expect(seen).toEqual([[ws, ["feature.txt"]]]);
  });

  it("reports rebase-conflict when origin/<base> moved with a conflicting change", async () => {
    const { repo, ws, cfg, state } = await judged();
    await writeFile(path.join(repo, "feature.txt"), "conflicting\n");
    await rawGit(repo, "add", "-A");
    await rawGit(repo, "commit", "-q", "-m", "main moves");
    await rawGit(repo, "push", "-q", "origin", "main");
    const res = await publishPreflight(state, cfg, ws, noDocs);
    expect(res).toMatchObject({ ok: false, code: "rebase-conflict" });
    expect(detailOf(res)).toContain("feature.txt");
  });

  it("passes when origin/<base> moved without conflict and reports the new base sha", async () => {
    const { repo, ws, sha, cfg, state } = await judged();
    await writeFile(path.join(repo, "other.txt"), "other\n");
    await rawGit(repo, "add", "-A");
    await rawGit(repo, "commit", "-q", "-m", "main moves");
    await rawGit(repo, "push", "-q", "origin", "main");
    const newBase = await rawGit(repo, "rev-parse", "HEAD");
    expect(newBase).not.toBe(ws.baseSha);
    expect(await publishPreflight(state, cfg, ws, noDocs)).toEqual({ ok: true, headSha: sha, baseSha: newBase, branch: ws.branch, remote: "origin" });
  });
});
