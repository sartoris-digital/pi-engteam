// src/secrets/Crypto.ts
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";

export function generateMasterKey(): Buffer {
  return randomBytes(32);
}

export function generateSalt(): Buffer {
  return randomBytes(16);
}

export function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 67108864 }) as Buffer;
}

export function encrypt(
  plaintext: string,
  masterKey: Buffer,
): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decrypt(
  ciphertext: Buffer,
  masterKey: Buffer,
  iv: Buffer,
  tag: Buffer,
): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

// Envelope encryption for vault recovery: a passphrase-derived KEK wraps a copy
// of the random master key. The wrapped copy is stored in vault_meta so the
// vault can be reopened after OS-keychain access is lost. The master key is
// serialized as hex through the existing string-oriented encrypt/decrypt.
export function wrapMasterKey(
  masterKey: Buffer,
  passphrase: string,
  salt: Buffer,
): { wrap: Buffer; iv: Buffer; tag: Buffer } {
  const kek = deriveKeyFromPassphrase(passphrase, salt);
  try {
    const { ciphertext, iv, tag } = encrypt(masterKey.toString("hex"), kek);
    return { wrap: ciphertext, iv, tag };
  } finally {
    zeroBuffer(kek);
  }
}

export function unwrapMasterKey(
  wrap: Buffer,
  iv: Buffer,
  tag: Buffer,
  passphrase: string,
  salt: Buffer,
): Buffer {
  const kek = deriveKeyFromPassphrase(passphrase, salt);
  try {
    const hex = decrypt(wrap, kek, iv, tag); // throws on wrong passphrase / tamper
    return Buffer.from(hex, "hex");
  } finally {
    zeroBuffer(kek);
  }
}
