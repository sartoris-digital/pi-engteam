// src/secrets/MasterKey.ts
import { readFileSync, writeFileSync, existsSync } from "fs";
import { generateMasterKey, generateSalt, deriveKeyFromPassphrase, zeroBuffer } from "./Crypto.js";
import { type KeyringBackend, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER } from "./Keyring.js";
import { type promptPassphrase } from "./Passphrase.js";

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

    // Keyring path: existing key → use it directly.
    if (keyringBackend) {
      const stored = keyringBackend.get(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER);
      if (stored) {
        this.cachedKey = Buffer.from(stored, "hex");
        return this.cachedKey;
      }
    }

    // Passphrase path: existing salt → derive key from it (returning user, not first run).
    if (existsSync(saltPath)) {
      if (!promptFn) throw new Error("No promptFn provided for passphrase derivation.");
      const salt = readFileSync(saltPath);
      const passphrase = await promptFn();
      this.cachedKey = deriveKeyFromPassphrase(passphrase, salt);
      return this.cachedKey;
    }

    // True first run.
    if (keyringBackend) {
      // Generate fresh key, persist in keyring.
      const key = generateMasterKey();
      keyringBackend.set(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER, key.toString("hex"));
      this.cachedKey = key;
    } else {
      // No keyring: generate salt, prompt for new passphrase, derive key.
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
