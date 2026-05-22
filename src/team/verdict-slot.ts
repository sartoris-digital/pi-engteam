// Phase A item 4: host-owned verdict-file slot.
//
// Under PLAN.md item 4, the verdict-recovery file lives at:
//   <runDir>/_verdicts/<agent>-<step>-<token>.json
//
// (Previously: <runsDir>/_agent_tmp/<id>-<token>.verdict.json — which
// `paths.ts` hard-blocks at Layer A. Under CoPilot routing, the
// model's `write`-tool recovery path therefore refused to land,
// forcing dependence on stdout-scan + synthesis tiers.)
//
// This module:
//   * Pre-creates the slot file with O_NOFOLLOW + mode 0o600 BEFORE
//     spawning the subprocess. The slot is host-owned by inode.
//   * Records the canonical-path + inode + token tuple so Layer A
//     can carve a narrow exception keyed on that tuple. A swap of
//     the file under the agent's feet (symlink-trick, deleted +
//     re-created with same name) is refused on read because the
//     inode no longer matches.
//   * Reads + validates the agent-written content, then seals the
//     slot (chmod 0o400) so later writes via the same path are
//     refused.
//
// Gated on the Phase A `verdictSlotHostOwned` feature flag — when
// off, callers use the legacy `_agent_tmp` location.
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, constants } from "fs";
import { dirname, join, resolve } from "path";

export type VerdictSlot = {
  /** Canonical (realpath-resolved) absolute path to the slot file. */
  canonicalPath: string;
  /** Inode of the slot file at host pre-creation time. */
  inode: number;
  /** Embedded agent name (used for Layer-A exception keying). */
  agent: string;
  /** Embedded step name. */
  step: string;
  /** Per-deliver token (eventToken). */
  token: string;
};

/**
 * Resolve the slot path for a given (runDir, agent, step, token) tuple.
 * Caller is responsible for ensuring the inputs are already sanitized
 * (agent/step/token shapes are validated upstream).
 */
export function slotPath(runDir: string, agent: string, step: string, token: string): string {
  return join(runDir, "_verdicts", `${agent}-${step}-${token}.json`);
}

/**
 * Pre-create a host-owned slot file under `<runDir>/_verdicts/`. The
 * file is created with O_NOFOLLOW so a pre-existing symlink at the
 * target path is refused (the operation throws ELOOP). Returns a
 * `VerdictSlot` descriptor with the canonical path + inode.
 *
 * Refuses to overwrite an existing file (O_EXCL is also set).
 */
export function createSlot(runDir: string, agent: string, step: string, token: string): VerdictSlot {
  const path = slotPath(runDir, agent, step, token);
  mkdirSync(dirname(path), { recursive: true });
  // O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW + mode 0o600
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  // Pre-fill with `{}` so models that use the `edit` tool (which
  // requires a non-empty file) can still satisfy the recovery path.
  try {
    const buf = Buffer.from("{}\n", "utf8");
    const { writeSync } = require("fs") as typeof import("fs");
    writeSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const canonical = realpathSync(path);
  const st = statSync(canonical);
  return {
    canonicalPath: canonical,
    inode: st.ino,
    agent,
    step,
    token,
  };
}

/**
 * Read the slot, verifying the file is the same inode the host
 * pre-created. A swap (delete + re-create with same name, or
 * replace with a symlink) yields ENOENT or a different inode and we
 * refuse.
 *
 * Throws on any tampering signal.
 */
export function readSlot(slot: VerdictSlot): string {
  const st = statSync(slot.canonicalPath);
  if (st.ino !== slot.inode) {
    throw new Error(
      `verdict slot inode mismatch — expected ${slot.inode} but saw ${st.ino}; refusing to read possibly-tampered slot`,
    );
  }
  // Refuse a file that has become a symlink between create and read.
  // realpathSync on a symlink resolves the link; a one-shot check
  // catches that.
  const reReal = realpathSync(slot.canonicalPath);
  if (reReal !== slot.canonicalPath) {
    throw new Error(
      `verdict slot canonical-path mismatch — ${slot.canonicalPath} now resolves to ${reReal}; refusing to read`,
    );
  }
  return readFileSync(slot.canonicalPath, "utf8");
}

/**
 * Chmod the slot to 0o400 (host-readable, no further writes) so a
 * post-validation write attempt is refused by the OS. After
 * sealing, the slot is read-only.
 */
export function sealSlot(slot: VerdictSlot): void {
  try {
    chmodSync(slot.canonicalPath, 0o400);
  } catch {
    // best-effort — sealing failure does not invalidate the verdict
  }
}

/**
 * Best-effort cleanup of a slot that was created but never used
 * (e.g. the subprocess crashed before writing). Removes the file
 * after ensuring the inode still matches.
 */
export function disposeSlot(slot: VerdictSlot): void {
  try {
    const st = statSync(slot.canonicalPath);
    if (st.ino === slot.inode) {
      // chmod back to writable first so the unlink succeeds in any
      // umask environment.
      chmodSync(slot.canonicalPath, 0o600);
      unlinkSync(slot.canonicalPath);
    }
  } catch {
    // best-effort
  }
}

/**
 * Resolve the canonical path of a candidate against the slot. Used
 * by Layer-A paths.ts to check whether a request's target is the
 * agent's own verdict slot (the only Write/Read allowed inside the
 * otherwise-protected `_verdicts/` subtree).
 */
export function isOwnSlot(candidate: string, slot: VerdictSlot): boolean {
  try {
    const real = realpathSync(resolve(candidate));
    return real === slot.canonicalPath;
  } catch {
    return false;
  }
}
