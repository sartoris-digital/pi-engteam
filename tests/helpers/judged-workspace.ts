// tests/helpers/judged-workspace.ts — fixture repo + factory worktree with one host checkpoint,
// and a RunState/config that already agree with it (the state a judge PASS would leave behind).
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFixtureRepo } from "./fixture-repo.js";
import { fakeRepoCfg } from "./fake-repo-cfg.js";
import { fakeRunState } from "./fake-run-state.js";
import { GitWorktreeProvider } from "../../src/workspace/git-provider.js";
import { checkpointCommit } from "../../src/git/checkpoint.js";
import type { Workspace } from "../../src/workspace/types.js";
import type { RunState } from "../../src/engine/types.js";
import type { EffectiveRepoConfig } from "../../src/config/schema.js";

export interface JudgedWorkspace {
  repo: string;
  bare: string;
  ws: Workspace;
  sha: string;
  cfg: EffectiveRepoConfig;
  state: RunState;
  cleanup: () => Promise<void>;
}

export async function makeJudgedWorkspace(): Promise<JudgedWorkspace> {
  const f = await makeFixtureRepo();
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "factory-home-")));
  const provider = new GitWorktreeProvider({ home, lockTimeoutMs: 10_000 });
  const ws = await provider.create({ repoRoot: f.repo, branch: "factory/local-1-x", base: "main", slug: "local-1-x", lockReason: "factory:local-1" });
  await writeFile(path.join(ws.path, "feature.txt"), "feature\n");
  const sha = await checkpointCommit(ws, "feat: feature", { runId: "run-0001" });
  if (sha === null) throw new Error("fixture checkpoint produced no commit");
  const cfg = fakeRepoCfg({ repoRoot: f.repo, remote: "origin" });
  const state = fakeRunState({ branch: ws.branch, baseSha: ws.baseSha, hostCommits: [sha], judgedSha: sha, workspaceDir: ws.path, mainCheckout: f.repo });
  const cleanup = async () => {
    await f.cleanup();
    await rm(home, { recursive: true, force: true });
  };
  return { repo: f.repo, bare: f.bare, ws, sha, cfg, state, cleanup };
}
