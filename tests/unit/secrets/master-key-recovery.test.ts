// tests/unit/secrets/master-key-recovery.test.ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
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
