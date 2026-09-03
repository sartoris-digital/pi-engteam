// src/workspace/types.ts — contract types for factory workspaces (spec §5.4)

export interface Workspace {
  provider: "git" | "herdr";
  path: string;
  workspaceId?: string;
  branch: string;
  baseSha: string;
  repoRoot: string;
  gitCommonDir: string;
  /** sha256 fingerprint of the git config surface (see workspace/drift.ts), pinned at claim. */
  configSha: string;
  /** Remote name the workspace was created from (default "origin"). Optional so Workspace
   *  literals built elsewhere stay valid; GitWorktreeProvider always sets it. */
  remote?: string;
  /** `git remote get-url <remote>` captured at claim time. publish() pushes to this URL and
   *  publishPreflight refuses when the live URL differs. */
  remoteUrl?: string;
}

export interface CreateWorkspaceRequest {
  repoRoot: string;
  /** Branch name already rendered from branching.nameTemplate. */
  branch: string;
  /** branching.base, e.g. "main". */
  base: string;
  /** Ticket slug; becomes the last path segment under <home>/worktrees/<repo-slug>/. */
  slug: string;
  /** Passed to `git worktree lock --reason`, e.g. "factory:local-01ABC". */
  lockReason: string;
  /** Remote name (default "origin"). */
  remote?: string;
  /** Last host checkpoint sha recorded for `branch`. When the branch already exists and its tip
   *  equals this sha the branch is reused; otherwise a fresh `<branch>-r<n>` is cut from <remote>/<base>. */
  lastHostCommit?: string;
}

export interface WorkspaceProvider {
  create(req: CreateWorkspaceRequest): Promise<Workspace>;
  remove(ws: Workspace, opts: { force: boolean }): Promise<void>;
  list(repoRoot: string): Promise<Workspace[]>;
}
