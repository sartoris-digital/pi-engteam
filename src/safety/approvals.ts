// src/safety/approvals.ts
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import type { ApprovalToken } from "../types.js";

/**
 * Canonical list of approval-eligible operations. Both RequestApproval
 * and GrantApproval reference this set so the writer-side allowlist
 * matches the verifier-side allowlist. Adding a new approval-eligible
 * operation requires bumping the schema and updating SafetyGuard's
 * Layer C trigger as well.
 */
export const ALLOWED_OPS: ReadonlySet<string> = new Set([
  "git-push",
  "npm-install-new",
  "migration",
  "bash",
  "write",
  "edit",
  "verifier-script-update",
]);

export function generateRunSecret(): string {
  return randomBytes(32).toString("hex");
}

export function hashArgs(args: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.keys(args).sort().map(k => [k, args[k]])
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Build the canonical HMAC payload for a token. Shared by signToken
 * and verifyToken (and by CheckApproval's signature-only verify) so
 * a single source of truth governs the signing inputs. Phase 7 adds
 * pauseEpoch as a required field bound into the HMAC.
 */
export function tokenSigningPayload(
  runId: string,
  tokenId: string,
  op: string,
  argsHash: string,
  expiresAt: string,
  pauseEpoch: number,
): string {
  return `${runId}:${tokenId}:${op}:${argsHash}:${expiresAt}:pauseEpoch=${pauseEpoch}`;
}

export function signToken(
  secret: string,
  tokenId: string,
  op: string,
  argsHash: string,
  expiresAt: string,
  runId: string,
  pauseEpoch: number,
): string {
  // Codex round-6 HIGH: runId is part of the HMAC payload so a token
  // issued under run A cannot be honored when run B is the active run.
  // PLAN.md round-A8 HIGH 2 (Phase 7): pauseEpoch is also part of the
  // payload so a pre-emergency-stop token is invalidated once the
  // operator runs /approval-watcher resume-after-emergency (which
  // bumps the global counter).
  const payload = tokenSigningPayload(runId, tokenId, op, argsHash, expiresAt, pauseEpoch);
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyToken(secret: string, token: ApprovalToken): boolean {
  // Codex round-8 MEDIUM: parse expiry to a finite number; reject
  // malformed strings and now-or-past expiries.
  const expMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return false;
  if (typeof token.runId !== "string" || token.runId.length === 0) return false;
  // Phase 7: pauseEpoch is REQUIRED on every token. A legacy token
  // (no pauseEpoch) must be migrated before it verifies — migration
  // rewrites it with pauseEpoch:0 + a fresh signature under the new
  // HMAC payload. verifyToken rejects any token lacking the field.
  if (typeof token.pauseEpoch !== "number" || !Number.isFinite(token.pauseEpoch) || token.pauseEpoch < 0) {
    return false;
  }
  const expected = signToken(
    secret,
    token.tokenId,
    token.op,
    token.argsHash,
    token.expiresAt,
    token.runId,
    token.pauseEpoch,
  );
  // Codex round-12 HIGH: timing-safe compare. Plain `===` short-circuits
  // on the first mismatching byte, leaking signature bytes to a local
  // attacker who can measure verification timing across many crafted
  // tokens. timingSafeEqual requires equal-length Buffers; reject any
  // signature that isn't exactly 64 hex chars (SHA256 HMAC output).
  if (typeof token.signature !== "string" || token.signature.length !== expected.length) {
    return false;
  }
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token.signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
