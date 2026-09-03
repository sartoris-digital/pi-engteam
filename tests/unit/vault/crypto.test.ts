import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, deriveKey, encrypt } from "../../../src/vault/crypto.js";

describe("vault crypto", () => {
  it("encrypt/decrypt round-trips", () => {
    const salt = randomBytes(16);
    const key = deriveKey("passphrase", salt);
    const { nonce, ciphertext } = encrypt("super-secret-value", key);
    expect(ciphertext.equals(Buffer.from("super-secret-value"))).toBe(false);
    expect(decrypt(ciphertext, nonce, key)).toBe("super-secret-value");
  });

  it("wrong key throws", () => {
    const salt = randomBytes(16);
    const key = deriveKey("passphrase", salt);
    const other = deriveKey("other-passphrase", salt);
    const { nonce, ciphertext } = encrypt("super-secret-value", key);
    expect(() => decrypt(ciphertext, nonce, other)).toThrow();
  });

  it("deriveKey is deterministic for the same passphrase and salt", () => {
    const salt = randomBytes(16);
    expect(deriveKey("hunter2", salt).equals(deriveKey("hunter2", salt))).toBe(true);
    expect(deriveKey("hunter2", salt).equals(deriveKey("hunter2", randomBytes(16)))).toBe(false);
  });
});
