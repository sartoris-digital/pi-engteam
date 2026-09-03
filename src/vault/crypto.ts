import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT);
}

/** AES-256-GCM. ciphertext is body||authTag. */
export function encrypt(plaintext: string, key: Buffer): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: Buffer.concat([body, tag]) };
}

export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): string {
  if (ciphertext.length < TAG_LEN) throw new Error("ciphertext too short");
  const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
