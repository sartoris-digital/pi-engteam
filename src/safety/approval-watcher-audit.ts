// src/safety/approval-watcher-audit.ts
//
// PLAN.md ApprovalWatcher Phase 2 (item 17a).
//
// Every approval-watcher mutation (pause/resume/reengage/extend-hold/
// rescan/resume-after-emergency) writes a single audit line to
// `~/.pi/engineering-team/approval-watcher-audit.jsonl` so operator
// actions are recoverable post-incident.
//
// The audit log is append-only — we never rewrite history. Writes
// are atomic at line granularity via `fs.appendFile` (POSIX guarantees
// up to PIPE_BUF; lines are <1KB so writes are non-interleaving even
// under concurrent access).

import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

export type ApprovalAuditAction =
  | "pause"
  | "resume"
  | "reengage"
  | "extend-hold"
  | "rescan"
  | "resume-after-emergency"
  | "emergency-stop";

export type ApprovalAuditLine = {
  /** ISO timestamp at which the action was applied. */
  ts: string;
  /** Audit-line unique identifier (UUID-shaped; never reused). */
  auditId: string;
  /** Action taken. */
  action: ApprovalAuditAction;
  /** Optional run scope — global actions (pause/resume/rescan) omit this. */
  runId?: string;
  /** Operator-supplied reason — required for emergency actions, optional otherwise. */
  reason?: string;
  /** Action-specific structured payload. */
  payload?: Record<string, unknown>;
  /** PID of the process that wrote the line (audit recoverability). */
  pid: number;
};

const AUDIT_PATH = () => join(homedir(), ".pi", "engineering-team", "approval-watcher-audit.jsonl");

function newAuditId(): string {
  const b = randomBytes(16);
  // RFC4122 v4 shape
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function writeApprovalAuditLine(line: Omit<ApprovalAuditLine, "ts" | "auditId" | "pid">): Promise<ApprovalAuditLine> {
  const path = AUDIT_PATH();
  const full: ApprovalAuditLine = {
    ts: new Date().toISOString(),
    auditId: newAuditId(),
    pid: process.pid,
    ...line,
  };
  try {
    await mkdir(join(homedir(), ".pi", "engineering-team"), { recursive: true, mode: 0o700 });
    await appendFile(path, JSON.stringify(full) + "\n", { mode: 0o600 });
  } catch (err) {
    // Audit-log write failure is operator-visible but does NOT block
    // the action itself (logs are diagnostic, not authoritative). The
    // action's primary effect — the config flag flip — already
    // happened.
    // eslint-disable-next-line no-console
    console.error(
      "[approval-watcher] audit log write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return full;
}
