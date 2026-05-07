// src/secrets/MasterKey.ts
import { readFileSync, writeFileSync, existsSync } from "fs";
import { generateMasterKey, generateSalt, deriveKeyFromPassphrase, zeroBuffer } from "./Crypto.js";
import { type KeyringBackend, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER } from "./Keyring.js";
import { type promptPassphrase } from "./Passphrase.js";
import { Vault } from "./Vault.js";

export type MasterKeyConfig = {
  keyringBackend: KeyringBackend | null;
  saltPath: string;
  vaultDbPath: string;
  promptFn?: typeof promptPassphrase;
};

export class MasterKeyManager {
  private config: MasterKeyConfig;
  private cachedKey: Buffer | null = null;

  constructor(config: MasterKeyConfig) {
    this.config = config;
  }

  async ensureInitialized(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;

    const { keyringBackend, saltPath, vaultDbPath, promptFn } = this.config;
    const vaultExists = existsSync(vaultDbPath);

    // Keyring path: existing key → use it directly.
    if (keyringBackend) {
      const result = keyringBackend.get(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER);
      if (result.kind === "value") {
        this.cachedKey = Buffer.from(result.value, "hex");
        return this.cachedKey;
      }
      if (result.kind === "error") {
        throw new Error(
          `OS keyring unavailable: ${result.error}. Unlock the keyring and retry. Vault preserved.`,
        );
      }
      // result.kind === "not-found": fall through to passphrase recovery or first-run.
    }

    // fail closed when key uncertainty meets an existing vault — silent re-keying is data loss
    if (vaultExists) {
      if (!existsSync(saltPath)) {
        throw new Error(
          `Vault exists at ${vaultDbPath} but no master key in keyring and no passphrase salt at ${saltPath}. ` +
          `Restore the keyring entry, or delete the vault file to start fresh (DESTRUCTIVE — your stored secrets will be lost).`,
        );
      }
      if (!promptFn) {
        throw new Error(
          `Vault exists but no key in keyring; passphrase recovery requires promptFn to be supplied to MasterKeyManager.`,
        );
      }
      const salt = readFileSync(saltPath);
      const passphrase = await promptFn();
      const candidate = deriveKeyFromPassphrase(passphrase, salt);
      if (!validateKeyAgainstVault(vaultDbPath, candidate)) {
        zeroBuffer(candidate);
        throw new Error(
          `Passphrase did not match. Vault is intact but inaccessible until the correct passphrase is supplied.`,
        );
      }
      this.cachedKey = candidate;
      return this.cachedKey;
    }

    // Vault does NOT exist: true first run.
    if (existsSync(saltPath)) {
      // Salt without vault → returning user, derive from existing salt.
      if (!promptFn) throw new Error("No promptFn provided for passphrase derivation.");
      const salt = readFileSync(saltPath);
      const passphrase = await promptFn();
      this.cachedKey = deriveKeyFromPassphrase(passphrase, salt);
      return this.cachedKey;
    }

    if (keyringBackend) {
      const key = generateMasterKey();
      keyringBackend.set(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER, key.toString("hex"));
      this.cachedKey = key;
    } else {
      if (!promptFn) throw new Error("No promptFn provided for passphrase derivation.");
      const salt = generateSalt();
      const passphrase = await promptFn({ confirm: true });
      writeFileSync(saltPath, salt);
      this.cachedKey = deriveKeyFromPassphrase(passphrase, salt);
    }

    return this.cachedKey;
  }

  async getMasterKey(): Promise<Buffer> {
    if (!this.cachedKey) throw new Error("Call ensureInitialized() before getMasterKey().");
    return this.cachedKey;
  }

  zeroize(): void {
    if (this.cachedKey) {
      zeroBuffer(this.cachedKey);
      this.cachedKey = null;
    }
  }
}

// Returns true if the candidate key successfully decrypts an entry in the vault.
// An empty vault (no rows yet) returns true — no validation possible, accept the key.
function validateKeyAgainstVault(vaultDbPath: string, candidate: Buffer): boolean {
  const vault = new Vault({ dbPath: vaultDbPath, masterKey: candidate });
  try {
    vault.init();
    const rows = vault.list();
    if (rows.length === 0) return true;
    try {
      vault.get(rows[0].name);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    vault.close();
  }
}
