// tests/unit/safety/controller-approval.test.ts
//
// Phase 2: controller-approval unit tests.
// Uses a real tmp dir (via os.tmpdir + randomUUID) so we test actual fs
// behaviour rather than mocking. Each test suite gets its own isolated dir.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "node:crypto";

import {
  CONTROLLER_RUN_ID,
  controllerDir,
  ensureControllerSecret,
  mintControllerToken,
  recordPendingControllerApproval,
  readPendingControllerApproval,
  clearPendingControllerApproval,
} from "../../../src/safety/controllerApproval.js";
import { verifyToken, hashArgs, generateRunSecret } from "../../../src/safety/approvals.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpRunsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-ctrl-test-"));
}

// ---------------------------------------------------------------------------
// CONTROLLER_RUN_ID
// ---------------------------------------------------------------------------

describe("CONTROLLER_RUN_ID", () => {
  it("is the literal string _controller", () => {
    expect(CONTROLLER_RUN_ID).toBe("_controller");
  });

  it("controllerDir returns <runsDir>/_controller", () => {
    expect(controllerDir("/tmp/runs")).toBe("/tmp/runs/_controller");
  });
});

// ---------------------------------------------------------------------------
// ensureControllerSecret
// ---------------------------------------------------------------------------

describe("ensureControllerSecret", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await makeTmpRunsDir();
  });

  it("creates a 64-hex secret on first call and an approvals dir", async () => {
    const secret = await ensureControllerSecret(runsDir);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // approvals dir must exist
    const { stat } = await import("fs/promises");
    const approvalsDir = join(controllerDir(runsDir), "approvals");
    const s = await stat(approvalsDir);
    expect(s.isDirectory()).toBe(true);
  });

  it("returns the SAME secret on subsequent calls", async () => {
    const first = await ensureControllerSecret(runsDir);
    const second = await ensureControllerSecret(runsDir);
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// mintControllerToken — token shape + verifyToken round-trip
// ---------------------------------------------------------------------------

describe("mintControllerToken", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await makeTmpRunsDir();
  });

  it("rejects an op not in ALLOWED_OPS", async () => {
    const argsHash = hashArgs({ op: "not-allowed", command: "echo" });
    await expect(
      mintControllerToken(runsDir, { op: "not-allowed", argsHash }),
    ).rejects.toThrow(/ALLOWED_OPS/);
  });

  it("mints a token file that verifyToken accepts (bash round-trip)", async () => {
    const argsHash = hashArgs({ op: "bash", command: "rm -rf /tmp/foo" });
    const { tokenId, expiresAt } = await mintControllerToken(runsDir, {
      op: "bash",
      argsHash,
      ttlSeconds: 60,
    });

    // Token file must exist
    const tokenPath = join(controllerDir(runsDir), "approvals", `${tokenId}.json`);
    const raw = JSON.parse(await readFile(tokenPath, "utf8"));

    // Verify shape matches GrantApproval exactly
    expect(raw.tokenId).toBe(tokenId);
    expect(raw.runId).toBe(CONTROLLER_RUN_ID);
    expect(raw.op).toBe("bash");
    expect(raw.argsHash).toBe(argsHash);
    expect(raw.scope).toBe("once");
    expect(raw.expiresAt).toBe(expiresAt);
    expect(typeof raw.signature).toBe("string");
    expect(raw.signature).toHaveLength(64); // SHA-256 HMAC hex
    expect(typeof raw.pauseEpoch).toBe("number");
    expect(raw.consumed).toBe(false);
    expect(typeof raw.grantedAt).toBe("string");

    // verifyToken must accept it
    const secret = await ensureControllerSecret(runsDir);
    expect(verifyToken(secret, raw)).toBe(true);
  });

  it("minted token has runId === _controller", async () => {
    const argsHash = hashArgs({ op: "write", command: "/tmp/foo.ts" });
    const { tokenId } = await mintControllerToken(runsDir, {
      op: "write",
      argsHash,
    });
    const tokenPath = join(controllerDir(runsDir), "approvals", `${tokenId}.json`);
    const raw = JSON.parse(await readFile(tokenPath, "utf8"));
    expect(raw.runId).toBe("_controller");
  });

  it("token signed with a DIFFERENT secret fails verifyToken", async () => {
    const argsHash = hashArgs({ op: "bash", command: "ls" });
    const { tokenId } = await mintControllerToken(runsDir, { op: "bash", argsHash });
    const tokenPath = join(controllerDir(runsDir), "approvals", `${tokenId}.json`);
    const raw = JSON.parse(await readFile(tokenPath, "utf8"));
    const otherSecret = generateRunSecret();
    expect(verifyToken(otherSecret, raw)).toBe(false);
  });

  it("caps ttlSeconds at config ceiling (does not exceed 300)", async () => {
    const argsHash = hashArgs({ op: "bash", command: "echo hi" });
    const before = Date.now();
    const { expiresAt } = await mintControllerToken(runsDir, {
      op: "bash",
      argsHash,
      ttlSeconds: 999_999, // way above ceiling
    });
    const after = Date.now();
    const expMs = Date.parse(expiresAt);
    // Should be at most 300 s from now (plus a few ms for test jitter)
    expect(expMs - before).toBeLessThanOrEqual(300_000 + 500);
    expect(expMs - after).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Pending-block record round-trip
// ---------------------------------------------------------------------------

describe("pending controller approval record", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await makeTmpRunsDir();
  });

  it("record → read returns the record", async () => {
    const argsHash = hashArgs({ op: "bash", command: "rm -rf /tmp/x" });
    await recordPendingControllerApproval(runsDir, {
      op: "bash",
      argsHash,
      display: "rm -rf /tmp/x",
    });
    const result = await readPendingControllerApproval(runsDir);
    expect(result).not.toBeNull();
    expect(result!.op).toBe("bash");
    expect(result!.argsHash).toBe(argsHash);
    expect(result!.display).toBe("rm -rf /tmp/x");
    expect(typeof result!.ts).toBe("string");
  });

  it("read returns null when no record exists", async () => {
    const result = await readPendingControllerApproval(runsDir);
    expect(result).toBeNull();
  });

  it("clear → read returns null", async () => {
    await recordPendingControllerApproval(runsDir, {
      op: "edit",
      argsHash: hashArgs({ op: "edit", command: "/tmp/foo.ts" }),
      display: "/tmp/foo.ts",
    });
    await clearPendingControllerApproval(runsDir);
    const result = await readPendingControllerApproval(runsDir);
    expect(result).toBeNull();
  });

  it("clear is idempotent (no error when nothing to clear)", async () => {
    await expect(clearPendingControllerApproval(runsDir)).resolves.toBeUndefined();
  });

  it("overwriting a record replaces it", async () => {
    await recordPendingControllerApproval(runsDir, {
      op: "bash",
      argsHash: hashArgs({ op: "bash", command: "old" }),
      display: "old",
    });
    await recordPendingControllerApproval(runsDir, {
      op: "edit",
      argsHash: hashArgs({ op: "edit", command: "new" }),
      display: "new",
    });
    const result = await readPendingControllerApproval(runsDir);
    expect(result!.op).toBe("edit");
    expect(result!.display).toBe("new");
  });
});
