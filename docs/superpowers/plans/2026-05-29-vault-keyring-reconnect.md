# Vault ↔ Keyring Reconnect & Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user recover the secrets vault after losing OS-keychain access (Node/extension update, new machine/user) by enrolling a passphrase-wrapped backup of the master key and providing a `/secret-reconnect` repair command.

**Architecture:** Envelope encryption — the random master key stays the zero-friction keychain primary; a scrypt(passphrase)-derived KEK wraps a copy of it, stored in the vault DB's plaintext `vault_meta` table so recovery travels with the portable `secrets.db` file. A new `/secret-reconnect` command diagnoses Mode 1 (keyring addon ABI failure) vs Mode 2 (keychain entry gone) and, for Mode 2, unwraps with the passphrase and re-stores the key into the keychain. Startup nags keychain-only vaults that have no backup.

**Tech Stack:** TypeScript (ESM), Node `crypto` (AES-256-GCM, scrypt), `better-sqlite3`, `@napi-rs/keyring`, vitest, tsup. Spec: `docs/superpowers/specs/2026-05-29-vault-keyring-reconnect-design.md`. Branch: `feat/vault-keyring-reconnect`.

**Working-tree note:** This branch carries unrelated uncommitted changes (install hardening, workflow/test fixes, log-prefix cleanup). Do **not** stage them. Every commit below stages only the files it names.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/secrets/Crypto.ts` | `wrapMasterKey` / `unwrapMasterKey` envelope helpers | Modify |
| `src/secrets/Vault.ts` | `RecoveryBlob` type + `getMeta`/`hasRecoveryBackup`/`readRecoveryBlob`/`writeRecoveryBlob` | Modify |
| `src/secrets/Keyring.ts` | `classifyKeyringError`, `diagnoseKeyring`, `decideReconnectMode` | Modify |
| `src/secrets/MasterKey.ts` | `enrollRecovery`, `unlockSource`, recovery branch in `ensureInitialized` | Modify |
| `src/commands/secret-shared.ts` | `buildMasterKeyManager` helper (DRY for new commands) | Modify |
| `src/commands/secret-setup-recovery.ts` | `/secret-setup-recovery` enrollment command (thin) | Create |
| `src/commands/secret-reconnect.ts` | `/secret-reconnect` diagnose + repair command (thin) | Create |
| `src/commands/doctor.ts` | read-only vault/recovery checks + `warn` severity | Modify |
| `src/index.ts` | register the two commands; startup nag | Modify |
| `scripts/install.sh` | keyring addon smoke-test | Modify |
| `tests/unit/secrets/recovery-crypto.test.ts` | wrap/unwrap tests | Create |
| `tests/unit/secrets/secrets-vault.test.ts` | recovery-blob tests | Modify |
| `tests/unit/secrets/keyring-diagnose.test.ts` | classifier + reconnect-mode tests | Create |
| `tests/unit/secrets/master-key-recovery.test.ts` | enroll + precedence matrix tests | Create |

Dependency direction (leaf → consumer): `Crypto` → `Vault` → `MasterKey` / `Keyring` → `commands` → `index`.

---

## Task 1: Envelope wrap/unwrap helpers (`Crypto.ts`)

**Files:**
- Modify: `src/secrets/Crypto.ts`
- Test: `tests/unit/secrets/recovery-crypto.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/secrets/recovery-crypto.test.ts`:

```typescript
// tests/unit/secrets/recovery-crypto.test.ts
import { describe, it, expect } from "vitest";
import { generateMasterKey, generateSalt, wrapMasterKey, unwrapMasterKey } from "../../../src/secrets/Crypto.js";

describe("Crypto — master-key envelope wrap/unwrap", () => {
  it("round-trips the master key with the correct passphrase", () => {
    const mk = generateMasterKey();
    const salt = generateSalt();
    const { wrap, iv, tag } = wrapMasterKey(mk, "correct horse", salt);
    const recovered = unwrapMasterKey(wrap, iv, tag, "correct horse", salt);
    expect(recovered.equals(mk)).toBe(true);
  });

  it("throws on a wrong passphrase (GCM tag failure)", () => {
    const mk = generateMasterKey();
    const salt = generateSalt();
    const { wrap, iv, tag } = wrapMasterKey(mk, "right", salt);
    expect(() => unwrapMasterKey(wrap, iv, tag, "wrong", salt)).toThrow();
  });

  it("throws on a tampered wrap byte", () => {
    const mk = generateMasterKey();
    const salt = generateSalt();
    const { wrap, iv, tag } = wrapMasterKey(mk, "pw", salt);
    wrap[0] ^= 0xff;
    expect(() => unwrapMasterKey(wrap, iv, tag, "pw", salt)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/secrets/recovery-crypto.test.ts`
Expected: FAIL — `wrapMasterKey`/`unwrapMasterKey` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/secrets/Crypto.ts` (after `zeroBuffer`):

```typescript
// Envelope encryption for vault recovery: a passphrase-derived KEK wraps a copy
// of the random master key. The wrapped copy is stored in vault_meta so the
// vault can be reopened after OS-keychain access is lost. The master key is
// serialized as hex through the existing string-oriented encrypt/decrypt.
export function wrapMasterKey(
  masterKey: Buffer,
  passphrase: string,
  salt: Buffer,
): { wrap: Buffer; iv: Buffer; tag: Buffer } {
  const kek = deriveKeyFromPassphrase(passphrase, salt);
  try {
    const { ciphertext, iv, tag } = encrypt(masterKey.toString("hex"), kek);
    return { wrap: ciphertext, iv, tag };
  } finally {
    zeroBuffer(kek);
  }
}

export function unwrapMasterKey(
  wrap: Buffer,
  iv: Buffer,
  tag: Buffer,
  passphrase: string,
  salt: Buffer,
): Buffer {
  const kek = deriveKeyFromPassphrase(passphrase, salt);
  try {
    const hex = decrypt(wrap, kek, iv, tag); // throws on wrong passphrase / tamper
    return Buffer.from(hex, "hex");
  } finally {
    zeroBuffer(kek);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/secrets/recovery-crypto.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/secrets/Crypto.ts tests/unit/secrets/recovery-crypto.test.ts
git commit -m "feat(secrets): envelope wrap/unwrap for master-key recovery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Recovery blob storage in `Vault.ts`

**Files:**
- Modify: `src/secrets/Vault.ts`
- Test: `tests/unit/secrets/secrets-vault.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/secrets/secrets-vault.test.ts` (it already imports `Vault`, `generateMasterKey`, `tmpdir`, `join`, `mkdirSync`, `rmSync`, `randomBytes`, `afterEach`):

```typescript
// --- Recovery blob ---
import { RECOVERY_KDF, type RecoveryBlob } from "../../../src/secrets/Vault.js";

function freshVaultPath(): string {
  const dir = join(tmpdir(), `vault-rec-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "secrets.db");
}

describe("Vault — recovery blob", () => {
  it("round-trips a recovery blob through vault_meta", () => {
    const v = new Vault({ dbPath: freshVaultPath(), masterKey: generateMasterKey() });
    v.init();
    expect(v.hasRecoveryBackup()).toBe(false);
    const blob: RecoveryBlob = {
      salt: randomBytes(16),
      wrap: randomBytes(48),
      iv: randomBytes(12),
      tag: randomBytes(16),
      kdf: RECOVERY_KDF,
      enrolledAt: 1700000000000,
    };
    v.writeRecoveryBlob(blob);
    expect(v.hasRecoveryBackup()).toBe(true);
    const read = v.readRecoveryBlob()!;
    expect(read.salt.equals(blob.salt)).toBe(true);
    expect(read.wrap.equals(blob.wrap)).toBe(true);
    expect(read.iv.equals(blob.iv)).toBe(true);
    expect(read.tag.equals(blob.tag)).toBe(true);
    expect(read.kdf).toBe(RECOVERY_KDF);
    expect(read.enrolledAt).toBe(1700000000000);
    v.close();
  });

  it("returns null when no blob is enrolled", () => {
    const v = new Vault({ dbPath: freshVaultPath(), masterKey: generateMasterKey() });
    v.init();
    expect(v.readRecoveryBlob()).toBeNull();
    v.close();
  });

  it("throws a distinct corrupt error on a partial blob", () => {
    const path = freshVaultPath();
    const v = new Vault({ dbPath: path, masterKey: generateMasterKey() });
    v.init();
    // Write only some of the rows directly to simulate a partial/corrupt blob.
    (v as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('recovery_salt', ?)")
      .run(randomBytes(16).toString("hex"));
    expect(() => v.readRecoveryBlob()).toThrow(/corrupt|incomplete/i);
    v.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/secrets/secrets-vault.test.ts -t "recovery blob"`
Expected: FAIL — `RECOVERY_KDF`/`RecoveryBlob`/`writeRecoveryBlob` not exported.

- [ ] **Step 3: Implement in `src/secrets/Vault.ts`**

Add near the top (after the `SecretRow` type):

```typescript
export const RECOVERY_KDF = "scrypt-N32768-r8-p1";

export type RecoveryBlob = {
  salt: Buffer;
  wrap: Buffer;
  iv: Buffer;
  tag: Buffer;
  kdf: string;
  enrolledAt: number;
};
```

Add these methods to the `Vault` class (after `verifyDecryptable`):

```typescript
  private getMeta(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM vault_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  hasRecoveryBackup(): boolean {
    return this.getMeta("recovery_wrap") !== undefined;
  }

  // Reads the passphrase-wrapped master-key backup from vault_meta. Returns null
  // when nothing is enrolled. Throws a distinct "corrupt" error when the blob is
  // partially written so callers don't mistake it for a wrong passphrase.
  readRecoveryBlob(): RecoveryBlob | null {
    const salt = this.getMeta("recovery_salt");
    const wrap = this.getMeta("recovery_wrap");
    const iv = this.getMeta("recovery_iv");
    const tag = this.getMeta("recovery_tag");
    const kdf = this.getMeta("recovery_kdf");
    const enrolledAt = this.getMeta("recovery_enrolled_at");

    const present = [salt, wrap, iv, tag, kdf].filter((v) => v !== undefined).length;
    if (present === 0) return null;
    if (present !== 5) {
      throw new Error("Vault recovery blob is incomplete/corrupt — re-run /secret-setup-recovery while the vault is unlocked.");
    }
    try {
      return {
        salt: Buffer.from(salt!, "hex"),
        wrap: Buffer.from(wrap!, "hex"),
        iv: Buffer.from(iv!, "hex"),
        tag: Buffer.from(tag!, "hex"),
        kdf: kdf!,
        enrolledAt: enrolledAt ? Number(enrolledAt) : 0,
      };
    } catch {
      throw new Error("Vault recovery blob is corrupt (invalid hex) — re-run /secret-setup-recovery while the vault is unlocked.");
    }
  }

  // Writes all rows in a single transaction so a crash can never leave a
  // partially-written (unusable) blob behind.
  writeRecoveryBlob(blob: RecoveryBlob): void {
    const upsert = this.db.prepare(
      "INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)",
    );
    const tx = this.db.transaction((b: RecoveryBlob) => {
      upsert.run("recovery_salt", b.salt.toString("hex"));
      upsert.run("recovery_wrap", b.wrap.toString("hex"));
      upsert.run("recovery_iv", b.iv.toString("hex"));
      upsert.run("recovery_tag", b.tag.toString("hex"));
      upsert.run("recovery_kdf", b.kdf);
      upsert.run("recovery_enrolled_at", String(b.enrolledAt));
    });
    tx(blob);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/secrets/secrets-vault.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/secrets/Vault.ts tests/unit/secrets/secrets-vault.test.ts
git commit -m "feat(secrets): store passphrase-wrapped recovery blob in vault_meta

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Keyring diagnosis + reconnect-mode decision (`Keyring.ts`)

**Files:**
- Modify: `src/secrets/Keyring.ts`
- Test: `tests/unit/secrets/keyring-diagnose.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/secrets/keyring-diagnose.test.ts`:

```typescript
// tests/unit/secrets/keyring-diagnose.test.ts
import { describe, it, expect } from "vitest";
import { classifyKeyringError, decideReconnectMode } from "../../../src/secrets/Keyring.js";

describe("classifyKeyringError", () => {
  it("classifies ABI / load failures as load-failed", () => {
    expect(classifyKeyringError(new Error("NODE_MODULE_VERSION 115 ... 127")).status).toBe("load-failed");
    expect(classifyKeyringError(new Error("Cannot find module 'keyring.darwin-arm64.node'")).status).toBe("load-failed");
    expect(classifyKeyringError(new Error("dlopen failed: symbol not found")).status).toBe("load-failed");
  });

  it("classifies access denials as locked", () => {
    expect(classifyKeyringError(new Error("errSecAuthFailed")).status).toBe("locked");
    expect(classifyKeyringError(new Error("User interaction is not allowed")).status).toBe("locked");
  });

  it("falls back to unavailable", () => {
    expect(classifyKeyringError(new Error("something weird")).status).toBe("unavailable");
  });
});

describe("decideReconnectMode", () => {
  it("addon load failure → mode1", () => {
    expect(decideReconnectMode({ status: "load-failed" }, false)).toBe("mode1");
  });
  it("locked keyring → locked", () => {
    expect(decideReconnectMode({ status: "locked" }, false)).toBe("locked");
  });
  it("ok + key present → healthy", () => {
    expect(decideReconnectMode({ status: "ok" }, true)).toBe("healthy");
  });
  it("ok + key absent → mode2", () => {
    expect(decideReconnectMode({ status: "ok" }, false)).toBe("mode2");
  });
  it("unavailable → mode2 (try passphrase recovery)", () => {
    expect(decideReconnectMode({ status: "unavailable" }, false)).toBe("mode2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/secrets/keyring-diagnose.test.ts`
Expected: FAIL — `classifyKeyringError`/`decideReconnectMode` not exported.

- [ ] **Step 3: Implement in `src/secrets/Keyring.ts`**

Add after the existing `isNotFoundError` function:

```typescript
export type KeyringDiagnosis = {
  status: "ok" | "load-failed" | "locked" | "unavailable";
  detail?: string;
};

export type ReconnectMode = "mode1" | "locked" | "healthy" | "mode2";

// Classify a thrown keyring error into an actionable status. "load-failed" means
// the native addon could not be loaded (ABI mismatch / missing binary) — Mode 1,
// fixed by rebuilding via engineering:install. "locked" means the OS keychain
// denied access. Everything else is "unavailable".
export function classifyKeyringError(err: unknown): KeyringDiagnosis {
  const msg = err instanceof Error ? err.message : String(err);
  if (/NODE_MODULE_VERSION|was compiled against|cannot find module|module did not self-register|dlopen|invalid ELF|symbol not found|\.node/i.test(msg)) {
    return { status: "load-failed", detail: msg };
  }
  if (/locked|auth.*fail|errSecAuthFailed|denied|not allowed|interaction is not allowed/i.test(msg)) {
    return { status: "locked", detail: msg };
  }
  return { status: "unavailable", detail: msg };
}

// Probe the keyring addon without mutating anything. Used only by /secret-reconnect
// and doctor — the createKeyringBackend() null contract is unchanged for the hot path.
export function diagnoseKeyring(): KeyringDiagnosis {
  try {
    configureSideloadedKeyringBinding();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    const probe = new Entry(KEYRING_SERVICE, "__probe__");
    try {
      probe.getPassword();
    } catch (e) {
      if (!isNotFoundError(e)) return classifyKeyringError(e);
    }
    return { status: "ok" };
  } catch (e) {
    return classifyKeyringError(e);
  }
}

// Pure decision: given a keyring diagnosis and whether the keychain currently
// holds the master key, decide what /secret-reconnect should do.
export function decideReconnectMode(diag: KeyringDiagnosis, keychainHasKey: boolean): ReconnectMode {
  if (diag.status === "load-failed") return "mode1";
  if (diag.status === "locked") return "locked";
  if (diag.status === "ok" && keychainHasKey) return "healthy";
  return "mode2";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/secrets/keyring-diagnose.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/secrets/Keyring.ts tests/unit/secrets/keyring-diagnose.test.ts
git commit -m "feat(secrets): keyring diagnosis + reconnect-mode decision

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `enrollRecovery` + unlock-source tracking (`MasterKey.ts`)

**Files:**
- Modify: `src/secrets/MasterKey.ts`
- Test: `tests/unit/secrets/master-key-recovery.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/secrets/master-key-recovery.test.ts`:

```typescript
// tests/unit/secrets/master-key-recovery.test.ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
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

    // First-run via keychain: generates + stores a random key.
    const mgr = new MasterKeyManager({ keyringBackend: backend, saltPath, vaultDbPath });
    const key = await mgr.ensureInitialized();
    expect(mgr.unlockSource).toBe("first-run-keychain");

    // Need an actual vault file for enrollment to write into.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/secrets/master-key-recovery.test.ts -t "enrollRecovery"`
Expected: FAIL — `unlockSource`/`enrollRecovery` do not exist.

- [ ] **Step 3: Implement in `src/secrets/MasterKey.ts`**

Update imports at the top:

```typescript
import { readFileSync, writeFileSync, existsSync } from "fs";
import { generateMasterKey, generateSalt, deriveKeyFromPassphrase, wrapMasterKey, unwrapMasterKey, zeroBuffer } from "./Crypto.js";
import { type KeyringBackend, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER } from "./Keyring.js";
import { type promptPassphrase } from "./Passphrase.js";
import { Vault, RECOVERY_KDF, type RecoveryBlob } from "./Vault.js";
```

Add an `unlockSource` field and initialize it. Inside the class, change the field block:

```typescript
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
```

In `ensureInitialized()`, set `this.unlockSource` in each branch:
- keychain `"value"` branch (line ~32): add `this.unlockSource = "keychain";` before returning.
- the first-run `if (keyringBackend) { const key = generateMasterKey(); ... }` branch (line ~80): add `this.unlockSource = "first-run-keychain";` after `this.cachedKey = key;`.
- the no-keychain first-run passphrase branch (line ~84 `else { ... }`): add `this.unlockSource = "passphrase";` after `this.cachedKey = deriveKeyFromPassphrase(...)`.
- the existing legacy `saltPath` recovery branch (line ~57-67) and the "salt without vault" branch (line ~71-77): add `this.unlockSource = "passphrase";` where the key is cached.

Add `enrollRecovery` after `getMaster​Key`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/secrets/master-key-recovery.test.ts -t "enrollRecovery"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/secrets/MasterKey.ts tests/unit/secrets/master-key-recovery.test.ts
git commit -m "feat(secrets): MasterKeyManager.enrollRecovery + unlockSource tracking

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Recovery branch in `ensureInitialized` (Approach A precedence)

**Files:**
- Modify: `src/secrets/MasterKey.ts`
- Test: `tests/unit/secrets/master-key-recovery.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/secrets/master-key-recovery.test.ts`:

```typescript
describe("MasterKeyManager.ensureInitialized — Approach A recovery precedence", () => {
  // Helper: build a vault with one secret + an enrolled recovery passphrase,
  // using a keychain-backed manager, then return paths so a SECOND manager can
  // simulate "keychain entry gone".
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
    // Re-store is deferred to /secret-reconnect — startup must not touch the keychain.
    expect(emptyBackend.store.size).toBe(0);
    // The recovered key actually decrypts the vault.
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
    // Re-open with a backend that still HAS the key → must not prompt.
    const backend = fakeKeyring();
    // Re-derive the stored key by recovering once, then seed the keychain with it.
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
    // Create a vault file with a secret but NO recovery blob and NO salt.
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
    await expect(mgr.ensureInitialized()).rejects.toThrow(/no master key in keyring and no passphrase salt|recovery/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/secrets/master-key-recovery.test.ts -t "Approach A"`
Expected: FAIL — recovery-blob branch not implemented; "wrong passphrase" / "keychain gone" cases currently hit the legacy salt/fail-closed path.

- [ ] **Step 3: Implement the recovery branch in `src/secrets/MasterKey.ts`**

Inside `ensureInitialized()`, in the `if (vaultExists) { ... }` block, insert the recovery-blob branch **before** the existing `if (!existsSync(saltPath))` check:

```typescript
    // fail closed when key uncertainty meets an existing vault — silent re-keying is data loss
    if (vaultExists) {
      // Approach A: a passphrase-wrapped backup stored inside the vault DB takes
      // precedence over the legacy sidecar salt. It travels with secrets.db, so
      // it is the recovery path on a new machine/user. Re-storing the recovered
      // key into the keychain is deferred to /secret-reconnect (no silent write).
      const blob = readRecoveryBlobFromVault(vaultDbPath);
      if (blob) {
        if (blob.kdf !== RECOVERY_KDF) {
          throw new Error(`Vault recovery blob uses an unknown KDF (${blob.kdf}); it was created by a newer pi-engineering version. Upgrade to recover.`);
        }
        if (!promptFn) {
          throw new Error("Vault exists but no key in keyring; passphrase recovery requires promptFn to be supplied to MasterKeyManager.");
        }
        const passphrase = await promptFn();
        let candidate: Buffer;
        try {
          candidate = unwrapMasterKey(blob.wrap, blob.iv, blob.tag, passphrase, blob.salt);
        } catch {
          throw new Error("Passphrase did not match. Vault is intact but inaccessible until the correct passphrase is supplied.");
        }
        if (!validateKeyAgainstVault(vaultDbPath, candidate)) {
          zeroBuffer(candidate);
          throw new Error("Passphrase did not match. Vault is intact but inaccessible until the correct passphrase is supplied.");
        }
        this.cachedKey = candidate;
        this.unlockSource = "passphrase-recovery";
        return this.cachedKey;
      }

      if (!existsSync(saltPath)) {
        throw new Error(
          `Vault exists at ${vaultDbPath} but no master key in keyring and no passphrase salt at ${saltPath}. ` +
          `Restore the keyring entry, or delete the vault file to start fresh (DESTRUCTIVE — your stored secrets will be lost).`,
        );
      }
      // ... existing legacy saltPath recovery (unchanged) ...
```

Add a module-level helper near `validateKeyAgainstVault` at the bottom of the file:

```typescript
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
```

- [ ] **Step 4: Run all MasterKey recovery tests**

Run: `pnpm exec vitest run tests/unit/secrets/master-key-recovery.test.ts`
Expected: PASS (all enroll + precedence tests).

- [ ] **Step 5: Commit**

```bash
git add src/secrets/MasterKey.ts tests/unit/secrets/master-key-recovery.test.ts
git commit -m "feat(secrets): recover master key from vault_meta blob (Approach A precedence)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `buildMasterKeyManager` helper (`secret-shared.ts`)

**Files:**
- Modify: `src/commands/secret-shared.ts`

This DRYs the manager construction so both new commands (Tasks 7-8) and the existing `loadVaultForCommand` use one definition. No new test — covered via the command behavior and typecheck.

- [ ] **Step 1: Add the helper and refactor `loadVaultForCommand`**

In `src/commands/secret-shared.ts`, add after the imports + `DATA_DIR`:

```typescript
export const VAULT_DB_PATH = join(DATA_DIR, "secrets.db");
export const VAULT_SALT_PATH = join(DATA_DIR, "secrets.salt");

export function buildMasterKeyManager(): MasterKeyManager {
  return new MasterKeyManager({
    keyringBackend: createKeyringBackend(),
    saltPath: VAULT_SALT_PATH,
    vaultDbPath: VAULT_DB_PATH,
    promptFn: promptPassphrase,
  });
}
```

Then refactor `loadVaultForCommand` to use it:

```typescript
export async function loadVaultForCommand(): Promise<Vault> {
  const manager = buildMasterKeyManager();
  const masterKey = await manager.ensureInitialized();
  const vault = new Vault({ dbPath: VAULT_DB_PATH, masterKey });
  vault.init();
  return vault;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Run the existing secret command/vault tests (no regressions)**

Run: `pnpm exec vitest run tests/unit/commands/secret-commands.test.ts tests/unit/secrets/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/secret-shared.ts
git commit -m "refactor(secrets): extract buildMasterKeyManager helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `/secret-setup-recovery` command

**Files:**
- Create: `src/commands/secret-setup-recovery.ts`

Thin interactive wrapper (enrollment). Verified by typecheck + manual run; the underlying `enrollRecovery` is unit-tested in Task 4.

- [ ] **Step 1: Create `src/commands/secret-setup-recovery.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMasterKeyManager } from "./secret-shared.js";
import { promptPassphrase, isTtyAvailable } from "../secrets/Passphrase.js";

export function registerSecretSetupRecoveryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-setup-recovery", {
    description: "Enroll a recovery passphrase so the vault can be recovered if the OS keychain is lost.",
    handler: async (_args: string, ctx) => {
      if (!isTtyAvailable()) {
        ctx.ui.notify("Recovery enrollment needs an interactive terminal. Run /secret-setup-recovery in a Pi controller session.", "error");
        return;
      }
      const manager = buildMasterKeyManager();
      try {
        await manager.ensureInitialized(); // unlock the vault (keychain or existing recovery/passphrase)
      } catch (err) {
        ctx.ui.notify(`Vault unavailable: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      ctx.ui.notify(
        "Choose a recovery passphrase. Anyone with both the secrets.db file AND this passphrase can decrypt your secrets — pick a strong one.",
        "info",
      );
      try {
        const passphrase = await promptPassphrase({ prompt: "New recovery passphrase: ", confirm: true });
        await manager.enrollRecovery(passphrase);
        ctx.ui.notify("Recovery passphrase enrolled. You can now run /secret-reconnect to recover on a new machine or after a keychain reset.", "info");
      } catch (err) {
        ctx.ui.notify(`Enrollment failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        manager.zeroize();
      }
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/secret-setup-recovery.ts
git commit -m "feat(secrets): /secret-setup-recovery enrollment command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `/secret-reconnect` command

**Files:**
- Create: `src/commands/secret-reconnect.ts`

Thin wrapper over the unit-tested `diagnoseKeyring` / `decideReconnectMode` / `ensureInitialized`. The keychain re-store happens here (explicit).

- [ ] **Step 1: Create `src/commands/secret-reconnect.ts`**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { buildMasterKeyManager, VAULT_DB_PATH } from "./secret-shared.js";
import {
  createKeyringBackend,
  diagnoseKeyring,
  decideReconnectMode,
  KEYRING_SERVICE,
  KEYRING_ACCOUNT_MASTER,
} from "../secrets/Keyring.js";
import { isTtyAvailable } from "../secrets/Passphrase.js";

export function registerSecretReconnectCommand(pi: ExtensionAPI): void {
  pi.registerCommand("secret-reconnect", {
    description: "Diagnose why the vault can't open and reconnect it to the OS keychain.",
    handler: async (_args: string, ctx) => {
      const diag = diagnoseKeyring();
      const backend = createKeyringBackend();
      const keychainHasKey =
        backend?.get(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER).kind === "value";
      const mode = decideReconnectMode(diag, keychainHasKey);

      if (mode === "mode1") {
        ctx.ui.notify(
          `Keyring native addon failed to load (${diag.detail ?? "unknown"}). The Keychain key is intact — rebuild the addon:\n` +
          `  nvm use 22 && pnpm rebuild && pnpm run engineering:install`,
          "error",
        );
        return;
      }
      if (mode === "locked") {
        ctx.ui.notify("OS keychain is locked or denied access. Unlock your login keychain and retry.", "error");
        return;
      }
      if (mode === "healthy") {
        ctx.ui.notify("Vault is already connected to the keychain — nothing to do.", "info");
        return;
      }

      // mode === "mode2": keychain entry is gone. Recover via the passphrase backup.
      if (!existsSync(VAULT_DB_PATH)) {
        ctx.ui.notify("No vault file found — nothing to reconnect.", "info");
        return;
      }
      if (!isTtyAvailable()) {
        ctx.ui.notify("Reconnect needs an interactive terminal for the recovery passphrase.", "error");
        return;
      }

      const manager = buildMasterKeyManager();
      let masterKey;
      try {
        masterKey = await manager.ensureInitialized(); // prompts for recovery passphrase, unwraps the blob
      } catch (err) {
        // Distinguish "no backup enrolled" from a wrong passphrase via the message.
        ctx.ui.notify(`Reconnect failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        manager.zeroize();
        return;
      }

      if (!backend) {
        ctx.ui.notify("Vault unlocked for this session, but the keyring addon isn't available, so the key can't be persisted. Rebuild it (see /engineering-doctor), then re-run /secret-reconnect.", "warning");
        manager.zeroize();
        return;
      }
      try {
        backend.set(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER, masterKey.toString("hex"));
        ctx.ui.notify("Reconnected — master key restored to the OS keychain. Future sessions won't prompt for the passphrase.", "info");
      } catch (err) {
        ctx.ui.notify(`Recovered for this session, but writing to the keychain failed (${err instanceof Error ? err.message : String(err)}). Unlock the keychain and retry.`, "warning");
      } finally {
        manager.zeroize();
      }
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/secret-reconnect.ts
git commit -m "feat(secrets): /secret-reconnect diagnose + repair command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Register commands + startup nag (`index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

Next to the other `registerSecret*` imports (around line 71-77):

```typescript
import { registerSecretSetupRecoveryCommand } from "./commands/secret-setup-recovery.js";
import { registerSecretReconnectCommand } from "./commands/secret-reconnect.js";
```

- [ ] **Step 2: Register the commands**

Find where the existing `registerSecret*Command(pi)` calls are made (search `registerSecretScrubCommand(`), and add alongside them:

```typescript
  registerSecretSetupRecoveryCommand(pi);
  registerSecretReconnectCommand(pi);
```

- [ ] **Step 3: Add the startup nag in `getVault`**

In the controller `getVault()` (around line 717-724), after `v.init();` and before `cachedVault = v;`, insert:

```typescript
    // Nag: a keychain-only vault with no recovery backup is one keychain loss
    // away from being unrecoverable. Warn when we unlocked via the keychain and
    // no passphrase backup is enrolled. We nag (rather than launching an
    // interactive prompt here) because getVault is lazy and can be triggered by
    // a background secret-store mid-run — blocking it on a prompt would stall the
    // run. New vaults get a stronger call-to-action than returning ones.
    if (
      (masterMgr.unlockSource === "keychain" || masterMgr.unlockSource === "first-run-keychain") &&
      !v.hasRecoveryBackup()
    ) {
      const firstRun = masterMgr.unlockSource === "first-run-keychain";
      console.warn(
        firstRun
          ? "[pi-engineering] New vault created. Set a recovery passphrase NOW with /secret-setup-recovery — without it, losing this machine's keychain means losing every stored secret."
          : "[pi-engineering] No vault recovery passphrase enrolled — if this machine's keychain is lost you cannot recover stored secrets. Run /secret-setup-recovery.",
      );
    }
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: no errors; build succeeds.

- [ ] **Step 5: Verify the commands are in the bundle**

Run: `grep -c "secret-reconnect" dist/index.js`
Expected: ≥ 1.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(secrets): register recovery commands + nag keychain-only vaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Doctor vault/recovery checks (`doctor.ts`)

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Extend the `CheckResult` type + render for `warn`**

In `src/commands/doctor.ts`, change the type (line 8):

```typescript
type CheckResult = { name: string; ok: boolean; message: string; severity?: "warn" };
```

Change the render map (line ~160) and the failure count (line ~155) so `warn` shows ⚠ and is not counted as a hard issue:

```typescript
      const passed = checks.filter(c => c.ok && c.severity !== "warn").length;
      const warned = checks.filter(c => c.severity === "warn").length;
      const failed = checks.filter(c => !c.ok && c.severity !== "warn").length;

      const output = [
        `pi-engineering doctor — ${passed} passed, ${warned} warnings, ${failed} issues`,
        "",
        ...checks.map(c => `${c.severity === "warn" ? "⚠" : c.ok ? "✓" : "✗"} ${c.name}: ${c.message}`),
        "",
        failed > 0
          ? "Run 'pnpm install:extension' to fix missing files."
          : "All checks passed.",
      ].join("\n");
```

- [ ] **Step 2: Add the vault/recovery check group**

Add imports at the top of `doctor.ts`:

```typescript
import { existsSync } from "fs";
import { diagnoseKeyring, createKeyringBackend, KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER } from "../secrets/Keyring.js";
import { Vault } from "../secrets/Vault.js";
```

Insert this block just before `const passed = checks.filter(...)` (line ~154):

```typescript
      // --- Vault & recovery checks ---
      const VAULT_DB = join(home, ".pi", "engineering-team", "secrets.db");
      const diag = diagnoseKeyring();
      if (diag.status === "load-failed") {
        checks.push({ name: "Keyring addon", ok: false, message: `Failed to load (${diag.detail ?? "ABI mismatch"}). Rebuild: pnpm run engineering:install` });
      } else if (diag.status === "locked") {
        checks.push({ name: "Keyring addon", ok: true, severity: "warn", message: "Keychain locked/denied — unlock your login keychain" });
      } else if (diag.status === "ok") {
        checks.push({ name: "Keyring addon", ok: true, message: "Loads OK" });
      } else {
        checks.push({ name: "Keyring addon", ok: true, severity: "warn", message: `Unavailable (${diag.detail ?? "unknown"})` });
      }

      if (existsSync(VAULT_DB)) {
        const backend = createKeyringBackend();
        const hasKeychainKey = backend?.get(KEYRING_SERVICE, KEYRING_ACCOUNT_MASTER).kind === "value";
        if (!hasKeychainKey && diag.status === "ok") {
          checks.push({ name: "Keychain master key", ok: true, severity: "warn", message: "Vault exists but no key in keychain — run /secret-reconnect" });
        }
        let vault: Vault | undefined;
        try {
          vault = new Vault({ dbPath: VAULT_DB, masterKey: Buffer.alloc(32) });
          vault.init();
          const enrolled = vault.hasRecoveryBackup();
          checks.push({
            name: "Vault recovery backup",
            ok: true,
            severity: enrolled ? undefined : "warn",
            message: enrolled ? "Recovery passphrase enrolled" : "Not enrolled — run /secret-setup-recovery",
          });
        } catch (err) {
          checks.push({ name: "Vault openable", ok: false, message: `Cannot open ${VAULT_DB}: ${err instanceof Error ? err.message : String(err)}` });
        } finally {
          vault?.close();
        }
      }
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "feat(doctor): read-only vault/keyring/recovery health checks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Keyring addon smoke-test in `install.sh`

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Add the smoke-test after the keyring copy**

In `scripts/install.sh`, locate the keyring copy block (the `if [ -n "$KEYRING_NODE" ]; then ... cp ... "$EXTENSION_DIR/$(basename "$KEYRING_NODE")" ...` section). Immediately after the successful `cp` + echo inside that `if`, add:

```bash
  # Smoke-test the keyring addon under THIS Node (mirrors the better_sqlite3
  # check). Warning, not hard-fail: the core workflows run without the keyring —
  # only /secret-* degrades. A mismatch here is the Mode-1 ABI failure that
  # /secret-reconnect and /engineering-doctor diagnose.
  INSTALLED_KEYRING="$EXTENSION_DIR/$(basename "$KEYRING_NODE")"
  if NAPI_RS_NATIVE_LIBRARY_PATH="$INSTALLED_KEYRING" node -e "const {Entry}=require('@napi-rs/keyring'); try{new Entry('pi-engineering','__install_probe__').getPassword()}catch(e){if(!/not.*found|no such|does not exist/i.test(e.message))throw e}" >/dev/null 2>&1; then
    echo "Verified native:     keyring addon loads under $(node --version) (ABI $(node -p process.versions.modules))"
  else
    echo "WARNING: keyring addon failed to load under $(node --version) — /secret-* will degrade." >&2
    echo "         Rebuild against the Node that runs pi: nvm use 22 && pnpm rebuild && pnpm run engineering:install" >&2
  fi
```

Note: this `node -e` requires `@napi-rs/keyring` resolvable from the repo `node_modules` (true during `pnpm engineering:install`), and points the loader at the copied binary via `NAPI_RS_NATIVE_LIBRARY_PATH` — the same hook `Keyring.ts` uses.

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n scripts/install.sh`
Expected: no output (valid syntax).

- [ ] **Step 3: Exercise the probe snippet in isolation (success path)**

Run:
```bash
KN=$(find node_modules/@napi-rs node_modules/.pnpm -name 'keyring.*.node' 2>/dev/null | head -1)
NAPI_RS_NATIVE_LIBRARY_PATH="$KN" node -e "const {Entry}=require('@napi-rs/keyring'); try{new Entry('pi-engineering','__install_probe__').getPassword()}catch(e){if(!/not.*found|no such|does not exist/i.test(e.message))throw e} console.log('keyring probe ok')"
```
Expected: prints `keyring probe ok` (or a thrown ABI error if the local addon is mismatched — which itself validates the WARNING path).

- [ ] **Step 4: Commit**

```bash
git add scripts/install.sh
git commit -m "build(install): smoke-test keyring addon load (Mode-1 detection)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all pass (the pre-change baseline on this branch is 1332 passing; expect 1332 + the new recovery tests, 0 failures).

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: `Build success`; `dist/index.js` regenerated.

- [ ] **Step 4: Confirm new commands shipped in the bundle**

Run: `grep -c -e "secret-reconnect" -e "secret-setup-recovery" dist/index.js`
Expected: ≥ 2.

- [ ] **Step 5: Final commit (if anything outstanding)**

```bash
git status --short
# Only files from this plan should be listed as committed; unrelated changes stay unstaged.
```

---

## Notes for the implementer

- **Crypto reuse:** the master key is wrapped as its hex string through the existing `encrypt`/`decrypt`; do not introduce a new cipher.
- **`vault_meta` is plaintext** — that's intentional and required: it lets `readRecoveryBlobFromVault` open the DB with a throwaway key to read the wrapped (passphrase-protected) blob before the real key is known.
- **Re-store is deferred:** `ensureInitialized` must NOT write to the keychain during recovery. Only `/secret-reconnect` calls `backend.set`. Task 5's test asserts `emptyBackend.store.size === 0`.
- **Don't touch unrelated working-tree changes** on this branch; stage only the files each task names.
- **Date.now() is allowed** in this source (the no-`Date.now()` rule applies to Workflow scripts, not extension code).

## Deviation from spec (flag for the user)

The spec's enrollment decision was "auto-prompt new + nag existing." This plan implements a **nag for both** (with a stronger first-run message) rather than a literal interactive auto-prompt for new vaults. Rationale: the only central unlock point is the lazy `getVault`, which can be triggered by a *background* secret-store during an agent run; launching a blocking passphrase prompt there would stall the run. A true one-shot auto-prompt would require threading enrollment into each interactive write command (`/secret-set`, `/secret-import`) and exposing `unlockSource` through `loadVaultForCommand` — more surface for marginal benefit over a prominent first-run nag plus the explicit `/secret-setup-recovery` command. If the user prefers the literal auto-prompt, that's a follow-up: add a post-success enrollment offer to `/secret-set` guarded by `manager.unlockSource === "first-run-keychain"`.
