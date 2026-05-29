// tests/unit/secrets/recovery-crypto.test.ts
import { describe, it, expect } from "vitest";
import { generateMasterKey, generateSalt, wrapMasterKey, unwrapMasterKey } from "../../../src/secrets/Crypto.js";

describe("Crypto — master-key envelope wrap/unwrap", () => {
  it("round-trips the master key with the correct passphrase", () => {
    const mk = generateMasterKey();
    const salt = generateSalt();
    const { wrap, iv, tag } = wrapMasterKey(mk, "correct horse", salt);
    const recovered = unwrapMasterKey(wrap, iv, tag, "correct horse", salt);
    expect(recovered.equals(mk)).toBe(true);
  });

  it("throws on a wrong passphrase (GCM tag failure)", () => {
    const mk = generateMasterKey();
    const salt = generateSalt();
    const { wrap, iv, tag } = wrapMasterKey(mk, "right", salt);
    expect(() => unwrapMasterKey(wrap, iv, tag, "wrong", salt)).toThrow();
  });

  it("throws on a tampered wrap byte", () => {
    const mk = generateMasterKey();
    const salt = generateSalt();
    const { wrap, iv, tag } = wrapMasterKey(mk, "pw", salt);
    wrap[0] ^= 0xff;
    expect(() => unwrapMasterKey(wrap, iv, tag, "pw", salt)).toThrow();
  });
});
