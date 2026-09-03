import { describe, it, expect } from "vitest";
import type { Workspace, CreateWorkspaceRequest, WorkspaceProvider } from "../../../src/workspace/types.js";

describe("workspace types", () => {
  it("describe a git worktree workspace and its provider", () => {
    const ws: Workspace = {
      provider: "git",
      path: "/tmp/home/worktrees/repo-01234567/local-1-x",
      branch: "factory/local-1-x",
      baseSha: "a".repeat(40),
      repoRoot: "/tmp/repo",
      gitCommonDir: "/tmp/repo/.git",
      configSha: "b".repeat(64),
    };
    const req: CreateWorkspaceRequest = { repoRoot: ws.repoRoot, branch: ws.branch, base: "main", slug: "local-1-x", lockReason: "factory:local-1" };
    const provider: WorkspaceProvider = {
      create: async () => ws,
      remove: async () => undefined,
      list: async () => [ws],
    };
    expect(ws.provider).toBe("git");
    expect(req.remote).toBeUndefined();
    expect(provider.list).toBeTypeOf("function");
  });
});
