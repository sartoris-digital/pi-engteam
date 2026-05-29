// tests/unit/secrets/master-key-recovery.test.ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { MasterKeyManager } from "../../../src/secrets/MasterKey.js";
import { Vault } from "../../../src/secrets/Vault.js";
import type { KeyringBackend, KeyringGetResult } from "../../../src/secrets/Keyring.js";

function tmpDir(): string {
  const d = join(tmpdir(), `mk-rec-${randomBytes(6).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// In-memory keyring backend; constructed empty unless `seed` provided.
function fakeKeyring(seed?: Record<string, string>): KeyringBackend & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  const k = (s: string, a: string) => `${s}:${a}`;
  return {
    store,
    get(s, a): KeyringGetResult {
      const v = store.get(k(s, a));
      return v === undefined ? { kind: "not-found" } : { kind: "value", value: v };
    },
    set(s, a, v) { store.set(k(s, a), v); },
    delete(s, a) { return store.delete(k(s, a)); },
  };
}

describe("MasterKeyManager.enrollRecovery", () => {
  it("writes a recovery blob that can later unwrap the same key, and tracks unlockSource", async () => {
    const dir = tmpDir();
    const vaultDbPath = join(dir, "secrets.db");
    const saltPath = join(dir, "secrets.salt");
    const backend = fakeKeyring();

    const mgr = new MasterKeyManager({ keyringBackend: backend, saltPath, vaultDbPath });
    const key = await mgr.ensureInitialized();
    expect(mgr.unlockSource).toBe("first-run-keychain");

    const v = new Vault({ dbPath: vaultDbPath, masterKey: key });
    v.init();
    v.set("api", "secret-value");
    v.close();

    await mgr.enrollRecovery("my-recovery-pass");

    const check = new Vault({ dbPath: vaultDbPath, masterKey: key });
    check.init();
    expect(check.hasRecoveryBackup()).toBe(true);
    check.close();
  });

  it("refuses to enroll before the vault is unlocked", async () => {
    const dir = tmpDir();
    const mgr = new MasterKeyManager({
      keyringBackend: fakeKeyring(),
      saltPath: join(dir, "secrets.salt"),
      vaultDbPath: join(dir, "secrets.db"),
    });
    await expect(mgr.enrollRecovery("x")).rejects.toThrow(/unlock/i);
  });
});

describe("MasterKeyManager.ensureInitialized — Approach A recovery precedence", () => {
  // Build a vault with one secret + an enrolled recovery passphrase, then return
  // paths so a SECOND manager can simulate "keychain entry gone".
  async function seedVaultWithRecovery(passphrase: string) {
    const dir = tmpDir();
    const vaultDbPath = join(dir, "secrets.db");
    const saltPath = join(dir, "secrets.salt");
    const backend = fakeKeyring();
    const mgr = new MasterKeyManager({ keyringBackend: backend, saltPath, vaultDbPath });
    const key = await mgr.ensureInitialized();
    const v = new Vault({ dbPath: vaultDbPath, masterKey: key });
    v.init();
    v.set("api", "the-value");
    v.close();
    await mgr.enrollRecovery(passphrase);
    return { dir, vaultDbPath, saltPath };
  }

  it("recovers via the vault_meta blob when the keychain entry is gone — and does NOT write to the keychain", async () => {
    const { vaultDbPath, saltPath } = await seedVaultWithRecovery("recover-me");
    const emptyBackend = fakeKeyring(); // keychain entry "gone"
    const mgr = new MasterKeyManager({
      keyringBackend: emptyBackend,
      saltPath,
      vaultDbPath,
      promptFn: async () => "recover-me",
    });
    const key = await mgr.ensureInitialized();
    expect(mgr.unlockSource).toBe("passphrase-recovery");
    expect(emptyBackend.store.size).toBe(0); // re-store deferred to /secret-reconnect
    const v = new Vault({ dbPath: vaultDbPath, masterKey: key });
    v.init();
    expect(v.get("api")).toBe("the-value");
    v.close();
  });

  it("rejects a wrong recovery passphrase with no state change", async () => {
    const { vaultDbPath, saltPath } = await seedVaultWithRecovery("right-pass");
    const mgr = new MasterKeyManager({
      keyringBackend: fakeKeyring(),
      saltPath,
      vaultDbPath,
      promptFn: async () => "wrong-pass",
    });
    await expect(mgr.ensureInitialized()).rejects.toThrow(/did not match/i);
  });

  it("keychain value takes precedence over the recovery blob", async () => {
    const { vaultDbPath, saltPath } = await seedVaultWithRecovery("recover-me");
    const backend = fakeKeyring();
    const recoverMgr = new MasterKeyManager({ keyringBackend: fakeKeyring(), saltPath, vaultDbPath, promptFn: async () => "recover-me" });
    const key = await recoverMgr.ensureInitialized();
    backend.set("pi-engineering", "secrets-master", key.toString("hex"));
    const mgr = new MasterKeyManager({
      keyringBackend: backend,
      saltPath,
      vaultDbPath,
      promptFn: async () => { throw new Error("should not prompt"); },
    });
    const got = await mgr.ensureInitialized();
    expect(mgr.unlockSource).toBe("keychain");
    expect(got.equals(key)).toBe(true);
  });

  it("fails closed when keychain is gone, no blob, and no salt", async () => {
    const dir = tmpDir();
    const vaultDbPath = join(dir, "secrets.db");
    const v = new Vault({ dbPath: vaultDbPath, masterKey: randomBytes(32) });
    v.init();
    v.set("x", "y");
    v.close();
    const mgr = new MasterKeyManager({
      keyringBackend: fakeKeyring(),
      saltPath: join(dir, "secrets.salt"),
      vaultDbPath,
      promptFn: async () => "anything",
    });
    await expect(mgr.ensureInitialized()).rejects.toThrow(/no master key in keyring and no passphrase salt/i);
  });

  it("empty vault + recovery blob: GCM tag still rejects a wrong passphrase", async () => {
    // Build a vault with a recovery blob but NO secrets written — verifyDecryptable()
    // is vacuously true for an empty vault, so the GCM auth tag on the wrapped key
    // (inside unwrapMasterKey) must be the sole passphrase gate.
    async function seedEmptyVaultWithRecovery(passphrase: string) {
      const dir = tmpDir();
      const vaultDbPath = join(dir, "secrets.db");
      const saltPath = join(dir, "secrets.salt");
      const backend = fakeKeyring();
      const mgr = new MasterKeyManager({ keyringBackend: backend, saltPath, vaultDbPath });
      await mgr.ensureInitialized();
      // Intentionally skip v.set(...) — vault stays empty.
      await mgr.enrollRecovery(passphrase);
      return { vaultDbPath, saltPath };
    }

    const { vaultDbPath, saltPath } = await seedEmptyVaultWithRecovery("correct-pass");

    // A second manager with empty keychain and a WRONG passphrase must be rejected.
    const mgr = new MasterKeyManager({
      keyringBackend: fakeKeyring(), // empty — no keychain entry
      saltPath,
      vaultDbPath,
      promptFn: async () => "wrong-pass",
    });

    await expect(mgr.ensureInitialized()).rejects.toThrow(/did not match/i);
  });
});
