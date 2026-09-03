import { randomBytes } from "node:crypto";
import { decrypt, deriveKey, encrypt } from "./crypto.js";
import type { SecretName } from "./types.js";
import type { Vault } from "./vault.js";
import { asSecretName, vaultNameOf } from "./bind.js";

const SALT_LEN = 16;
const NONCE_LEN = 12;

export interface ExportEnvelope {
  schemaVersion: 1;
  exportedAt: string;
  names: SecretName[];
  ciphertext: string;
}

interface PlainEntries {
  entries: { name: string; value: string }[];
}

export async function exportVault(vault: Vault, passphrase: string, now: () => Date = () => new Date()): Promise<ExportEnvelope> {
  const metas = await vault.list();
  const entries: PlainEntries["entries"] = [];
  const names: SecretName[] = [];
  for (const meta of metas) {
    names.push(asSecretName(meta.name));
    entries.push({ name: meta.name, value: await vault.getPlaintext(meta.name) });
  }
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  const { nonce, ciphertext } = encrypt(JSON.stringify({ entries } satisfies PlainEntries), key);
  const packed = Buffer.concat([salt, nonce, ciphertext]);
  return {
    schemaVersion: 1,
    exportedAt: now().toISOString(),
    names,
    ciphertext: packed.toString("base64"),
  };
}

export async function importVault(vault: Vault, envelope: ExportEnvelope, passphrase: string): Promise<SecretName[]> {
  if (envelope.schemaVersion !== 1) throw new Error(`secret import: unsupported schemaVersion ${String(envelope.schemaVersion)}`);
  const packed = Buffer.from(envelope.ciphertext, "base64");
  if (packed.length < SALT_LEN + NONCE_LEN + 16) throw new Error("secret import: ciphertext too short");
  const salt = packed.subarray(0, SALT_LEN);
  const nonce = packed.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
  const ciphertext = packed.subarray(SALT_LEN + NONCE_LEN);
  const key = deriveKey(passphrase, salt);
  const plain = decrypt(ciphertext, nonce, key);
  const parsed = JSON.parse(plain) as PlainEntries;
  const restored: SecretName[] = [];
  for (const entry of parsed.entries ?? []) {
    const name = vaultNameOf(entry.name);
    await vault.set(name, entry.value);
    restored.push(asSecretName(name));
  }
  return restored;
}
