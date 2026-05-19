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
import { writeFile, rename, readdir, readFile, mkdir, rmdir, unlink, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { randomBytes } from "crypto";
import { hostname } from "os";
import { ensureApprovalsLayout } from "../../safety/approval-fs.js";
import { hashArgs, ALLOWED_OPS } from "../../safety/approvals.js";
import { loadRunState } from "../../adw/RunState.js";
import { loadSafetyConfig } from "../../config.js";
import type { RequestApprovalPollHint } from "../../types.js";

const ADMISSION_LOCK_DIR = ".approval-admission.lock";
const ADMISSION_OWNER_FILE = "owner.json";
const ADMISSION_MAX_WAIT_MS = 5_000;
const ADMISSION_POLL_BASE_MS = 10;
const ADMISSION_POLL_JITTER_MS = 20;
// Phase 5 review round-2 HIGH 2: admission lock stale-recovery
// thresholds. Same-host PID-death OR cross-host TTL — generous enough
// that a legitimately-busy holder finishes long before they apply.
const ADMISSION_OWNER_STALE_MS = 30_000;
const ADMISSION_LOCK_DIR_MIN_AGE_MS = 500;
const REQUEST_SCHEMA_VERSION = 1;
const COMMAND_MAX_LEN = 4096;
const JUSTIFICATION_MAX_LEN = 4096;

type AdmissionOwner = {
  pid: number;
  hostname: string;
  instanceId: string;
  acquiredAt: string;
};

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

async function readAdmissionOwner(ownerPath: string): Promise<AdmissionOwner | "absent" | "malformed"> {
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return "absent";
    return "malformed";
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AdmissionOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.instanceId === "string" &&
      typeof parsed.acquiredAt === "string"
    ) {
      return parsed as AdmissionOwner;
    }
    return "malformed";
  } catch {
    return "malformed";
  }
}

function isAdmissionOwnerStale(owner: AdmissionOwner): boolean {
  const ageMs = Date.now() - Date.parse(owner.acquiredAt);
  if (!Number.isFinite(ageMs)) return true;
  if (ageMs < 0) return false; // future-skew tolerance
  if (owner.hostname === hostname()) {
    // Same-host: dead PID + any age, OR alive but absurdly old.
    if (owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return ageMs > ADMISSION_OWNER_STALE_MS;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ESRCH") return true; // dead → stale
        return ageMs > ADMISSION_OWNER_STALE_MS;
      }
    }
  }
  return ageMs > ADMISSION_OWNER_STALE_MS;
}

async function forceRemoveAdmission(lockDir: string, ownerPath: string): Promise<void> {
  try { await unlink(ownerPath); } catch { /* may not exist */ }
  try { await rmdir(lockDir); } catch { /* may already be gone */ }
}

/**
 * Acquire the per-run admission lock with crash-safe stale recovery.
 * Phase 5 review round-2 HIGH 2 + round-1 MEDIUM 1: the previous
 * impl was ownerless — a crashed RequestApproval left the run wedged
 * for the rest of its life. Now we mkdir + write owner metadata, and
 * contenders apply same-host PID-death recovery and an
 * ADMISSION_OWNER_STALE_MS TTL on the acquiredAt timestamp.
 */
async function acquireAdmissionLock(
  runDir: string,
): Promise<{ ok: true; instanceId: string } | { ok: false; reason: string }> {
  const lockDir = join(runDir, ADMISSION_LOCK_DIR);
  const ownerPath = join(lockDir, ADMISSION_OWNER_FILE);
  const deadline = Date.now() + ADMISSION_MAX_WAIT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      // We won the mkdir — write owner.json so contenders can identify us.
      const instanceId = randomBytes(8).toString("hex");
      const owner: AdmissionOwner = {
        pid: process.pid,
        hostname: hostname(),
        instanceId,
        acquiredAt: new Date().toISOString(),
      };
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      } catch (err) {
        // Back out the lock so we don't wedge.
        await forceRemoveAdmission(lockDir, ownerPath);
        return { ok: false, reason: `admission-lock owner-write failed: ${(err as Error).message}` };
      }
      return { ok: true, instanceId };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") {
        return { ok: false, reason: `admission-lock fs-error: ${e.message}` };
      }
      // Lock dir exists. Inspect owner.json — recover if stale.
      const ownerRead = await readAdmissionOwner(ownerPath);
      if (typeof ownerRead === "object" && isAdmissionOwnerStale(ownerRead)) {
        await forceRemoveAdmission(lockDir, ownerPath);
        // Loop back to retry mkdir.
      } else if (ownerRead === "absent") {
        // Owner missing — only force-remove if the lock dir is older
        // than ADMISSION_LOCK_DIR_MIN_AGE_MS (otherwise we'd race a
        // legitimate winner who's about to write owner.json).
        try {
          const st = await stat(lockDir);
          if (Date.now() - st.mtimeMs > ADMISSION_LOCK_DIR_MIN_AGE_MS) {
            await forceRemoveAdmission(lockDir, ownerPath);
          }
        } catch {
          // Lock dir vanished — retry mkdir.
        }
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: "admission-lock-timeout" };
      }
      const jitter = ADMISSION_POLL_BASE_MS + Math.floor(Math.random() * ADMISSION_POLL_JITTER_MS);
      await new Promise((r) => setTimeout(r, jitter));
    }
  }
}

async function releaseAdmissionLock(runDir: string, instanceId: string): Promise<void> {
  const lockDir = join(runDir, ADMISSION_LOCK_DIR);
  const ownerPath = join(lockDir, ADMISSION_OWNER_FILE);
  // Only release if we still own the lock. If a stale-recovery
  // contender stole it, leave their lock + owner intact.
  const current = await readAdmissionOwner(ownerPath);
  if (typeof current === "object" && current.instanceId !== instanceId) return;
  try { await unlink(ownerPath); } catch { /* may not exist */ }
  try { await rmdir(lockDir); } catch { /* may not exist */ }
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
  // Phase 5 review round-2 HIGH 1: containment check on each path
  // BEFORE reading. readdir returns base names but a hostile filesystem
  // or a misconfigured entry could let a join escape the pending dir;
  // explicit resolve+startsWith catches anything that resolves outside.
  const resolvedRoot = resolve(pendingDir);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".tmp")) continue;
    // Defense in depth: reject names with path separators or null bytes
    // outright — readdir on POSIX returns base names, but better safe.
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) continue;
    const candidate = resolve(pendingDir, name);
    if (candidate !== resolvedRoot && !candidate.startsWith(rootWithSep)) continue;
    try {
      const raw = await readFile(candidate, "utf8");
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
      // Phase 5 review round-2 MEDIUM 1: enforce ALLOWED_OPS at the
      // writer side. The downstream GrantApproval rejects unknown ops,
      // but accepting them here wastes pending capacity and produces
      // junk in approvals/pending/ until the watcher quarantines them.
      if (typeof params.op !== "string" || !ALLOWED_OPS.has(params.op)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `op must be one of: ${Array.from(ALLOWED_OPS).join(", ")} (got ${JSON.stringify(params.op)})`,
              }),
            },
          ],
          details: {},
        };
      }
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
      // with owner metadata + stale recovery.
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
      const admissionInstanceId = lockResult.instanceId;

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
        await releaseAdmissionLock(runDir, admissionInstanceId);
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
