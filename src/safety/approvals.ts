// src/safety/approvals.ts
import { createHmac, createHash, randomBytes } from "crypto";
import type { ApprovalToken } from "../types.js";

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
): string {
  const payload = `${tokenId}:${op}:${argsHash}:${expiresAt}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyToken(secret: string, token: ApprovalToken): boolean {
  if (new Date(token.expiresAt) < new Date()) return false;
  const expected = signToken(secret, token.tokenId, token.op, token.argsHash, token.expiresAt);
  return expected === token.signature;
}
