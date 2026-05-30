// src/safety/controllerApproval.ts
//
// Phase 2: _controller pseudo-run context for /approve + /deny command fallback.
// When the inline overlay (Phase 1 ConfirmInput) is unavailable (headless /
// non-TUI controller), the operator can pre-authorize a pending op by typing
// `/approve` — which calls mintControllerToken here — and the next tool-call
// that hits findValidApproval in SafetyGuard.ts will find and consume the
// token exactly as it would for a real run.
//
// Security notes:
//   - The _controller dir is Layer-A blocked in paths.ts so agents can't
//     cat the secret or write forged tokens via Write/Edit.
//   - The controller HMAC secret is held ONLY in process memory (never
//     written to disk), so the agent's Bash cannot read it via a glob and
//     forge an operator-approval token.
//   - Tokens are HMAC-signed with the same signToken machinery as GrantApproval.
//   - mintControllerToken validates op against ALLOWED_OPS before writing.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { ALLOWED_OPS, generateRunSecret, signToken } from "./approvals.js";
import { loadSafetyConfigStrict } from "../config.js";

/** The pseudo-run id for the controller approval context. */
export const CONTROLLER_RUN_ID = "_controller";

/** Absolute path to the _controller dir inside runsDir. */
export function controllerDir(runsDir: string): string {
  return join(runsDir, CONTROLLER_RUN_ID);
}

// ---------------------------------------------------------------------------
// Ephemeral in-memory HMAC secret — never written to disk.
// ---------------------------------------------------------------------------

/**
 * Ephemeral per-process HMAC secret for controller operator-approval tokens.
 * Held only in memory — never written to disk — so the agent's Bash cannot
 * read it (closing the _controller/.secret glob-forge). Lazily generated on
 * first use; shared by mintControllerToken and findValidApproval within the
 * single controller process. Not persisted: tokens are valid only for the
 * current session, which suffices for the /approve → re-run flow.
 */
let controllerSecret: string | null = null;

export function getControllerSecret(): string {
  if (!controllerSecret) controllerSecret = generateRunSecret();
  return controllerSecret;
}

/** Test-only reset so unit tests don't leak the singleton across cases. */
export function __resetControllerSecretForTest(): void {
  controllerSecret = null;
}

/**
 * Ensure the _controller dir (0o700) and its approvals subdir (0o700) exist.
 * On first call, best-effort removes any stale .secret file left by the
 * previous on-disk design so it can't mislead anything. NO .secret is ever
 * written by this function.
 */
export async function ensureControllerApprovalsDir(runsDir: string): Promise<void> {
  const dir = controllerDir(runsDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(join(dir, "approvals"), { recursive: true, mode: 0o700 });
  // Remove any stale .secret left by the old on-disk design.
  const staleSecret = join(dir, ".secret");
  if (existsSync(staleSecret)) {
    try {
      await unlink(staleSecret);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Non-fatal: log but don't block normal operation.
        // Stale file remains but in-memory secret is still never exposed.
      }
    }
  }
}

export type MintControllerTokenOpts = {
  op: string;
  argsHash: string;
  /** Desired TTL in seconds; capped at the config ceiling (default 300). */
  ttlSeconds?: number;
};

export type MintControllerTokenResult = {
  tokenId: string;
  expiresAt: string;
};

/**
 * Mint a short-TTL HMAC approval token in the _controller pseudo-run context.
 * Writes the token to <runsDir>/_controller/approvals/<tokenId>.json with the
 * SAME shape as GrantApproval so findValidApproval can verify + consume it.
 *
 * Throws if op is not in ALLOWED_OPS or if the safety config fails to load.
 */
export async function mintControllerToken(
  runsDir: string,
  opts: MintControllerTokenOpts,
): Promise<MintControllerTokenResult> {
  const { op, argsHash, ttlSeconds } = opts;

  if (!ALLOWED_OPS.has(op)) {
    throw new Error(`mintControllerToken: op "${op}" is not in ALLOWED_OPS.`);
  }

  await ensureControllerApprovalsDir(runsDir);
  const secret = getControllerSecret();

  // Load pauseEpoch + tokenTtlSeconds ceiling from safety config.
  // loadSafetyConfigStrict throws on parse error (fail-closed); ENOENT → defaults.
  const safety = await loadSafetyConfigStrict();
  const currentPauseEpoch: number = safety.approvalWatcher?.pauseEpoch ?? 0;
  const configCeiling: number = safety.tokenTtlSeconds ?? 300;
  const ttl = Math.min(ttlSeconds ?? configCeiling, configCeiling);

  const tokenId = randomUUID();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const scope = "once" as const;

  const signature = signToken(
    secret,
    tokenId,
    op,
    argsHash,
    expiresAt,
    CONTROLLER_RUN_ID,
    currentPauseEpoch,
  );

  // Token shape MUST match GrantApproval's exactly so verifyToken accepts it.
  const token = {
    tokenId,
    runId: CONTROLLER_RUN_ID,
    op,
    argsHash,
    scope,
    expiresAt,
    signature,
    pauseEpoch: currentPauseEpoch,
    consumed: false,
    grantedAt: new Date().toISOString(),
  };

  const approvalsDir = join(controllerDir(runsDir), "approvals");
  await writeFile(
    join(approvalsDir, `${tokenId}.json`),
    JSON.stringify(token, null, 2),
    { mode: 0o600 },
  );

  return { tokenId, expiresAt };
}

// ---------------------------------------------------------------------------
// Pending-block record — lets /approve know what op is waiting for approval.
// ---------------------------------------------------------------------------

export type PendingControllerApproval = {
  op: string;
  argsHash: string;
  display: string;
  ts: string;
};

/**
 * Write a pending-approval record so the operator can inspect + /approve it.
 * The file lives at <runsDir>/_controller/pending-approval.json (mode 0o600).
 * Overwrites any previously pending record (one-at-a-time model).
 */
export async function recordPendingControllerApproval(
  runsDir: string,
  opts: { op: string; argsHash: string; display: string },
): Promise<void> {
  const dir = controllerDir(runsDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record: PendingControllerApproval = {
    op: opts.op,
    argsHash: opts.argsHash,
    display: opts.display,
    ts: new Date().toISOString(),
  };
  await writeFile(
    join(dir, "pending-approval.json"),
    JSON.stringify(record, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Read the pending-approval record, or return null if there is none.
 */
export async function readPendingControllerApproval(
  runsDir: string,
): Promise<PendingControllerApproval | null> {
  try {
    const raw = await readFile(
      join(controllerDir(runsDir), "pending-approval.json"),
      "utf8",
    );
    return JSON.parse(raw) as PendingControllerApproval;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Delete the pending-approval record. Ignores ENOENT (idempotent).
 */
export async function clearPendingControllerApproval(runsDir: string): Promise<void> {
  try {
    await unlink(join(controllerDir(runsDir), "pending-approval.json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
