import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../config/json.js";

export const TOKEN_OPS = ["bash", "write", "edit"] as const;
export type TokenOp = (typeof TOKEN_OPS)[number];
export const APPROVALS_DIR = "approvals";

export interface ApprovalToken {
  runId: string;
  tokenId: string;
  op: TokenOp;
  argsHash: string;
  expiresAt: string;
  pauseEpoch: number;
  sig: string;
}

export interface TokenSource {
  take(op: string, argsHash: string): ApprovalToken | null;
}

export function tokenPath(runDir: string, tokenId: string): string {
  return join(runDir, APPROVALS_DIR, "granted", `${tokenId}.json`);
}

export function hashArgs(op: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${op}:${canonicalJson(args)}`).digest("hex");
}

function signingPayload(token: Omit<ApprovalToken, "sig">): string {
  return `${token.runId}:${token.tokenId}:${token.op}:${token.argsHash}:${token.expiresAt}:pauseEpoch=${token.pauseEpoch}`;
}

function signToken(secret: string, token: Omit<ApprovalToken, "sig">): string {
  return createHmac("sha256", secret).update(signingPayload(token)).digest("hex");
}

export function verifyToken(secret: string, token: ApprovalToken): boolean {
  const expMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return false;
  if (typeof token.runId !== "string" || token.runId.length === 0) return false;
  if (token.pauseEpoch !== 0) return false;
  if (typeof token.sig !== "string" || !/^[0-9a-f]{64}$/.test(token.sig)) return false;
  if (!(TOKEN_OPS as readonly string[]).includes(token.op)) return false;
  const expected = signToken(secret, token);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token.sig, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function mintToken(
  runDir: string,
  secret: string,
  spec: { op: TokenOp; argsHash: string; ttlSeconds: number; now?: () => Date; tokenId?: string; runId?: string },
): ApprovalToken {
  const now = spec.now ?? (() => new Date());
  const unsigned: Omit<ApprovalToken, "sig"> = {
    runId: spec.runId ?? "run-0001",
    tokenId: spec.tokenId ?? randomBytes(8).toString("hex"),
    op: spec.op,
    argsHash: spec.argsHash,
    expiresAt: new Date(now().getTime() + spec.ttlSeconds * 1000).toISOString(),
    pauseEpoch: 0,
  };
  const token: ApprovalToken = { ...unsigned, sig: signToken(secret, unsigned) };
  mkdirSync(join(runDir, APPROVALS_DIR, "granted"), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath(runDir, token.tokenId), `${JSON.stringify(token)}\n`, { mode: 0o600 });
  return token;
}

export function readTokenFile(runDir: string, tokenId: string): ApprovalToken | null {
  try {
    return JSON.parse(readFileSync(tokenPath(runDir, tokenId), "utf8")) as ApprovalToken;
  } catch {
    return null;
  }
}

export function consumeToken(runDir: string, tokenId: string): void {
  try {
    unlinkSync(tokenPath(runDir, tokenId));
  } catch {
    /* missing is fine */
  }
}

export function fileTokenSource(runDir: string, secret: string | null, runId: string): TokenSource {
  return {
    take(op: string, argsHash: string): ApprovalToken | null {
      if (secret === null) return null;
      let names: string[] = [];
      try {
        names = readdirSync(join(runDir, APPROVALS_DIR, "granted"));
      } catch {
        return null;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const token = readTokenFile(runDir, name.slice(0, -".json".length));
        if (token === null) continue;
        if (token.runId !== runId || token.op !== op || token.argsHash !== argsHash) continue;
        if (!verifyToken(secret, token)) continue;
        consumeToken(runDir, token.tokenId);
        return token;
      }
      return null;
    },
  };
}
