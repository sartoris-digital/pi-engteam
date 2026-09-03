import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TOKEN_OPS,
  consumeToken,
  fileTokenSource,
  hashArgs,
  mintToken,
  readTokenFile,
  tokenPath,
  verifyToken,
  type ApprovalToken,
} from "../../../src/safety/tokens.js";

const SECRET = "e".repeat(64);
const OTHER = "f".repeat(64);

describe("hashArgs", () => {
  it("binds the op and is sensitive to the exact command string", () => {
    const a = hashArgs("bash", { command: "git commit -m x" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashArgs("bash", { command: "git commit -m x " })).not.toBe(a);
    expect(hashArgs("write", { command: "git commit -m x" })).not.toBe(a);
    expect(hashArgs("bash", { command: "git commit -m x", z: undefined } as Record<string, unknown>)).toBe(a);
  });
});

describe("mint / verify / consume", () => {
  it("writes a 0600 granted file that verifies once", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-tokens-"));
    try {
      const runDir = join(tmp, "run-0001");
      await mkdir(runDir, { recursive: true });
      const argsHash = hashArgs("bash", { command: "git commit -m x" });
      const token = mintToken(runDir, SECRET, {
        op: "bash",
        argsHash,
        ttlSeconds: 60,
        runId: "run-0001",
        tokenId: "tok-1",
        now: () => new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(TOKEN_OPS).toEqual(["bash", "write", "edit"]);
      expect(tokenPath(runDir, "tok-1")).toBe(join(runDir, "approvals", "granted", "tok-1.json"));
      expect((await stat(tokenPath(runDir, "tok-1"))).mode & 0o777).toBe(0o600);
      expect(token.pauseEpoch).toBe(0);
      expect(token.sig).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyToken(SECRET, token)).toBe(true);
      expect(verifyToken(OTHER, token)).toBe(false);
      expect(readTokenFile(runDir, "tok-1")?.tokenId).toBe("tok-1");
      consumeToken(runDir, "tok-1");
      expect(readTokenFile(runDir, "tok-1")).toBeNull();
      consumeToken(runDir, "tok-1");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects expired, truncated, and empty-runId tokens", () => {
    const token: ApprovalToken = {
      runId: "run-0001",
      tokenId: "t",
      op: "bash",
      argsHash: "aa",
      expiresAt: "2000-01-01T00:00:00.000Z",
      pauseEpoch: 0,
      sig: "0".repeat(64),
    };
    expect(verifyToken(SECRET, token)).toBe(false);
    expect(verifyToken(SECRET, { ...token, expiresAt: "2999-01-01T00:00:00.000Z", sig: "0".repeat(63) })).toBe(false);
    expect(verifyToken(SECRET, { ...token, runId: "", expiresAt: "2999-01-01T00:00:00.000Z" })).toBe(false);
  });
});

describe("fileTokenSource", () => {
  it("honours a matching token exactly once and ignores the wrong op/hash/run", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-sdlc-tokens-src-"));
    try {
      const runDir = join(tmp, "run-0001");
      await mkdir(runDir, { recursive: true });
      const argsHash = hashArgs("bash", { command: "git commit -m x" });
      mintToken(runDir, SECRET, { op: "bash", argsHash, ttlSeconds: 60, runId: "run-0001" });
      const tokens = fileTokenSource(runDir, SECRET, "run-0001");
      expect(tokens.take("write", argsHash)).toBeNull();
      expect(tokens.take("bash", hashArgs("bash", { command: "git commit -m y" }))).toBeNull();
      expect(fileTokenSource(runDir, SECRET, "run-0002").take("bash", argsHash)).toBeNull();
      expect(tokens.take("bash", argsHash)?.op).toBe("bash");
      expect(tokens.take("bash", argsHash)).toBeNull();
      expect(fileTokenSource(runDir, null, "run-0001").take("bash", argsHash)).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
