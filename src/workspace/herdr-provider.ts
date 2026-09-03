import path from "node:path";
import { factoryHome } from "../home.js";
import type { HerdrCli } from "./herdr.js";
import type { CreateWorkspaceRequest, Workspace, WorkspaceProvider } from "./types.js";

export interface HerdrWorktreeProviderOptions {
  cli: HerdrCli;
  home?: string;
  worktreeRoot?: string;
}

export class HerdrWorktreeProvider implements WorkspaceProvider {
  private readonly cli: HerdrCli;
  private readonly home: string;
  private readonly ids = new Map<string, string>();

  constructor(opts: HerdrWorktreeProviderOptions) {
    this.cli = opts.cli;
    this.home = opts.home ?? factoryHome();
  }

  async create(req: CreateWorkspaceRequest): Promise<Workspace> {
    const created = await this.cli.worktreeCreate({
      cwd: req.repoRoot,
      branch: req.branch,
      base: req.base,
      label: req.lockReason,
    });
    this.ids.set(created.path, created.workspaceId);
    return {
      provider: "herdr",
      path: created.path,
      workspaceId: created.workspaceId,
      branch: req.branch,
      baseSha: req.lastHostCommit ?? "0".repeat(40),
      repoRoot: path.resolve(req.repoRoot),
      gitCommonDir: path.join(path.resolve(req.repoRoot), ".git"),
      configSha: "herdr",
      remote: req.remote ?? "origin",
    };
  }

  async remove(ws: Workspace, opts: { force: boolean }): Promise<void> {
    const workspaceId = ws.workspaceId ?? this.ids.get(ws.path);
    if (workspaceId === undefined) throw new Error(`herdr remove: no workspaceId for ${ws.path}`);
    await this.cli.worktreeRemove({ workspaceId, force: opts.force });
    this.ids.delete(ws.path);
  }

  async list(repoRoot: string): Promise<Workspace[]> {
    const rows = await this.cli.worktreeList(repoRoot);
    return rows.map((row) => ({
      provider: "herdr" as const,
      path: row.path,
      workspaceId: row.workspaceId,
      branch: "",
      baseSha: "0".repeat(40),
      repoRoot,
      gitCommonDir: path.join(repoRoot, ".git"),
      configSha: "herdr",
    }));
  }
}
