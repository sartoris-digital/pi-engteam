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
//   - bash-redirection forge (`bash cmd > _controller/.secret`) is a
//     pre-existing residual risk for all run secrets; out of scope here.
//   - Tokens are HMAC-signed with the same signToken machinery as GrantApproval.
//   - mintControllerToken validates op against ALLOWED_OPS before writing.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { ALLOWED_OPS, generateRunSecret, signToken } from "./approvals.js";
import { loadSafetyConfigStrict } from "../config.js";

/** The pseudo-run id for the controller approval context. */
export const CONTROLLER_RUN_ID = "_controller";

/** Absolute path to the _controller dir inside runsDir. */
export function controllerDir(runsDir: string): string {
  return join(runsDir, CONTROLLER_RUN_ID);
}

/**
 * Read the controller secret from disk; create it (with a fresh
 * generateRunSecret()) if it doesn't exist yet. Creates the _controller dir
 * (0o700) and approvals subdir (0o700) on first call.
 */
export async function ensureControllerSecret(runsDir: string): Promise<string> {
  const dir = controllerDir(runsDir);
  const secretPath = join(dir, ".secret");
  try {
    return (await readFile(secretPath, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // First call: scaffold the dir tree and generate a fresh secret.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await mkdir(join(dir, "approvals"), { recursive: true, mode: 0o700 });
    const secret = generateRunSecret();
    await writeFile(secretPath, secret, { mode: 0o600 });
    return secret;
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

  const secret = await ensureControllerSecret(runsDir);

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
  await mkdir(approvalsDir, { recursive: true, mode: 0o700 });
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
