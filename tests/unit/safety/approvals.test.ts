import { describe, it, expect } from "vitest";
import {
  generateRunSecret,
  signToken,
  verifyToken,
  hashArgs,
} from "../../../src/safety/approvals.js";
import type { ApprovalToken } from "../../../src/types.js";

describe("approvals", () => {
  it("sign + verify round-trip passes", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-1";
    const op = "git-push";
    const argsHash = hashArgs({ branch: "main", remote: "origin" });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature,
    };
    expect(verifyToken(secret, token)).toBe(true);
  });

  it("modified signature fails", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-1";
    const op = "git-push";
    const argsHash = hashArgs({ x: 1 });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature: signature + "tampered",
    };
    expect(verifyToken(secret, token)).toBe(false);
  });

  it("expired token fails verify", () => {
    const secret = generateRunSecret();
    const tokenId = "tok-exp";
    const op = "migration";
    const argsHash = hashArgs({ db: "prod" });
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    const signature = signToken(secret, tokenId, op, argsHash, expiresAt);
    const token: ApprovalToken = {
      tokenId, runId: "run-1", op, argsHash,
      scope: "once", expiresAt, signature,
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
