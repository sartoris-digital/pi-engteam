// src/safety/approval-fs.ts
//
// PLAN.md ApprovalWatcher Phase 3 — shared filesystem helpers used by
// every approval-related write path. The helpers implement the
// containment + permission + symlink-rejection guards that PLAN.md
// items 2, 5, and 17b require:
//
//   - lstat (not stat) so symlinks at any approval path are detected
//     and refused. Round-A2 HIGH 3 + Round-A6 MEDIUM 2.
//   - realpath + containment under the canonical runs root so a
//     malicious or corrupted run dir cannot redirect writes elsewhere.
//   - 0o700 dirs / 0o600 files everywhere. Round-A1 MEDIUM 5 +
//     round-A2 MEDIUM 5.
//   - On unsafe-fs-state (symlink, non-directory, containment break),
//     write a single diagnostic line OUTSIDE the suspect tree to
//     `~/.pi/engineering-team/approval-watcher-incidents.jsonl` and
//     refuse to mutate the suspect tree at all. Round-A6 MEDIUM 2.

import { lstat, mkdir, chmod, appendFile, realpath } from "fs/promises";
import { homedir } from "os";
import { join, sep } from "path";

export type ApprovalLayoutResult =
  | { ok: true; approvalsDir: string; pendingDir: string; metaDir: string; quarantineDir: string }
  | { ok: false; reason: ApprovalLayoutFailureReason; suspectPath: string; detail: string };

export type ApprovalLayoutFailureReason =
  | "symlink-detected"
  | "non-directory"
  | "containment-break"
  | "permission-denied"
  | "unknown";

const INCIDENT_LOG_PATH = () =>
  join(homedir(), ".pi", "engineering-team", "approval-watcher-incidents.jsonl");

async function writeIncident(record: {
  runId: string;
  reason: ApprovalLayoutFailureReason;
  suspectPath: string;
  detail: string;
}): Promise<void> {
  try {
    await mkdir(join(homedir(), ".pi", "engineering-team"), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ...record, ts: new Date().toISOString(), pid: process.pid }) + "\n";
    await appendFile(INCIDENT_LOG_PATH(), line, { mode: 0o600 });
  } catch (err) {
    // Best-effort. Incident logging cannot block the refusal itself.
    // eslint-disable-next-line no-console
    console.error(
      "[approval-watcher] incident log write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Resolve a path through symlinks for containment checks. Returns the
 * input when realpath would throw (e.g., path doesn't exist yet) so
 * the caller can still detect "claimed but missing" via lstat.
 */
function safeRealResolve(p: string): string {
  try {
    // realpathSync — synchronous variant for use inside the lstat loop.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("fs").realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * lstat a path and require it is either a directory (when expectDir=true)
 * or absent. Symlinks, regular files, sockets, FIFOs, block/char devices
 * are refused. Returns { ok: true, exists } if safe; otherwise returns
 * the specific failure reason for incident logging.
 */
async function lstatExpectDirOrAbsent(
  path: string,
): Promise<
  | { ok: true; exists: boolean }
  | { ok: false; reason: ApprovalLayoutFailureReason; detail: string }
> {
  try {
    const ls = await lstat(path);
    if (ls.isSymbolicLink()) {
      return { ok: false, reason: "symlink-detected", detail: `${path} is a symbolic link` };
    }
    if (!ls.isDirectory()) {
      return {
        ok: false,
        reason: "non-directory",
        detail: `${path} exists but is not a plain directory (mode=${ls.mode.toString(8)})`,
      };
    }
    return { ok: true, exists: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: true, exists: false };
    if (e.code === "EACCES" || e.code === "EPERM") {
      return { ok: false, reason: "permission-denied", detail: e.message };
    }
    return { ok: false, reason: "unknown", detail: e.message };
  }
}

/**
 * Verify `target` realpath-resolves to a path that is equal-to or
 * contained-under `allowedRoot`. Used to refuse symlinks that escape
 * the runs dir even after lstat says "plain directory".
 */
function isContainedUnder(target: string, allowedRoot: string): boolean {
  const realTarget = safeRealResolve(target);
  const realRoot = safeRealResolve(allowedRoot);
  if (realTarget === realRoot) return true;
  const withSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realTarget.startsWith(withSep);
}

/**
 * Ensure `<runsDir>/<runId>/approvals/{,pending,meta,quarantine}` exist
 * at 0o700, with chmod-repair for pre-watcher installs. Refuses if any
 * path is a symlink, non-directory, or escapes the runs dir.
 *
 * On failure: writes an incident record OUTSIDE the suspect tree and
 * returns `{ ok: false, reason }`. Callers MUST handle the failure
 * (emit `approval:watcher_refused`, mark run blocked, etc.) — do NOT
 * proceed to mutate the tree.
 */
export async function ensureApprovalsLayout(
  runsDir: string,
  runId: string,
): Promise<ApprovalLayoutResult> {
  const runDir = join(runsDir, runId);
  const approvalsDir = join(runDir, "approvals");
  const pendingDir = join(approvalsDir, "pending");
  const metaDir = join(approvalsDir, "meta");
  const quarantineDir = join(approvalsDir, "quarantine");

  // Containment check at the run-root level FIRST so any symlinked
  // parent dir is caught before we touch the approvals tree.
  if (!isContainedUnder(runDir, runsDir)) {
    await writeIncident({
      runId,
      reason: "containment-break",
      suspectPath: runDir,
      detail: `${runDir} realpath escapes ${runsDir}`,
    });
    return {
      ok: false,
      reason: "containment-break",
      suspectPath: runDir,
      detail: `run dir realpath escapes runs root`,
    };
  }

  // For each of the 4 dirs: lstat → if exists, require plain dir AND
  // realpath containment under runDir. If absent, mkdir with 0o700.
  for (const dir of [approvalsDir, pendingDir, metaDir, quarantineDir]) {
    const check = await lstatExpectDirOrAbsent(dir);
    if (!check.ok) {
      await writeIncident({ runId, reason: check.reason, suspectPath: dir, detail: check.detail });
      return { ok: false, reason: check.reason, suspectPath: dir, detail: check.detail };
    }
    if (check.exists) {
      // Existing dir: containment + chmod-repair.
      if (!isContainedUnder(dir, runDir)) {
        await writeIncident({
          runId,
          reason: "containment-break",
          suspectPath: dir,
          detail: `${dir} realpath escapes ${runDir}`,
        });
        return {
          ok: false,
          reason: "containment-break",
          suspectPath: dir,
          detail: `${dir} realpath escapes ${runDir}`,
        };
      }
      try {
        await chmod(dir, 0o700);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EACCES" || e.code === "EPERM") {
          await writeIncident({ runId, reason: "permission-denied", suspectPath: dir, detail: e.message });
          return { ok: false, reason: "permission-denied", suspectPath: dir, detail: e.message };
        }
        // ignore other chmod errors (e.g. read-only fs); the run will
        // still function but the operator may want to fix mode manually.
      }
    } else {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // mkdir's mode argument is masked by umask on POSIX, so chmod
        // to enforce. Round-A1 MEDIUM 5.
        await chmod(dir, 0o700);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        await writeIncident({ runId, reason: "permission-denied", suspectPath: dir, detail: e.message });
        return { ok: false, reason: "permission-denied", suspectPath: dir, detail: e.message };
      }
    }
  }

  return { ok: true, approvalsDir, pendingDir, metaDir, quarantineDir };
}

/**
 * Tighten permissions on existing approval-token files for pre-watcher
 * installs. Run AFTER ensureApprovalsLayout returns ok. Walks
 * `<approvalsDir>/*.json` (granted tokens) and chmods each to 0o600.
 * Safe to call repeatedly; no-op if all tokens are already 0o600.
 */
export async function repairApprovalTokenPermissions(approvalsDir: string): Promise<void> {
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(approvalsDir);
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".consumed")) continue;
      const path = join(approvalsDir, name);
      try {
        const ls = await lstat(path);
        if (!ls.isFile() || ls.isSymbolicLink()) continue;
        await chmod(path, 0o600);
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Re-exported for tests so test fixtures can verify a path is contained
 * without re-importing the private helper.
 */
export const __test = { isContainedUnder, safeRealResolve };
