// src/secrets/MasterKey.ts
import { readFileSync, writeFileSync, existsSync } from "fs";
import { generateMasterKey, generateSalt, deriveKeyFromPassphrase, wrapMasterKey, unwrapMasterKey, zeroBuffer } from "./Crypto.js";
import { type KeyringBackend, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER } from "./Keyring.js";
import { type promptPassphrase } from "./Passphrase.js";
import { Vault, RECOVERY_KDF, type RecoveryBlob } from "./Vault.js";

const PASSPHRASE_MISMATCH_MSG =
  "Passphrase did not match. Vault is intact but inaccessible until the correct passphrase is supplied.";

export type MasterKeyConfig = {
  keyringBackend: KeyringBackend | null;
  saltPath: string;
  vaultDbPath: string;
  promptFn?: typeof promptPassphrase;
};

export type UnlockSource =
  | "keychain"
  | "first-run-keychain"
  | "passphrase-recovery"
  | "passphrase"
  | null;

export class MasterKeyManager {
  private config: MasterKeyConfig;
  private cachedKey: Buffer | null = null;
  public unlockSource: UnlockSource = null;

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
        this.unlockSource = "keychain";
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
      // Approach A: a passphrase-wrapped backup stored inside the vault DB takes
      // precedence over the legacy sidecar salt. It travels with secrets.db, so
      // it is the recovery path on a new machine/user. Re-storing the recovered
      // key into the keychain is deferred to /secret-reconnect (no silent write).
      const blob = readRecoveryBlobFromVault(vaultDbPath);
      if (blob) {
        if (!promptFn) {
          throw new Error("Vault exists but no key in keyring; passphrase recovery requires promptFn to be supplied to MasterKeyManager.");
        }
        const passphrase = await promptFn();
        return await this.recoverWithPassphrase(passphrase);
      }

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
      this.unlockSource = "passphrase";
      this.cachedKey = candidate;
      return this.cachedKey;
    }

    // Vault does NOT exist: true first run.
    if (existsSync(saltPath)) {
      // Salt without vault → returning user, derive from existing salt.
      if (!promptFn) throw new Error("No promptFn provided for passphrase derivation.");
      const salt = readFileSync(saltPath);
      const passphrase = await promptFn();
      this.unlockSource = "passphrase";
      this.cachedKey = deriveKeyFromPassphrase(passphrase, salt);
      return this.cachedKey;
    }

    if (keyringBackend) {
      const key = generateMasterKey();
      keyringBackend.set(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER, key.toString("hex"));
      this.unlockSource = "first-run-keychain";
      this.cachedKey = key;
    } else {
      if (!promptFn) throw new Error("No promptFn provided for passphrase derivation.");
      const salt = generateSalt();
      const passphrase = await promptFn({ confirm: true });
      writeFileSync(saltPath, salt);
      this.unlockSource = "passphrase";
      this.cachedKey = deriveKeyFromPassphrase(passphrase, salt);
    }

    return this.cachedKey;
  }

  async getMasterKey(): Promise<Buffer> {
    if (!this.cachedKey) throw new Error("Call ensureInitialized() before getMasterKey().");
    return this.cachedKey;
  }

  // Recover the master key from the vault's recovery blob using a caller-supplied
  // passphrase (NO prompting — commands collect the passphrase via the Pi TUI).
  // Caches the key and sets unlockSource on success. Does NOT write to the keychain
  // (re-store is the caller's explicit step, e.g. /secret-reconnect).
  async recoverWithPassphrase(passphrase: string): Promise<Buffer> {
    const { vaultDbPath } = this.config;
    const blob = existsSync(vaultDbPath) ? readRecoveryBlobFromVault(vaultDbPath) : null;
    if (!blob) {
      throw new Error("No recovery backup is enrolled on this vault; nothing to recover.");
    }
    if (blob.kdf !== RECOVERY_KDF) {
      throw new Error(`Vault recovery blob uses an unknown KDF (${blob.kdf}); it was created by a newer pi-engineering version. Upgrade to recover.`);
    }
    let candidate: Buffer;
    try {
      candidate = unwrapMasterKey(blob.wrap, blob.iv, blob.tag, passphrase, blob.salt);
    } catch {
      throw new Error(PASSPHRASE_MISMATCH_MSG);
    }
    // Empty vault: validateKeyAgainstVault() is vacuously true, so the GCM auth
    // tag in unwrapMasterKey above is the real passphrase gate.
    if (!validateKeyAgainstVault(vaultDbPath, candidate)) {
      zeroBuffer(candidate);
      throw new Error(PASSPHRASE_MISMATCH_MSG);
    }
    this.cachedKey = candidate;
    this.unlockSource = "passphrase-recovery";
    return this.cachedKey;
  }

  // Enroll a passphrase-wrapped backup of the live master key into the vault DB.
  // Requires an unlocked vault (call ensureInitialized first). Idempotent —
  // overwriting the blob doubles as "change recovery passphrase".
  async enrollRecovery(passphrase: string): Promise<void> {
    if (!this.cachedKey) {
      throw new Error("Vault must be unlocked before enrolling recovery. Call ensureInitialized() first.");
    }
    const salt = generateSalt();
    const { wrap, iv, tag } = wrapMasterKey(this.cachedKey, passphrase, salt);
    const vault = new Vault({ dbPath: this.config.vaultDbPath, masterKey: this.cachedKey });
    try {
      vault.init();
      const blob: RecoveryBlob = { salt, wrap, iv, tag, kdf: RECOVERY_KDF, enrolledAt: Date.now() };
      vault.writeRecoveryBlob(blob);
    } finally {
      vault.close();
    }
  }

  zeroize(): void {
    if (this.cachedKey) {
      zeroBuffer(this.cachedKey);
      this.cachedKey = null;
    }
  }
}

// Returns true if the candidate key can decrypt at least one entry. Uses
// Vault.verifyDecryptable so audit fields (use_count, last_used_at) are not
// perturbed by validation probes — passphrase retries should look like
// validation, not real secret access.
function validateKeyAgainstVault(vaultDbPath: string, candidate: Buffer): boolean {
  const vault = new Vault({ dbPath: vaultDbPath, masterKey: candidate });
  try {
    vault.init();
    return vault.verifyDecryptable();
  } catch {
    return false;
  } finally {
    vault.close();
  }
}

// Reads the recovery blob from an existing vault DB without needing the master
// key — vault_meta is plaintext, so a throwaway key suffices to open the DB and
// read metadata. Returns null when no blob is enrolled; throws on a corrupt blob.
function readRecoveryBlobFromVault(vaultDbPath: string): RecoveryBlob | null {
  const vault = new Vault({ dbPath: vaultDbPath, masterKey: Buffer.alloc(32) });
  try {
    vault.init();
    return vault.readRecoveryBlob();
  } finally {
    vault.close();
  }
}
