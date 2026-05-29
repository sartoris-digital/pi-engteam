// src/secrets/Vault.ts
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt } from "./Crypto.js";

// When this module is loaded from the bundled extension at
// ~/.pi/agent/extensions/pi-engineering.js, there is no node_modules
// tree, so better-sqlite3 cannot resolve its native addon via `bindings`.
// install.sh / postinstall.mjs copies the compiled binary alongside the
// bundle; we pass its absolute path through better-sqlite3's official
// `nativeBinding` option, which short-circuits the `require('bindings')`
// lookup at lib/database.js:47.
function resolveSideloadedSqliteBinding(): string | undefined {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidate = join(moduleDir, "better_sqlite3.node");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

type SecretRow = {
  name: string;
  value_enc: Buffer;
  iv: Buffer;
  tag: Buffer;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  notes: string | null;
};

export const RECOVERY_KDF = "scrypt-N32768-r8-p1";

export type RecoveryBlob = {
  salt: Buffer;
  wrap: Buffer;
  iv: Buffer;
  tag: Buffer;
  kdf: string;
  enrolledAt: number;
};

export class Vault {
  private db: Database.Database;
  private masterKey: Buffer;

  constructor(opts: { dbPath: string; masterKey: Buffer; nativeBinding?: string }) {
    const nativeBinding = opts.nativeBinding ?? resolveSideloadedSqliteBinding();
    this.db = nativeBinding
      ? new Database(opts.dbPath, { nativeBinding })
      : new Database(opts.dbPath);
    this.masterKey = opts.masterKey;
  }

  init(): void {
    // WAL mode allows controller + subprocess concurrent reads
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        name         TEXT PRIMARY KEY,
        value_enc    BLOB NOT NULL,
        iv           BLOB NOT NULL,
        tag          BLOB NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count    INTEGER NOT NULL DEFAULT 0,
        notes        TEXT
      );
      CREATE TABLE IF NOT EXISTS vault_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const existing = this.db
      .prepare("SELECT value FROM vault_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!existing) {
      this.db
        .prepare("INSERT INTO vault_meta (key, value) VALUES ('schema_version', '1')")
        .run();
    }
  }

  set(name: string, value: string, notes?: string): void {
    const { ciphertext, iv, tag } = encrypt(value, this.masterKey);
    const now = Date.now();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO secrets (name, value_enc, iv, tag, created_at, last_used_at, use_count, notes)
        VALUES (?, ?, ?, ?, ?, NULL, 0, ?)
      `)
      .run(name, ciphertext, iv, tag, now, notes ?? null);
  }

  get(name: string): string | null {
    const row = this.db
      .prepare("SELECT * FROM secrets WHERE name = ?")
      .get(name) as SecretRow | undefined;
    if (!row) return null;
    const plaintext = decrypt(row.value_enc, this.masterKey, row.iv, row.tag);
    this.db
      .prepare("UPDATE secrets SET use_count = use_count + 1, last_used_at = ? WHERE name = ?")
      .run(Date.now(), name);
    return plaintext;
  }

  list(): Array<{
    name: string;
    notes: string | null;
    created_at: number;
    last_used_at: number | null;
    use_count: number;
  }> {
    return this.db
      .prepare("SELECT name, notes, created_at, last_used_at, use_count FROM secrets ORDER BY name")
      .all() as Array<{
        name: string;
        notes: string | null;
        created_at: number;
        last_used_at: number | null;
        use_count: number;
      }>;
  }

  remove(name: string): boolean {
    const result = this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
    return result.changes > 0;
  }

  // Side-effect-free check that the master key can decrypt at least one row.
  // Used by passphrase recovery — does NOT touch use_count or last_used_at.
  // Empty vault returns true (no validation possible). All-rows-fail returns false.
  verifyDecryptable(): boolean {
    const rows = this.db
      .prepare("SELECT value_enc, iv, tag FROM secrets")
      .all() as Array<{ value_enc: Buffer; iv: Buffer; tag: Buffer }>;
    if (rows.length === 0) return true;
    for (const row of rows) {
      try {
        decrypt(row.value_enc, this.masterKey, row.iv, row.tag);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  private getMeta(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM vault_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  hasRecoveryBackup(): boolean {
    // Require the full set the reader needs, so a `true` here guarantees
    // readRecoveryBlob() returns a blob rather than throwing on a partial one.
    const required = ["recovery_salt", "recovery_wrap", "recovery_iv", "recovery_tag", "recovery_kdf"];
    return required.every((k) => this.getMeta(k) !== undefined);
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

  close(): void {
    this.db.close();
  }
}
