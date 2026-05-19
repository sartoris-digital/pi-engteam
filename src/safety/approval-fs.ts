// src/safety/approval-fs.ts
//
// PLAN.md ApprovalWatcher Phase 3 — shared filesystem helpers used by
// every approval-related write path. The helpers implement the
// containment + permission + symlink-rejection guards that PLAN.md
// items 2, 5, and 17b require:
//
//   - fd-based open(O_NOFOLLOW) instead of lstat(path) → kernel rejects
//     symlinks at the leaf atomically. Round-3 HIGH 1: closes the
//     lstat-to-chmod TOCTOU window where an attacker could swap a real
//     dir for a symlink between the check and the chmod call.
//   - fchmod on the returned file handle (not chmod on a path). The FD
//     is bound to an inode, so a post-open path swap cannot redirect
//     our chmod.
//   - realpath-based containment, strict on failure: if realpath()
//     cannot resolve either side, containment is REFUSED (Round-3 HIGH 2
//     — the previous safeRealResolve silently returned the lexical input
//     on error, which let an unresolvable symlinked parent pass).
//   - 0o700 dirs / 0o600 files. Round-A1 MEDIUM 5 + round-A2 MEDIUM 5.
//   - On unsafe-fs-state, write a single diagnostic line OUTSIDE the
//     suspect tree to `~/.pi/engineering-team/approval-watcher-incidents.jsonl`
//     and refuse to mutate the suspect tree. Round-A6 MEDIUM 2 +
//     Round-3 MEDIUM: incident log itself opens with O_NOFOLLOW so
//     a malicious symlink at the log path cannot redirect our writes.

import { mkdir, open, realpath } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { constants } from "fs";
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
    // O_NOFOLLOW so a symlink planted at the log path cannot redirect
    // our writes elsewhere on the filesystem. O_APPEND | O_CREAT lets us
    // create it if missing and append safely. fd is bound to the inode.
    let fd: FileHandle | undefined;
    try {
      fd = await open(
        INCIDENT_LOG_PATH(),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      await fd.write(line);
    } finally {
      await fd?.close();
    }
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
 * Strict realpath: returns the resolved canonical path, or null if
 * realpath cannot resolve (ENOENT, ELOOP, EACCES, etc). Callers MUST
 * treat null as "containment cannot be proven" and refuse — never fall
 * back to lexical paths (Round-3 HIGH 2).
 */
async function strictRealResolve(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * Verify `target` resolves to a path that is equal-to or contained
 * under `allowedRoot` via realpath. STRICT: if either side fails to
 * resolve, returns false (refuse).
 */
async function isContainedUnder(target: string, allowedRoot: string): Promise<boolean> {
  const realTarget = await strictRealResolve(target);
  const realRoot = await strictRealResolve(allowedRoot);
  if (realTarget === null || realRoot === null) return false;
  if (realTarget === realRoot) return true;
  const withSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realTarget.startsWith(withSep);
}

/**
 * Lexical containment for the test surface only — pure path arithmetic,
 * no fs calls. Production code MUST use isContainedUnder (realpath-based).
 */
function isContainedLexical(target: string, allowedRoot: string): boolean {
  if (target === allowedRoot) return true;
  const withSep = allowedRoot.endsWith(sep) ? allowedRoot : allowedRoot + sep;
  return target.startsWith(withSep);
}

/**
 * Open a path as a directory with O_NOFOLLOW so the kernel rejects
 * symlinks at the leaf atomically. Returns the FileHandle (caller must
 * close) on success, or a typed failure reason.
 *
 * `exists` is true when the path is present but unsafe (symlink, non-dir,
 * permission-denied), and false when the path is absent (ENOENT). Callers
 * use this to distinguish "needs mkdir" from "refuse and incident-log".
 */
type OpenDirResult =
  | { ok: true; fd: FileHandle }
  | { ok: false; reason: ApprovalLayoutFailureReason; detail: string; exists: boolean };

async function openDirNoFollow(path: string): Promise<OpenDirResult> {
  let fd: FileHandle | undefined;
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await fd.stat();
    if (!st.isDirectory()) {
      await fd.close();
      return {
        ok: false,
        reason: "non-directory",
        detail: `${path} exists but is not a plain directory (mode=${st.mode.toString(8)})`,
        exists: true,
      };
    }
    return { ok: true, fd };
  } catch (err) {
    // If we opened the fd but stat/check threw, make sure we close it.
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* ignore */
      }
    }
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ELOOP" || e.code === "EMLINK") {
      return { ok: false, reason: "symlink-detected", detail: `${path} is a symbolic link (${e.code})`, exists: true };
    }
    if (e.code === "ENOTDIR") {
      return { ok: false, reason: "non-directory", detail: `${path} is not a directory`, exists: true };
    }
    if (e.code === "ENOENT") {
      return { ok: false, reason: "non-directory", detail: `${path} does not exist`, exists: false };
    }
    if (e.code === "EACCES" || e.code === "EPERM") {
      return { ok: false, reason: "permission-denied", detail: e.message, exists: true };
    }
    return { ok: false, reason: "unknown", detail: e.message, exists: true };
  }
}

/**
 * Ensure `<runsDir>/<runId>/approvals/{,pending,meta,quarantine}` exist
 * at 0o700, with TOCTOU-safe chmod-repair via fd-based fchmod for
 * pre-watcher installs. Refuses if any path is a symlink, non-directory,
 * or escapes the runs dir.
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
  // parent dir is caught before we touch the approvals tree. Strict:
  // if realpath cannot resolve, containment is refused.
  if (!(await isContainedUnder(runDir, runsDir))) {
    await writeIncident({
      runId,
      reason: "containment-break",
      suspectPath: runDir,
      detail: `${runDir} realpath escapes ${runsDir} or could not be resolved`,
    });
    return {
      ok: false,
      reason: "containment-break",
      suspectPath: runDir,
      detail: `run dir realpath escapes runs root or cannot be resolved`,
    };
  }

  for (const dir of [approvalsDir, pendingDir, metaDir, quarantineDir]) {
    // Step 1: try to open with O_NOFOLLOW. This atomically rejects
    // symlinks at the leaf and gives us an FD bound to the inode.
    const openResult = await openDirNoFollow(dir);

    if (openResult.ok) {
      // Existing dir: verify containment under runDir + fchmod 0o700.
      try {
        if (!(await isContainedUnder(dir, runDir))) {
          await openResult.fd.close();
          await writeIncident({
            runId,
            reason: "containment-break",
            suspectPath: dir,
            detail: `${dir} realpath escapes ${runDir} or could not be resolved`,
          });
          return {
            ok: false,
            reason: "containment-break",
            suspectPath: dir,
            detail: `${dir} realpath escapes ${runDir} or cannot be resolved`,
          };
        }
        // fchmod via FD — TOCTOU-safe. A path swap after the open
        // cannot redirect this chmod because we hold the inode.
        try {
          await openResult.fd.chmod(0o700);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "EACCES" || e.code === "EPERM") {
            await writeIncident({ runId, reason: "permission-denied", suspectPath: dir, detail: e.message });
            return { ok: false, reason: "permission-denied", suspectPath: dir, detail: e.message };
          }
          // Ignore non-fatal chmod errors (e.g. read-only fs); the run
          // can still function but the operator may want to fix mode.
        }
      } finally {
        await openResult.fd.close();
      }
      continue;
    }

    if (openResult.exists) {
      // Path is present but unsafe (symlink / non-dir / permission).
      await writeIncident({ runId, reason: openResult.reason, suspectPath: dir, detail: openResult.detail });
      return { ok: false, reason: openResult.reason, suspectPath: dir, detail: openResult.detail };
    }

    // Step 2: path does not exist — mkdir then re-open with O_NOFOLLOW
    // to verify no race-window symlink swap, then fchmod via FD.
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const reason: ApprovalLayoutFailureReason =
        e.code === "EACCES" || e.code === "EPERM" ? "permission-denied" : "unknown";
      await writeIncident({ runId, reason, suspectPath: dir, detail: e.message });
      return { ok: false, reason, suspectPath: dir, detail: e.message };
    }

    const verify = await openDirNoFollow(dir);
    if (!verify.ok) {
      // The dir we just created is no longer a plain dir at the same
      // path — concurrent attacker swapped a symlink in.
      await writeIncident({
        runId,
        reason: verify.reason,
        suspectPath: dir,
        detail: `post-mkdir verify failed: ${verify.detail}`,
      });
      return {
        ok: false,
        reason: verify.reason,
        suspectPath: dir,
        detail: `post-mkdir verify: ${verify.detail}`,
      };
    }
    try {
      await verify.fd.chmod(0o700);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      await verify.fd.close();
      if (e.code === "EACCES" || e.code === "EPERM") {
        await writeIncident({ runId, reason: "permission-denied", suspectPath: dir, detail: e.message });
        return { ok: false, reason: "permission-denied", suspectPath: dir, detail: e.message };
      }
      // Non-fatal — continue.
      continue;
    }
    await verify.fd.close();
  }

  return { ok: true, approvalsDir, pendingDir, metaDir, quarantineDir };
}

/**
 * Tighten permissions on existing approval-token files for pre-watcher
 * installs. Run AFTER ensureApprovalsLayout returns ok. Walks
 * `<approvalsDir>/*.json` (granted tokens) and fchmods each to 0o600
 * via O_NOFOLLOW open so a symlinked token cannot redirect chmod onto
 * an unrelated file.
 *
 * Safe to call repeatedly; no-op if all tokens are already 0o600.
 */
export async function repairApprovalTokenPermissions(approvalsDir: string): Promise<void> {
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(approvalsDir);
    for (const name of entries) {
      if (!name.endsWith(".json") || name.endsWith(".consumed")) continue;
      const path = join(approvalsDir, name);
      let fd: FileHandle | undefined;
      try {
        // O_NOFOLLOW prevents following a symlink planted at the token
        // path; fchmod operates on the FD (inode), not the path, so
        // a subsequent path swap cannot redirect the chmod.
        fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = await fd.stat();
        if (!st.isFile()) continue;
        await fd.chmod(0o600);
      } catch {
        // best-effort; symlinked tokens are skipped (ELOOP) rather than
        // chmod'd through the link.
      } finally {
        await fd?.close();
      }
    }
  } catch {
    // best-effort — missing dir is fine.
  }
}

/**
 * Re-exported for tests so test fixtures can verify a path is contained
 * without re-importing the private helper. Includes both the strict
 * realpath-based check used by production AND a lexical helper for
 * tests that operate on non-existent paths.
 */
export const __test = { isContainedUnder, isContainedLexical, strictRealResolve };
