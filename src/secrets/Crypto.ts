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
