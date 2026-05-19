// src/team/tools/RequestApproval.ts
//
// PLAN.md ApprovalWatcher Phase 5 — RequestApproval updates.
//
// The pre-watcher implementation wrote `pending/<id>.json` directly with
// minimal metadata. The watcher (lands in Phase 8) drains pending files
// concurrently, so the writer side must:
//
//   1. Use the Phase 3 layout helper to guarantee approvals/pending/
//      exists at 0o700 with symlink-rejection (no chmod-through-link).
//   2. Hold a per-run admission lock for the entire scan+write critical
//      section so the duplicate-collapse + cap check + write triplet is
//      atomic against concurrent RequestApproval calls in the same run.
//      (PLAN.md item 121, round-A4 MEDIUM 2, round-A6 HIGH 3.)
//   3. Stamp the payload with issuedAtStepName, issuedAtIteration,
//      issuedAtNonce, schemaVersion, and argsHash so the watcher can
//      detect duplicates and the operator-facing audit trail is rich.
//   4. Write `pending/<id>.json.tmp` first then atomically rename it
//      into place so the drain never observes a partial JSON parse.
//      (PLAN.md item 6.)
//   5. Return a `pollHint` field on the response. Until Phase 8 wires
//      per-run canary gating, the hint defaults to `next_tool_call` so
//      legacy NEEDS_MORE re-dispatch continues to work. The field is
//      additive — existing callers ignore it cleanly. (PLAN.md item
//      287 + round-A7 LOW: canonical name `pollHint`.)
//
// Duplicate collapse (PLAN.md item 127): if a pending file with the
// same op + argsHash + issuedAtStepName + issuedAtIteration already
// exists for this run, RequestApproval returns its existing requestId
// without writing a new file. This is the defense against a retry-
// storming worker generating fresh requestIds for the same logical
// request.

import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFile, rename, readdir, readFile, mkdir, rmdir, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { ensureApprovalsLayout } from "../../safety/approval-fs.js";
import { hashArgs } from "../../safety/approvals.js";
import { loadRunState } from "../../adw/RunState.js";
import { loadSafetyConfig } from "../../config.js";
import type { RequestApprovalPollHint } from "../../types.js";

const ADMISSION_LOCK_DIR = ".approval-admission.lock";
const ADMISSION_MAX_WAIT_MS = 5_000;
const ADMISSION_POLL_BASE_MS = 10;
const ADMISSION_POLL_JITTER_MS = 20;
const REQUEST_SCHEMA_VERSION = 1;
const COMMAND_MAX_LEN = 4096;
const JUSTIFICATION_MAX_LEN = 4096;

type PendingRequestV1 = {
  schemaVersion: 1;
  requestId: string;
  runId: string;
  op: string;
  command: string;
  justification: string;
  argsHash: string;
  issuedAtStepName: string;
  issuedAtIteration: number;
  issuedAtNonce: string;
  createdAt: string;
};

async function acquireAdmissionLock(runDir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const lockDir = join(runDir, ADMISSION_LOCK_DIR);
  const deadline = Date.now() + ADMISSION_MAX_WAIT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return { ok: true };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") {
        return { ok: false, reason: `admission-lock fs-error: ${e.message}` };
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: "admission-lock-timeout" };
      }
      const jitter = ADMISSION_POLL_BASE_MS + Math.floor(Math.random() * ADMISSION_POLL_JITTER_MS);
      await new Promise((r) => setTimeout(r, jitter));
    }
  }
}

async function releaseAdmissionLock(runDir: string): Promise<void> {
  try {
    await rmdir(join(runDir, ADMISSION_LOCK_DIR));
  } catch {
    // Best-effort. Loser of a stale-recovery race wins anyway.
  }
}

/**
 * Scan pending/ for an existing request with the same logical
 * fingerprint. Returns the existing requestId so the caller can collapse
 * the duplicate (PLAN.md item 127).
 *
 * Fingerprint: op + argsHash + issuedAtStepName + issuedAtIteration.
 * The runId is implied by directory scope.
 */
async function findDuplicate(
  pendingDir: string,
  fingerprint: { op: string; argsHash: string; issuedAtStepName: string; issuedAtIteration: number },
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".tmp")) continue;
    try {
      const raw = await readFile(join(pendingDir, name), "utf8");
      const parsed = JSON.parse(raw) as Partial<PendingRequestV1>;
      if (
        parsed.op === fingerprint.op &&
        parsed.argsHash === fingerprint.argsHash &&
        parsed.issuedAtStepName === fingerprint.issuedAtStepName &&
        parsed.issuedAtIteration === fingerprint.issuedAtIteration &&
        typeof parsed.requestId === "string"
      ) {
        return parsed.requestId;
      }
    } catch {
      // Skip unparseable files — the watcher's quarantine path handles them.
    }
  }
  return null;
}

async function countPendingFiles(pendingDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    return 0;
  }
  return entries.filter((n) => n.endsWith(".json") && !n.endsWith(".tmp")).length;
}

export function createRequestApprovalTool(runsDir: string, runId: string) {
  return defineTool({
    name: "RequestApproval",
    label: "Request Approval",
    description:
      "Request approval from the Judge before executing a destructive operation. Wait for GrantApproval before proceeding.",
    parameters: Type.Object({
      op: Type.String({
        description: "Operation type: 'git-push'|'npm-install-new'|'migration'|'bash'|'write'|'edit'",
      }),
      command: Type.String({ description: "The exact command or file path that requires approval" }),
      justification: Type.String({ description: "Why this operation is necessary for the current task" }),
    }),
    execute: async (_id, params) => {
      // Phase 5 input clamps. The downstream GrantApproval already
      // validates these, but rejecting at the writer side prevents
      // disk fill with oversized junk and makes the error path crisp.
      if (typeof params.command !== "string" || params.command.length === 0 || params.command.length > COMMAND_MAX_LEN) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `command must be 1..${COMMAND_MAX_LEN} chars` }),
            },
          ],
          details: {},
        };
      }
      if (typeof params.justification !== "string" || params.justification.length > JUSTIFICATION_MAX_LEN) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `justification must be <= ${JUSTIFICATION_MAX_LEN} chars` }),
            },
          ],
          details: {},
        };
      }

      // 1) Layout: ensure approvals/{pending,meta,quarantine} exist at
      // 0o700 with symlink-rejection. Refuse the request if the layout
      // is unsafe — the watcher cannot proceed anyway, so failing fast
      // is better than writing a pending file into a hostile tree.
      const layout = await ensureApprovalsLayout(runsDir, runId);
      if (!layout.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `approvals layout unsafe: ${layout.reason} at ${layout.suspectPath}; ${layout.detail}`,
              }),
            },
          ],
          details: {},
        };
      }

      const runDir = join(runsDir, runId);
      const pendingDir = layout.pendingDir;

      // 2) Pre-compute payload metadata (outside the lock so the
      // critical section is short).
      const safety = await loadSafetyConfig();
      const maxPendingPerRun = safety.approvalWatcher?.maxPendingPerRun ?? 100;
      const state = await loadRunState(runsDir, runId).catch(() => null);
      const issuedAtStepName = state?.currentStep ?? "";
      const issuedAtIteration = state?.iteration ?? 0;
      const argsHash = hashArgs({ op: params.op, command: params.command });

      // 3) Acquire admission lock — atomic mkdir of <run>/.approval-admission.lock
      const lockResult = await acquireAdmissionLock(runDir);
      if (!lockResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `failed to acquire approval admission lock: ${lockResult.reason}`,
              }),
            },
          ],
          details: {},
        };
      }

      try {
        // 4) Duplicate collapse: if same op+argsHash+step+iteration is
        // already pending, return its requestId without writing.
        const duplicateOf = await findDuplicate(pendingDir, {
          op: params.op,
          argsHash,
          issuedAtStepName,
          issuedAtIteration,
        });
        if (duplicateOf) {
          const pollHint: RequestApprovalPollHint = "next_tool_call";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  requestId: duplicateOf,
                  pollHint,
                  status: "duplicate-of-existing",
                  message: "An equivalent request is already pending for this step+iteration; reusing its requestId.",
                }),
              },
            ],
            details: {},
          };
        }

        // 5) Cap enforcement under the lock — TOCTOU-safe.
        const currentCount = await countPendingFiles(pendingDir);
        if (currentCount >= maxPendingPerRun) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  refused: "per-run-pending-cap",
                  error: `run ${runId} has ${currentCount} pending approval requests (cap ${maxPendingPerRun}). Wait for in-flight approvals to drain or run /approval-watcher reengage.`,
                }),
              },
            ],
            details: {},
          };
        }

        // 6) Mint requestId + build canonical payload.
        const requestId = crypto.randomUUID();
        const request: PendingRequestV1 = {
          schemaVersion: REQUEST_SCHEMA_VERSION,
          requestId,
          runId,
          op: params.op,
          command: params.command,
          justification: params.justification,
          argsHash,
          issuedAtStepName,
          issuedAtIteration,
          issuedAtNonce: randomBytes(8).toString("hex"),
          createdAt: new Date().toISOString(),
        };

        // 7) Atomic write: <id>.json.tmp then rename. The drain never
        // observes the .tmp suffix (it filters on `.json` exact).
        const finalPath = join(pendingDir, `${requestId}.json`);
        const tmpPath = `${finalPath}.tmp`;
        try {
          await writeFile(tmpPath, JSON.stringify(request, null, 2), { mode: 0o600 });
          await rename(tmpPath, finalPath);
        } catch (err) {
          // Cleanup tmp leftover if rename failed.
          try {
            await unlink(tmpPath);
          } catch {
            /* tmp may not exist */
          }
          throw err;
        }

        // 8) Response with pollHint. Until Phase 8 wires per-run
        // canary gating + CheckApproval registration, the default is
        // "next_tool_call" so legacy NEEDS_MORE re-dispatch continues
        // to drive approvals.
        const pollHint: RequestApprovalPollHint = "next_tool_call";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                requestId,
                pollHint,
                message: "Approval request submitted. The Judge will review and grant or deny.",
              }),
            },
          ],
          details: {},
        };
      } finally {
        await releaseAdmissionLock(runDir);
      }
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(`${theme.fg("warning", "⚠ request")}  ${args.op}  ${args.command}`);
      return text;
    },
    renderResult(result, _options, _theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const raw = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      try {
        const parsed = JSON.parse(raw) as { requestId?: string; refused?: string; status?: string };
        if (parsed.refused) {
          text.setText(`refused  ${parsed.refused}`);
        } else if (parsed.status === "duplicate-of-existing") {
          text.setText(`dedup  requestId=${parsed.requestId ?? "?"}`);
        } else {
          text.setText(`pending  requestId=${parsed.requestId ?? "?"}`);
        }
      } catch {
        text.setText(raw);
      }
      return text;
    },
  });
}
