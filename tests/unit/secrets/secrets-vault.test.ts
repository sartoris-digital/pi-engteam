// tests/unit/secrets/secrets-vault.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import {
  generateMasterKey,
  generateSalt,
  deriveKeyFromPassphrase,
  encrypt,
  decrypt,
} from "../../../src/secrets/Crypto.js";
import { Vault } from "../../../src/secrets/Vault.js";

// --- Crypto ---

describe("Crypto — round-trip", () => {
  it("encrypt then decrypt yields original plaintext", () => {
    const key = generateMasterKey();
    const plaintext = "super-secret-value-42";
    const { ciphertext, iv, tag } = encrypt(plaintext, key);
    expect(decrypt(ciphertext, key, iv, tag)).toBe(plaintext);
  });
});

describe("Crypto — tamper detection", () => {
  it("flipped ciphertext byte causes decrypt to throw", () => {
    const key = generateMasterKey();
    const { ciphertext, iv, tag } = encrypt("secret", key);
    ciphertext[0] ^= 0xff;
    expect(() => decrypt(ciphertext, key, iv, tag)).toThrow();
  });

  it("flipped auth tag byte causes decrypt to throw", () => {
    const key = generateMasterKey();
    const { ciphertext, iv, tag } = encrypt("secret", key);
    tag[0] ^= 0xff;
    expect(() => decrypt(ciphertext, key, iv, tag)).toThrow();
  });
});

describe("Crypto — KDF determinism", () => {
  it("same passphrase + salt yields identical key", () => {
    const salt = generateSalt();
    const k1 = deriveKeyFromPassphrase("hunter2", salt);
    const k2 = deriveKeyFromPassphrase("hunter2", salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("different salt yields different key", () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const k1 = deriveKeyFromPassphrase("hunter2", salt1);
    const k2 = deriveKeyFromPassphrase("hunter2", salt2);
    expect(k1.equals(k2)).toBe(false);
  });
});

// --- Vault ---

let vaultDir: string;
let vault: Vault;

function freshVault(): Vault {
  vaultDir = join(tmpdir(), `vault-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(vaultDir, { recursive: true });
  const v = new Vault({ dbPath: join(vaultDir, "secrets.db"), masterKey: generateMasterKey() });
  v.init();
  return v;
}

afterEach(() => {
  try { vault.close(); } catch { /* already closed */ }
  try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("Vault — set / get", () => {
  it("set then get returns the stored value", () => {
    vault = freshVault();
    vault.set("MY_KEY", "my-value");
    expect(vault.get("MY_KEY")).toBe("my-value");
  });

  it("get of nonexistent name returns null", () => {
    vault = freshVault();
    expect(vault.get("MISSING")).toBeNull();
  });
});

describe("Vault — use_count", () => {
  it("get increments use_count on each call", () => {
    vault = freshVault();
    vault.set("K", "v");
    vault.get("K");
    vault.get("K");
    const row = vault.list().find((r) => r.name === "K");
    expect(row?.use_count).toBe(2);
  });
});

describe("Vault — replace", () => {
  it("set on existing name overwrites value and resets use_count", () => {
    vault = freshVault();
    vault.set("K", "old");
    vault.get("K"); // use_count = 1
    vault.set("K", "new");
    expect(vault.get("K")).toBe("new");
    const row = vault.list().find((r) => r.name === "K");
    // INSERT OR REPLACE resets use_count to 0; then the get above increments to 1
    expect(row?.use_count).toBe(1);
  });
});

describe("Vault — remove", () => {
  it("remove deletes the entry and returns true", () => {
    vault = freshVault();
    vault.set("K", "v");
    expect(vault.remove("K")).toBe(true);
    expect(vault.get("K")).toBeNull();
  });

  it("remove of nonexistent name returns false", () => {
    vault = freshVault();
    expect(vault.remove("MISSING")).toBe(false);
  });
});

describe("Vault — list", () => {
  it("list never includes plaintext values", () => {
    vault = freshVault();
    vault.set("A", "secret-a", "note a");
    vault.set("B", "secret-b");
    const rows = vault.list();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty("value");
      expect(row).not.toHaveProperty("value_enc");
      const json = JSON.stringify(row);
      expect(json).not.toContain("secret-a");
      expect(json).not.toContain("secret-b");
    }
  });

  it("list includes expected metadata fields", () => {
    vault = freshVault();
    vault.set("X", "val", "a note");
    const [row] = vault.list();
    expect(row.name).toBe("X");
    expect(row.notes).toBe("a note");
    expect(typeof row.created_at).toBe("number");
    expect(row.use_count).toBe(0);
  });
});
