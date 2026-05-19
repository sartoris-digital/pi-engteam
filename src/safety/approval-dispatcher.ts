// src/safety/approval-dispatcher.ts
//
// PLAN.md ApprovalWatcher Phase 8 — ApprovalDispatcher + watcher core.
//
// The dispatcher owns the per-run drain loop. For each pending file in
// `<run>/approvals/pending/*.json`, it:
//   1. Acquires (already-held) per-run lease so only one controller
//      claims at a time. Phase 4's acquireLease is the gate.
//   2. Atomic-claims the pending file via rename to `<id>.json.dispatching`
//      so concurrent drains can't double-claim. Loser observes ENOENT
//      and moves on.
//   3. Validates the payload shape against the v1 schema. Anything
//      malformed gets moved to `<run>/approvals/quarantine/` with a
//      reason record. The dispatch loop does NOT spawn Judge for
//      malformed files.
//   4. Calls a caller-supplied `dispatchCallback(request)` to drive
//      the Judge invocation. The callback returns:
//         { kind: "granted" }    — Judge granted; .dispatching renamed
//                                  to <pendingDir>/<id>.json.granted so
//                                  CheckApproval can see the .granted
//                                  marker (token file is written by
//                                  GrantApproval, not here).
//         { kind: "denied", reason } — Judge denied; .dispatching is
//                                       moved to quarantine/ with the
//                                       deny reason.
//         { kind: "requeue" }    — transient failure; .dispatching is
//                                  renamed back to <id>.json for the
//                                  next drain pass to try again.
//   5. Sidecar retry counter: `meta/<id>.retry.json` tracks the number
//      of requeue attempts. After 3 the file is quarantined as
//      max-retries.
//
// The dispatcher is built around a polling tick so it's filesystem-
// agnostic (no fs.watch quirks). Default tick is 1s. The drain is
// idempotent — a tick that finds nothing returns immediately.
//
// Phase 8 deliberately keeps the dispatcher CALLBACK-DRIVEN; the
// actual Judge subprocess spawn is wired by the caller (ADWEngine
// integration lands in Phase 8/9 follow-up). This module enforces the
// atomic-claim + quarantine + retry-counter machinery so the watcher
// drain is correct regardless of how the Judge invocation is wired.

import { mkdir, rename, readFile, writeFile, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { ensureApprovalsLayout } from "./approval-fs.js";
import { acquireLease, releaseLease, startLeaseRenewal, type LeaseHandle } from "./approval-lease.js";
import { ALLOWED_OPS } from "./approvals.js";

const POLL_TICK_MS_DEFAULT = 1_000;
const MAX_RETRY_ATTEMPTS = 3;

export type PendingRequestV1 = {
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

export type DispatchOutcome =
  | { kind: "granted" }
  | { kind: "denied"; reason: string }
  | { kind: "requeue"; reason?: string };

export type DispatchCallback = (request: PendingRequestV1) => Promise<DispatchOutcome>;

export type DispatcherOptions = {
  runsDir: string;
  runId: string;
  dispatch: DispatchCallback;
  pollIntervalMs?: number;
  /**
   * Maximum requeue attempts per request before forced quarantine
   * (PLAN.md round-A4 LOW: bounded retries). Defaults to 3.
   */
  maxRetryAttempts?: number;
};

export type DispatcherHandle = {
  runId: string;
  lease: LeaseHandle;
  stop(): Promise<void>;
  /** Force a drain tick; useful for tests and operator-triggered rescans. */
  drainOnce(): Promise<{ dispatched: number; quarantined: number; requeued: number }>;
};

const REQUEST_FIELDS_REQUIRED = [
  "schemaVersion",
  "requestId",
  "runId",
  "op",
  "command",
  "justification",
  "argsHash",
  "issuedAtStepName",
  "issuedAtIteration",
  "issuedAtNonce",
  "createdAt",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validateRequest(raw: unknown, expectedRunId: string, expectedRequestId: string): PendingRequestV1 | { reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { reason: "not-an-object" };
  }
  const o = raw as Record<string, unknown>;
  for (const f of REQUEST_FIELDS_REQUIRED) {
    if (!(f in o)) return { reason: `missing-${f}` };
  }
  if (o.schemaVersion !== 1) return { reason: `unsupported-schema-version-${String(o.schemaVersion)}` };
  if (typeof o.requestId !== "string" || !UUID_RE.test(o.requestId)) return { reason: "invalid-requestId" };
  if (o.requestId !== expectedRequestId) return { reason: "requestId-mismatch-with-filename" };
  if (typeof o.runId !== "string" || o.runId.length === 0) return { reason: "invalid-runId" };
  if (o.runId !== expectedRunId) return { reason: "runId-mismatch-with-directory" };
  if (typeof o.op !== "string" || !ALLOWED_OPS.has(o.op)) return { reason: `unknown-op-${String(o.op).slice(0, 32)}` };
  if (typeof o.command !== "string" || o.command.length === 0 || o.command.length > 4096) return { reason: "invalid-command" };
  if (typeof o.justification !== "string" || o.justification.length > 4096) return { reason: "invalid-justification" };
  if (typeof o.argsHash !== "string" || o.argsHash.length === 0) return { reason: "invalid-argsHash" };
  if (typeof o.issuedAtStepName !== "string") return { reason: "invalid-issuedAtStepName" };
  if (typeof o.issuedAtIteration !== "number" || !Number.isFinite(o.issuedAtIteration)) return { reason: "invalid-issuedAtIteration" };
  if (typeof o.issuedAtNonce !== "string" || o.issuedAtNonce.length === 0) return { reason: "invalid-issuedAtNonce" };
  if (typeof o.createdAt !== "string") return { reason: "invalid-createdAt" };
  return o as PendingRequestV1;
}

async function quarantineFile(
  fromPath: string,
  approvalsDir: string,
  requestId: string,
  reason: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const quarantineDir = join(approvalsDir, "quarantine");
  await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  // Move the original file (so the dispatcher never re-picks it up)
  // and write an adjacent .reason.json with the diagnostic.
  const target = join(quarantineDir, `${requestId}.json`);
  try {
    await rename(fromPath, target);
  } catch {
    // If the file is gone (concurrent claim race) we still write the
    // diagnostic so the audit trail exists.
  }
  const reasonRecord = {
    reason,
    quarantinedAt: new Date().toISOString(),
    quarantineId: randomUUID(),
    context,
  };
  await writeFile(
    join(quarantineDir, `${requestId}.reason.json`),
    JSON.stringify(reasonRecord, null, 2),
    { mode: 0o600 },
  );
}

async function readRetryCounter(metaDir: string, requestId: string): Promise<number> {
  const path = join(metaDir, `${requestId}.retry.json`);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { attempts?: number };
    return typeof parsed.attempts === "number" && Number.isFinite(parsed.attempts) ? parsed.attempts : 0;
  } catch {
    return 0;
  }
}

async function writeRetryCounter(metaDir: string, requestId: string, attempts: number): Promise<void> {
  await mkdir(metaDir, { recursive: true, mode: 0o700 });
  const path = join(metaDir, `${requestId}.retry.json`);
  await writeFile(path, JSON.stringify({ requestId, attempts, updatedAt: new Date().toISOString() }), { mode: 0o600 });
}

async function drainOnce(
  pendingDir: string,
  approvalsDir: string,
  metaDir: string,
  runId: string,
  dispatch: DispatchCallback,
  maxRetryAttempts: number,
): Promise<{ dispatched: number; quarantined: number; requeued: number }> {
  let dispatched = 0;
  let quarantined = 0;
  let requeued = 0;
  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    return { dispatched, quarantined, requeued };
  }
  for (const name of entries) {
    // Strict UUID filter (PLAN.md item 17b): only <uuid>.json gets
    // dispatched; skip .tmp / .granted / .dispatching / non-uuid names.
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".tmp") || name.endsWith(".granted") || name.endsWith(".dispatching")) continue;
    const requestId = name.replace(/\.json$/, "");
    if (!UUID_RE.test(requestId)) continue;

    const pendingPath = join(pendingDir, name);
    const dispatchingPath = join(pendingDir, `${requestId}.json.dispatching`);

    // Atomic claim: rename pending/<id>.json → pending/<id>.json.dispatching.
    // Loser sees ENOENT and skips.
    try {
      await rename(pendingPath, dispatchingPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Other rename error: ignore this entry; next tick retries.
      continue;
    }

    // Read + validate.
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(dispatchingPath, "utf8"));
    } catch (err) {
      // Parse failure — quarantine with diagnostic.
      await quarantineFile(dispatchingPath, approvalsDir, requestId, "parse-failure", {
        error: err instanceof Error ? err.message : String(err),
      });
      quarantined++;
      continue;
    }
    const validated = validateRequest(raw, runId, requestId);
    if ("reason" in validated) {
      await quarantineFile(dispatchingPath, approvalsDir, requestId, validated.reason);
      quarantined++;
      continue;
    }

    // Dispatch (callback runs Judge or whatever the caller wires).
    let outcome: DispatchOutcome;
    try {
      outcome = await dispatch(validated);
    } catch (err) {
      // Callback threw — treat as requeue with reason.
      outcome = { kind: "requeue", reason: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.kind === "granted") {
      // Move .dispatching → .granted so CheckApproval / GrantApproval
      // see the granted marker. The actual token file is written by
      // GrantApproval (the callback either spawned the judge or
      // invoked GrantApproval directly).
      const grantedPath = join(pendingDir, `${requestId}.json.granted`);
      try {
        await rename(dispatchingPath, grantedPath);
        dispatched++;
      } catch {
        // If the rename failed, the callback may have already moved
        // the file. Treat as best-effort.
        dispatched++;
      }
      continue;
    }

    if (outcome.kind === "denied") {
      await quarantineFile(dispatchingPath, approvalsDir, requestId, `denied:${outcome.reason}`);
      quarantined++;
      continue;
    }

    // outcome.kind === "requeue" — bump counter, decide whether to
    // requeue or quarantine.
    const attempts = (await readRetryCounter(metaDir, requestId)) + 1;
    await writeRetryCounter(metaDir, requestId, attempts);
    if (attempts >= maxRetryAttempts) {
      await quarantineFile(dispatchingPath, approvalsDir, requestId, "max-retries", {
        attempts,
        lastReason: outcome.reason ?? null,
      });
      quarantined++;
      continue;
    }
    // Put it back as a regular pending file for the next tick.
    try {
      await rename(dispatchingPath, pendingPath);
      requeued++;
    } catch {
      // If the rename back failed (very unlikely), quarantine.
      await quarantineFile(dispatchingPath, approvalsDir, requestId, "requeue-rename-failed", {
        lastReason: outcome.reason ?? null,
      });
      quarantined++;
    }
  }
  return { dispatched, quarantined, requeued };
}

/**
 * Acquire the per-run lease, ensure the approvals layout exists, and
 * start the polling drain. The returned handle supports drainOnce()
 * for tests + operator-triggered rescans and stop() to release the
 * lease and tear down the timer.
 */
export async function registerApprovalDispatcher(opts: DispatcherOptions): Promise<DispatcherHandle | { ok: false; reason: string }> {
  const { runsDir, runId, dispatch } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_TICK_MS_DEFAULT;
  const maxRetryAttempts = opts.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS;

  const layout = await ensureApprovalsLayout(runsDir, runId);
  if (!layout.ok) {
    return { ok: false, reason: `layout-${layout.reason}: ${layout.detail}` };
  }

  const runDir = join(runsDir, runId);
  const leaseResult = await acquireLease(runDir);
  if (!leaseResult.ok) {
    return { ok: false, reason: `lease-${leaseResult.reason}` };
  }
  startLeaseRenewal(leaseResult.handle);

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const runDrain = async () => {
    if (stopped) return;
    try {
      await drainOnce(layout.pendingDir, join(runDir, "approvals"), layout.metaDir, runId, dispatch, maxRetryAttempts);
    } catch {
      // Best-effort: a failed tick is logged at the call site; next tick retries.
    }
  };

  timer = setInterval(() => { void runDrain(); }, pollIntervalMs);
  timer.unref?.();

  return {
    runId,
    lease: leaseResult.handle,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await releaseLease(leaseResult.handle);
    },
    async drainOnce() {
      return drainOnce(layout.pendingDir, join(runDir, "approvals"), layout.metaDir, runId, dispatch, maxRetryAttempts);
    },
  };
}

/**
 * Internal helpers exposed for unit testing only.
 */
export const __test = { validateRequest, drainOnce, quarantineFile, readRetryCounter, writeRetryCounter };
