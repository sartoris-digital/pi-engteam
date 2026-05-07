// tests/unit/secrets/keyring.test.ts
import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "fs";
import {
  createKeyringBackend,
  KEYRING_SERVICE,
  KEYRING_ACCOUNT_MASTER,
  type KeyringBackend,
  type KeyringGetResult,
} from "../../../src/secrets/Keyring.js";
import { MasterKeyManager } from "../../../src/secrets/MasterKey.js";
import { Vault } from "../../../src/secrets/Vault.js";
import { generateSalt, deriveKeyFromPassphrase } from "../../../src/secrets/Crypto.js";

// --- KeyringBackend interface ---

function makeMockBackend(): KeyringBackend {
  const store = new Map<string, string>();
  return {
    get: vi.fn((service: string, account: string): KeyringGetResult => {
      const v = store.get(`${service}:${account}`);
      return v === undefined ? { kind: "not-found" } : { kind: "value", value: v };
    }),
    set: vi.fn((service, account, value) => { store.set(`${service}:${account}`, value); }),
    delete: vi.fn((service, account) => {
      const key = `${service}:${account}`;
      const had = store.has(key);
      store.delete(key);
      return had;
    }),
  };
}

describe("KeyringBackend mock — passthrough", () => {
  it("set then get returns stored value as tri-state value result", () => {
    const backend = makeMockBackend();
    backend.set("svc", "acct", "secret");
    expect(backend.get("svc", "acct")).toEqual({ kind: "value", value: "secret" });
    expect(backend.set).toHaveBeenCalledWith("svc", "acct", "secret");
    expect(backend.get).toHaveBeenCalledWith("svc", "acct");
  });

  it("delete removes value and returns true; subsequent get returns not-found", () => {
    const backend = makeMockBackend();
    backend.set("svc", "acct", "x");
    expect(backend.delete("svc", "acct")).toBe(true);
    expect(backend.get("svc", "acct")).toEqual({ kind: "not-found" });
  });

  it("delete of missing key returns false", () => {
    const backend = makeMockBackend();
    expect(backend.delete("svc", "acct")).toBe(false);
  });
});

// --- createKeyringBackend smoke test ---

describe("createKeyringBackend — smoke", () => {
  it("does not throw and returns KeyringBackend or null", () => {
    let result: KeyringBackend | null;
    expect(() => { result = createKeyringBackend(); }).not.toThrow();
    // Result is either null (no keyring on this platform) or an object with the right shape.
    if (result! !== null) {
      expect(typeof result!.get).toBe("function");
      expect(typeof result!.set).toBe("function");
      expect(typeof result!.delete).toBe("function");
    }
  });
});

// --- MasterKeyManager ---

function tmpDir(): string {
  const d = join(tmpdir(), `mkm-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("MasterKeyManager — existing keyring key", () => {
  it("returns the hex-decoded key stored in keyring", async () => {
    const backend = makeMockBackend();
    const existingKey = randomBytes(32);
    backend.set(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER, existingKey.toString("hex"));

    const dir = tmpDir();
    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath: join(dir, "secrets.salt"),
      vaultDbPath: join(dir, "secrets.db"),
    });

    const key = await mgr.ensureInitialized();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.equals(existingKey)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("MasterKeyManager — first run with keyring", () => {
  it("generates a 32-byte key and stores it in keyring", async () => {
    const backend = makeMockBackend();
    const dir = tmpDir();

    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath: join(dir, "secrets.salt"),
      vaultDbPath: join(dir, "secrets.db"),
    });

    const key = await mgr.ensureInitialized();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.byteLength).toBe(32);
    expect(backend.set).toHaveBeenCalledWith(
      KEYRING_SERVICE,
      KEYRING_ACCOUNT_MASTER,
      key.toString("hex"),
    );

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("MasterKeyManager — first run with null keyring + injected promptFn", () => {
  it("generates salt file and derives a 32-byte key from passphrase", async () => {
    const dir = tmpDir();
    const saltPath = join(dir, "secrets.salt");
    const promptFn = vi.fn().mockResolvedValue("test-passphrase");

    const mgr = new MasterKeyManager({
      keyringBackend: null,
      saltPath,
      vaultDbPath: join(dir, "secrets.db"),
      promptFn,
    });

    const key = await mgr.ensureInitialized();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.byteLength).toBe(32);
    expect(existsSync(saltPath)).toBe(true);
    // confirm:true path is called on first run
    expect(promptFn).toHaveBeenCalledWith({ confirm: true });

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("MasterKeyManager — subsequent run with null keyring + existing salt", () => {
  it("derives the same key given the same passphrase", async () => {
    const dir = tmpDir();
    const saltPath = join(dir, "secrets.salt");
    const dbPath = join(dir, "secrets.db");
    const passphrase = "test-passphrase";

    // First run: creates salt
    const promptFn1 = vi.fn().mockResolvedValue(passphrase);
    const mgr1 = new MasterKeyManager({
      keyringBackend: null,
      saltPath,
      vaultDbPath: dbPath,
      promptFn: promptFn1,
    });
    const key1 = await mgr1.ensureInitialized();

    // Second run: salt exists, derive from it
    const promptFn2 = vi.fn().mockResolvedValue(passphrase);
    const mgr2 = new MasterKeyManager({
      keyringBackend: null,
      saltPath,
      vaultDbPath: dbPath,
      promptFn: promptFn2,
    });
    const key2 = await mgr2.ensureInitialized();

    expect(key1.equals(key2)).toBe(true);
    // Second run uses no confirm (existing salt path)
    expect(promptFn2).toHaveBeenCalledWith();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("MasterKeyManager — zeroize", () => {
  it("clears cached key and getMasterKey throws until re-initialized", async () => {
    const backend = makeMockBackend();
    const dir = tmpDir();

    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath: join(dir, "secrets.salt"),
      vaultDbPath: join(dir, "secrets.db"),
    });

    await mgr.ensureInitialized();
    mgr.zeroize();

    await expect(mgr.getMasterKey()).rejects.toThrow("ensureInitialized");

    rmSync(dir, { recursive: true, force: true });
  });
});

// --- Vault-overwrite protection (Codex HIGH #3 regression tests) ---

function seedVault(dbPath: string, key: Buffer): void {
  const v = new Vault({ dbPath, masterKey: key });
  v.init();
  v.set("known", "expected-value");
  v.close();
}

describe("MasterKeyManager — refuses to overwrite an existing vault", () => {
  it("rejects when keyring access errors and a vault already exists", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "secrets.db");
    const realKey = randomBytes(32);
    seedVault(dbPath, realKey);

    const backend: KeyringBackend = {
      get: vi.fn((): KeyringGetResult => ({ kind: "error", error: "keyring locked" })),
      set: vi.fn(),
      delete: vi.fn(() => false),
    };

    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath: join(dir, "secrets.salt"),
      vaultDbPath: dbPath,
    });

    await expect(mgr.ensureInitialized()).rejects.toThrow(/keyring unavailable/i);
    expect(backend.set).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects when keyring has no entry, vault exists, and there is no salt for recovery", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "secrets.db");
    const realKey = randomBytes(32);
    seedVault(dbPath, realKey);

    const backend = makeMockBackend();
    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath: join(dir, "secrets.salt"),
      vaultDbPath: dbPath,
    });

    await expect(mgr.ensureInitialized()).rejects.toThrow(/Restore the keyring entry|delete the vault/i);
    expect(backend.set).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects when keyring has no entry, vault and salt exist, but passphrase derives a non-matching key", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "secrets.db");
    const saltPath = join(dir, "secrets.salt");

    const correctSalt = generateSalt();
    const correctKey = deriveKeyFromPassphrase("the-real-passphrase", correctSalt);
    writeFileSync(saltPath, correctSalt);
    seedVault(dbPath, correctKey);

    const backend = makeMockBackend();
    const promptFn = vi.fn().mockResolvedValue("wrong-passphrase");

    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath,
      vaultDbPath: dbPath,
      promptFn,
    });

    await expect(mgr.ensureInitialized()).rejects.toThrow(/Passphrase did not match/i);
    expect(backend.set).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a correct passphrase when the vault and salt exist and keyring has no entry", async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "secrets.db");
    const saltPath = join(dir, "secrets.salt");

    const passphrase = "correct-horse-battery-staple";
    const salt = generateSalt();
    const expectedKey = deriveKeyFromPassphrase(passphrase, salt);
    writeFileSync(saltPath, salt);
    seedVault(dbPath, expectedKey);

    const backend = makeMockBackend();
    const promptFn = vi.fn().mockResolvedValue(passphrase);

    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath,
      vaultDbPath: dbPath,
      promptFn,
    });

    const key = await mgr.ensureInitialized();
    expect(key.equals(expectedKey)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});
