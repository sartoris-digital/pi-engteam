export type { Workspace, WorkspaceProvider, CreateWorkspaceRequest } from "./types.js";
export { withRepoLock, lockDirFor, isPidAlive, RepoLockTimeoutError, REPO_LOCK_DIRNAME, REPO_LOCK_OWNER_FILE } from "./lock.js";
export type { RepoLockOptions, RepoLockOwner } from "./lock.js";
export { computeConfigSha, assertNoDrift, assertHookSanity, resolveGitDirs, hooksDirDigest, effectiveHooksDir, ConfigTamperedError } from "./drift.js";
export type { GitDirs } from "./drift.js";
