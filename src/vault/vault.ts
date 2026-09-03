import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { factoryHome } from "../home.js";
import { decrypt, deriveKey, encrypt } from "./crypto.js";
import { KEYRING_ACCOUNT, KEYRING_SERVICE, osKeyring } from "./keyring.js";
import { SqliteVaultStore } from "./sqlite-store.js";
import type { KeyringPort, SecretMeta, VaultStore } from "./types.js";

const GLOBAL_NAME = /^[A-Z][A-Z0-9_]+$/;
const REPO_NAME = /^repo\/[A-Za-z0-9._-]+\/[A-Z][A-Z0-9_]+$/;

export class VaultUnavailableError extends Error {
  readonly code = "vault-unavailable" as const;
  constructor(message = "vault unavailable") {
    super(message);
    this.name = "VaultUnavailableError";
  }
}

export function vaultPath(home: string = factoryHome()): string {
  return join(home, "vault.sqlite");
}

export function assertSecretName(name: string): void {
  if (GLOBAL_NAME.test(name) || REPO_NAME.test(name)) return;
  throw new Error(`invalid secret name: ${JSON.stringify(name)} (expected UPPER_SNAKE or repo/<slug>/UPPER_SNAKE)`);
}

export class Vault {
  private readonly store: VaultStore;
  private readonly keyring: KeyringPort;
  private readonly now: () => Date;

  constructor(opts: { store: VaultStore; keyring: KeyringPort; now?: () => Date }) {
    this.store = opts.store;
    this.keyring = opts.keyring;
    this.now = opts.now ?? (() => new Date());
  }

  static async open(opts: { home?: string; store?: VaultStore; keyring?: KeyringPort; now?: () => Date } = {}): Promise<Vault> {
    const home = opts.home ?? factoryHome();
    const store = opts.store ?? new SqliteVaultStore(vaultPath(home));
    let keyring: KeyringPort;
    try {
      keyring = opts.keyring ?? osKeyring();
    } catch (err) {
      throw new VaultUnavailableError(err instanceof Error ? err.message : String(err));
    }
    const vault = new Vault({ store, keyring, now: opts.now });
    await vault.ensureMaster();
    return vault;
  }

  async set(name: string, value: string, opts?: { note?: string }): Promise<SecretMeta> {
    assertSecretName(name);
    const existing = this.store.get(name);
    const createdAt = existing?.meta.createdAt ?? this.now().toISOString();
    const meta: SecretMeta = { name, createdAt };
    const note = opts?.note ?? existing?.meta.note;
    if (note !== undefined) meta.note = note;
    if (existing?.meta.rotatedAt !== undefined) meta.rotatedAt = existing.meta.rotatedAt;
    if (existing?.meta.scopes !== undefined) meta.scopes = existing.meta.scopes;
    this.store.put(await this.seal(meta, value));
    return { ...meta };
  }

  async list(): Promise<SecretMeta[]> {
    return this.store.list();
  }

  async rm(name: string, opts: { yes: true }): Promise<void> {
    if (opts?.yes !== true) throw new Error("vault rm requires { yes: true }");
    assertSecretName(name);
    this.store.delete(name);
  }

  async rotate(name: string, value: string): Promise<SecretMeta> {
    assertSecretName(name);
    const existing = this.store.get(name);
    if (existing === undefined) throw new Error(`vault: secret ${name} not found`);
    const meta: SecretMeta = {
      ...existing.meta,
      rotatedAt: this.now().toISOString(),
    };
    this.store.put(await this.seal(meta, value));
    return { ...meta };
  }

  async getPlaintext(name: string): Promise<string> {
    assertSecretName(name);
    const rec = this.store.get(name);
    if (rec === undefined) throw new Error(`vault: secret ${name} not found`);
    const master = await this.ensureMaster();
    const key = deriveKey(master, Buffer.from(rec.salt, "hex"));
    return decrypt(Buffer.from(rec.ciphertext, "hex"), Buffer.from(rec.nonce, "hex"), key);
  }

  private async seal(meta: SecretMeta, value: string) {
    const master = await this.ensureMaster();
    const salt = randomBytes(16);
    const key = deriveKey(master, salt);
    const { nonce, ciphertext } = encrypt(value, key);
    return {
      meta,
      nonce: nonce.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
      salt: salt.toString("hex"),
    };
  }

  private async ensureMaster(): Promise<string> {
    try {
      const existing = await this.keyring.get(KEYRING_SERVICE, KEYRING_ACCOUNT);
      if (existing !== null && existing.length > 0) return existing;
      const generated = randomBytes(32).toString("hex");
      await this.keyring.set(KEYRING_SERVICE, KEYRING_ACCOUNT, generated);
      return generated;
    } catch (err) {
      if (err instanceof VaultUnavailableError) throw err;
      throw new VaultUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }
}
