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

export function signToken(
  secret: string,
  tokenId: string,
  op: string,
  argsHash: string,
  expiresAt: string,
  runId: string,
): string {
  // Codex round-6 HIGH: runId is now part of the HMAC payload so a token
  // issued under run A cannot be honored when run B is the active run.
  // Previous version omitted runId; coupled with the global active-run.txt
  // lookup in findValidApproval, an attacker could exfiltrate a token
  // from run A into run B's approvals dir and replay it.
  const payload = `${runId}:${tokenId}:${op}:${argsHash}:${expiresAt}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyToken(secret: string, token: ApprovalToken): boolean {
  // Codex round-8 MEDIUM: previous check used `new Date(expiresAt) < new Date()`,
  // which (a) returned false for `Date("not-a-date")` so a token with a
  // malformed expiry-string passed expiry verification, and (b) accepted
  // tokens at exact-expiry (strict `<` instead of `<=`). Parse to a
  // finite number, reject malformed strings, and reject tokens whose
  // expiry is now-or-past.
  const expMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return false;
  if (typeof token.runId !== "string" || token.runId.length === 0) return false;
  const expected = signToken(
    secret,
    token.tokenId,
    token.op,
    token.argsHash,
    token.expiresAt,
    token.runId,
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
