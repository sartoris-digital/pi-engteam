// src/safety/approval-operability.ts
//
// PLAN.md ApprovalWatcher Phase 9 — operability primitives.
//
// Three Phase 9 deliverables, kept as small focused helpers so each
// can be wired into the dispatcher / boot path independently:
//
//   - migrateLegacyTokensToV2: one-shot rewrite of pre-Phase-7 tokens
//     (no pauseEpoch field) under the new HMAC payload. Stamps every
//     legacy token with pauseEpoch:0 and re-signs.
//
//   - DispatcherCounters: in-memory counters for dispatch/quarantine/
//     requeue rates, with periodic JSONL audit dumps. Lets operators
//     spot a runaway quarantine rate before the run wedges.
//
//   - installShutdownHandlers: SIGINT / SIGTERM hook that calls a
//     graceful-stop callback on the dispatcher handle. Run as the
//     watcher core starts up so a kill -INT doesn't leave orphan
//     `.dispatching` files or an unreleased lease.

import { readFile, writeFile, readdir, mkdir, appendFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { signToken, tokenSigningPayload, ALLOWED_OPS } from "./approvals.js";
import type { ApprovalToken } from "../types.js";

/**
 * Counters tracked per registered dispatcher. Operators read these
 * via `/approval-status` (Phase 2's read-only command, wired in Phase
 * 9 follow-up) for at-a-glance health.
 */
export type DispatcherCounters = {
  dispatched: number;
  quarantined: number;
  requeued: number;
  drainTicks: number;
  drainErrors: number;
  lastDrainAt: string | null;
  lastQuarantineAt: string | null;
  lastQuarantineReason: string | null;
};

export function emptyCounters(): DispatcherCounters {
  return {
    dispatched: 0,
    quarantined: 0,
    requeued: 0,
    drainTicks: 0,
    drainErrors: 0,
    lastDrainAt: null,
    lastQuarantineAt: null,
    lastQuarantineReason: null,
  };
}

export function recordDrainTick(c: DispatcherCounters, result: { dispatched: number; quarantined: number; requeued: number }, reason?: string): void {
  c.drainTicks++;
  c.dispatched += result.dispatched;
  c.quarantined += result.quarantined;
  c.requeued += result.requeued;
  c.lastDrainAt = new Date().toISOString();
  if (result.quarantined > 0 && reason) {
    c.lastQuarantineAt = c.lastDrainAt;
    c.lastQuarantineReason = reason;
  }
}

const OPERABILITY_AUDIT_PATH = () =>
  join(homedir(), ".pi", "engineering-team", "approval-watcher-metrics.jsonl");

/**
 * Append a counter snapshot to the metrics JSONL. Best-effort —
 * a failed write is logged and skipped; the counters live in-memory
 * for the next snapshot. Counter snapshots are append-only so the
 * operator can grep historical rates.
 */
export async function snapshotCounters(runId: string, counters: DispatcherCounters): Promise<void> {
  try {
    await mkdir(join(homedir(), ".pi", "engineering-team"), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, pid: process.pid, ...counters }) + "\n";
    await appendFile(OPERABILITY_AUDIT_PATH(), line, { mode: 0o600 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[approval-watcher] metrics snapshot failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Threshold check for high quarantine rate. If `quarantined / drainTicks`
 * exceeds the threshold AND drainTicks >= minTicks, returns true. The
 * caller's job is to emit a user-visible warning event so the operator
 * can investigate.
 */
export function quarantineRateExceeds(counters: DispatcherCounters, threshold: number, minTicks: number): boolean {
  if (counters.drainTicks < minTicks) return false;
  if (counters.dispatched + counters.quarantined === 0) return false;
  const rate = counters.quarantined / Math.max(1, counters.dispatched + counters.quarantined);
  return rate > threshold;
}

/**
 * One-shot legacy token migration. Scans `<approvalsDir>/*.json`,
 * finds tokens that have a signature but no pauseEpoch field, and
 * rewrites them with pauseEpoch=0 + a fresh signature under the new
 * HMAC payload (tokenSigningPayload).
 *
 * MUST be called under the per-run lease (Phase 4) so no concurrent
 * writer / dispatcher races a token mid-migration. Returns counts of
 * { migrated, skipped, errors }.
 *
 * Pre-Phase-7 contract for tokens: HMAC over
 *   `${runId}:${tokenId}:${op}:${argsHash}:${expiresAt}`
 * Phase 7 contract:
 *   `${runId}:${tokenId}:${op}:${argsHash}:${expiresAt}:pauseEpoch=${pauseEpoch}`
 *
 * Migration verifies the legacy signature first (so we don't migrate
 * tampered tokens), then signs under the new payload with pauseEpoch:0
 * and atomic-writes via temp+rename.
 */
export async function migrateLegacyTokensToV2(
  approvalsDir: string,
  secret: string,
): Promise<{ migrated: number; skipped: number; errors: number }> {
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let entries: string[];
  try {
    entries = await readdir(approvalsDir);
  } catch {
    return { migrated, skipped, errors };
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.endsWith(".consumed")) continue;
    if (name.endsWith(".granted")) continue;
    const path = join(approvalsDir, name);
    let parsed: ApprovalToken;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as ApprovalToken;
    } catch {
      errors++;
      continue;
    }
    // Already migrated — has pauseEpoch.
    if (typeof parsed.pauseEpoch === "number" && Number.isFinite(parsed.pauseEpoch)) {
      skipped++;
      continue;
    }
    // Validate the legacy signature: HMAC over (runId, tokenId, op, argsHash, expiresAt).
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.tokenId !== "string" ||
      typeof parsed.op !== "string" ||
      typeof parsed.argsHash !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.signature !== "string"
    ) {
      errors++;
      continue;
    }
    if (!ALLOWED_OPS.has(parsed.op)) {
      errors++;
      continue;
    }
    // Recompute the LEGACY payload for verification (without pauseEpoch=).
    const legacyPayload = `${parsed.runId}:${parsed.tokenId}:${parsed.op}:${parsed.argsHash}:${parsed.expiresAt}`;
    const { createHmac, timingSafeEqual } = await import("crypto");
    const expectedLegacy = createHmac("sha256", secret).update(legacyPayload).digest("hex");
    if (parsed.signature.length !== expectedLegacy.length) {
      errors++;
      continue;
    }
    const a = Buffer.from(expectedLegacy, "hex");
    const b = Buffer.from(parsed.signature, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      errors++;
      continue;
    }
    // Re-sign under the v2 payload with pauseEpoch=0.
    const newSignature = signToken(
      secret,
      parsed.tokenId,
      parsed.op,
      parsed.argsHash,
      parsed.expiresAt,
      parsed.runId,
      0,
    );
    const migratedToken: ApprovalToken = { ...parsed, pauseEpoch: 0, signature: newSignature };
    // Atomic write via tmp+rename.
    const tmp = path + ".migrate.tmp";
    try {
      await writeFile(tmp, JSON.stringify(migratedToken, null, 2), { mode: 0o600 });
      const { rename } = await import("fs/promises");
      await rename(tmp, path);
      migrated++;
    } catch {
      errors++;
    }
  }
  return { migrated, skipped, errors };
}

/**
 * Install SIGINT / SIGTERM handlers that call the supplied stop callback.
 * Returns a disposer that removes the listeners (idempotent). The stop
 * callback runs once even if both signals arrive — subsequent signals
 * are ignored (operator can SIGKILL if truly wedged).
 *
 * The handlers do NOT process.exit() — they let the stop callback
 * complete and assume normal shutdown follows.
 */
export function installShutdownHandlers(stop: () => Promise<void>): () => void {
  let firing = false;
  const handler = (sig: NodeJS.Signals) => {
    if (firing) return;
    firing = true;
    // eslint-disable-next-line no-console
    console.error(`[approval-watcher] received ${sig}; draining + releasing lease...`);
    void stop().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[approval-watcher] shutdown error:`, err);
    });
  };
  const onInt = () => handler("SIGINT");
  const onTerm = () => handler("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

/**
 * Reference also: signing payload exported for callers that need to
 * compute legacy-vs-current HMAC compatibility checks. tokenSigningPayload
 * lives in approvals.ts; reused here so the migration helper isn't
 * importing two crypto layers.
 */
export { tokenSigningPayload };
