import { describe, it, expect } from "vitest";
import {
  generateRunSecret,
  signToken,
  verifyToken,
  hashArgs,
} from "../../../src/safety/approvals.js";
import type { ApprovalToken } from "../../../src/types.js";

describe("approvals", () => {
  it("sign + verify round-trip passes (pauseEpoch in HMAC)", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-1";
    const op = "git-push";
    const argsHash = hashArgs({ branch: "main", remote: "origin" });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt, "run-1", 0);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature, pauseEpoch: 0,
    };
    expect(verifyToken(secret, token)).toBe(true);
  });

  it("modified signature fails", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-1";
    const op = "git-push";
    const argsHash = hashArgs({ x: 1 });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt, "run-1", 0);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature: signature + "tampered", pauseEpoch: 0,
    };
    expect(verifyToken(secret, token)).toBe(false);
  });

  it("expired token fails verify", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-exp";
    const op = "migration";
    const argsHash = hashArgs({ db: "prod" });
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt, "run-1", 0);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature, pauseEpoch: 0,
    };
    expect(verifyToken(secret, token)).toBe(false);
  });

  it("Phase 7: token missing pauseEpoch field fails verify", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-legacy";
    const op = "bash";
    const argsHash = hashArgs({ cmd: "echo" });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt, "run-1", 0);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature,
      // intentionally NO pauseEpoch — simulates legacy token pre-migration
    };
    expect(verifyToken(secret, token)).toBe(false);
  });

  it("Phase 7: token whose pauseEpoch differs from the signing epoch fails verify", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-skew";
    const op = "edit";
    const argsHash = hashArgs({ path: "/tmp" });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    // Sign with pauseEpoch=0, attach pauseEpoch=1 — signature mismatch.
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt, "run-1", 0);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature, pauseEpoch: 1,
    };
    expect(verifyToken(secret, token)).toBe(false);
  });

  it("hashArgs is deterministic and key-order-independent", () => {
    const h1 = hashArgs({ b: 2, a: 1 });
    const h2 = hashArgs({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it("different args produce different hashes", () => {
    const h1 = hashArgs({ branch: "main" });
    const h2 = hashArgs({ branch: "develop" });
    expect(h1).not.toBe(h2);
  });
});
