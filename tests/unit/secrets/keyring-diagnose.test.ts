// tests/unit/secrets/keyring-diagnose.test.ts
import { describe, it, expect } from "vitest";
import { classifyKeyringError, decideReconnectMode } from "../../../src/secrets/Keyring.js";

describe("classifyKeyringError", () => {
  it("classifies ABI / load failures as load-failed", () => {
    expect(classifyKeyringError(new Error("NODE_MODULE_VERSION 115 ... 127")).status).toBe("load-failed");
    expect(classifyKeyringError(new Error("Cannot find module 'keyring.darwin-arm64.node'")).status).toBe("load-failed");
    expect(classifyKeyringError(new Error("dlopen failed: symbol not found")).status).toBe("load-failed");
  });

  it("classifies access denials as locked", () => {
    expect(classifyKeyringError(new Error("errSecAuthFailed")).status).toBe("locked");
    expect(classifyKeyringError(new Error("User interaction is not allowed")).status).toBe("locked");
  });

  it("falls back to unavailable", () => {
    expect(classifyKeyringError(new Error("something weird")).status).toBe("unavailable");
  });

  it("populates detail with the error message", () => {
    const d = classifyKeyringError(new Error("NODE_MODULE_VERSION mismatch"));
    expect(d.detail).toContain("NODE_MODULE_VERSION");
  });
});

describe("decideReconnectMode", () => {
  it("addon load failure → mode1", () => {
    expect(decideReconnectMode({ status: "load-failed" }, false)).toBe("mode1");
  });
  it("locked keyring → locked", () => {
    expect(decideReconnectMode({ status: "locked" }, false)).toBe("locked");
  });
  it("ok + key present → healthy", () => {
    expect(decideReconnectMode({ status: "ok" }, true)).toBe("healthy");
  });
  it("ok + key absent → mode2", () => {
    expect(decideReconnectMode({ status: "ok" }, false)).toBe("mode2");
  });
  it("unavailable → mode2 (try passphrase recovery)", () => {
    expect(decideReconnectMode({ status: "unavailable" }, false)).toBe("mode2");
  });
});
